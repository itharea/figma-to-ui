// svg-lib.mts — pure vector-geometry extraction shared by export-svg.mts (the CLI)
// and codegen.mts (internal icon export). No side effects, no process/argv/fs.
//
// A .fig vector stores its outline in `fillGeometry`/`strokeGeometry` blobs:
//   blob byte stream = [uint8 opcode][float32 LE args…]
//   0=Z, 1=M x y, 2=L x y, 3=Q cx cy x y, 4=C c1x c1y c2x c2y x y
// We decode those to SVG path data, follow component instances into their masters
// (so an icon that wraps an instance still exports), and compose node transforms.
// Per-instance fill OVERRIDES are not applied here (master paints only) — the
// consuming component recolors via a `color` prop / `currentColor` (mono icons),
// which carries the IR's override-aware colour. Geometry is identical regardless.
import { createHash } from "crypto";
import { colorStr, type Mat, I, mul, nodeMat, key } from "./lib.mts";

export type SvgPath = {
  d: string; // decoded path data
  fill: string; // master paint hex (colorStr) — baked, mode-independent
  fillRule: "nonzero" | "evenodd";
  opacity: number; // paint.opacity * node.opacity (1 = fully opaque)
  transform: string; // "matrix(a b c d e f)"
};

export type SvgGeometry = {
  width: number;
  height: number;
  viewBox: string; // "0 0 W H"
  paths: SvgPath[];
  fills: string[]; // distinct master hexes, order-preserved (mono ⇒ length 1)
  geomHash: string; // sha256 of shape (d+rule+transform+opacity) — COLOUR-INDEPENDENT dedup key
};

type SvgIndex = { msg: any; byKey: Map<string, any>; children: Map<string, any[]> };

function decodePath(blobs: any[], blobIdx: number): string {
  const buf = Buffer.from(blobs[blobIdx].bytes);
  let off = 0;
  const parts: string[] = [];
  const rf = () => {
    const v = buf.readFloatLE(off);
    off += 4;
    return +v.toFixed(2);
  };
  while (off < buf.length) {
    const cmd = buf.readUInt8(off);
    off += 1;
    if (cmd === 0) parts.push("Z");
    else if (cmd === 1) parts.push(`M${rf()} ${rf()}`);
    else if (cmd === 2) parts.push(`L${rf()} ${rf()}`);
    else if (cmd === 3) parts.push(`Q${rf()} ${rf()} ${rf()} ${rf()}`);
    else if (cmd === 4) parts.push(`C${rf()} ${rf()} ${rf()} ${rf()} ${rf()} ${rf()}`);
    else throw new Error(`unknown cmd ${cmd} at ${off - 1} blob ${blobIdx}`);
  }
  return parts.join("");
}

// Decode a Figma editable VECTOR NETWORK blob → an SVG path `d` + winding rule.
// Some vectors (notably stroke-format glyphs) carry no baked fillGeometry/strokeGeometry —
// only this network. Verified byte-for-byte against the commandsBlob of a node that has both.
// Layout (all LE): [u32 nVerts][u32 nSegs][u32 nRegions]
//   vertices[nVerts]  : { u32 flag, f32 x, f32 y }                                    (12B)
//   segments[nSegs]   : { u32 style, u32 start, f32 tsx, f32 tsy, u32 end, f32 tex, f32 tey } (28B)
//   regions[nRegions] : { u32 windingRule, u32 nLoops, (u32 loopLen, u32 segIdx[loopLen])* }
// A segment's cubic control points are control1 = vert[start]+tStart, control2 = vert[end]+tEnd.
// Coords live in normalizedSize space → caller passes sx/sy = size/normalizedSize to map to the box.
function decodeVectorNetwork(
  blobs: any[],
  blobIdx: number,
  sx = 1,
  sy = 1,
): { d: string; fillRule: "nonzero" | "evenodd" } | null {
  const raw = blobs[blobIdx]?.bytes;
  if (!raw) return null;
  const buf = Buffer.from(raw);
  if (buf.length < 12) return null;
  const u32 = (o: number) => buf.readUInt32LE(o);
  const f32 = (o: number) => buf.readFloatLE(o);
  const nV = u32(0),
    nS = u32(4),
    nR = u32(8);
  const vOff = 12,
    sOff = 12 + nV * 12,
    rOff = 12 + nV * 12 + nS * 28;
  if (rOff > buf.length) return null;
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < nV; i++)
    verts.push({ x: f32(vOff + i * 12 + 4) * sx, y: f32(vOff + i * 12 + 8) * sy });
  const segs: { start: number; end: number; tsx: number; tsy: number; tex: number; tey: number }[] =
    [];
  for (let i = 0; i < nS; i++) {
    const o = sOff + i * 28;
    segs.push({
      start: u32(o + 4),
      tsx: f32(o + 8) * sx,
      tsy: f32(o + 12) * sy,
      end: u32(o + 16),
      tex: f32(o + 20) * sx,
      tey: f32(o + 24) * sy,
    });
  }
  // Loops + winding from the region table when present; else one loop per connected chain.
  let windingRule: "nonzero" | "evenodd" = "nonzero";
  const loops: number[][] = [];
  if (nR > 0 && rOff + 8 <= buf.length) {
    const wr = u32(rOff); // observed: 1 ↔ NONZERO (matches the fill node's rule)
    windingRule = wr === 0 ? "evenodd" : "nonzero";
    let p = rOff + 4;
    const nLoops = u32(p);
    p += 4;
    for (let l = 0; l < nLoops && p + 4 <= buf.length; l++) {
      const cnt = u32(p);
      p += 4;
      const idxs: number[] = [];
      for (let k = 0; k < cnt && p + 4 <= buf.length; k++) {
        idxs.push(u32(p));
        p += 4;
      }
      loops.push(idxs);
    }
  }
  if (!loops.length) {
    // fallback: chain segments by shared vertices
    const used = new Set<number>();
    for (let i = 0; i < nS; i++) {
      if (used.has(i)) continue;
      const loop = [i];
      used.add(i);
      let cur = segs[i].end;
      const startV = segs[i].start;
      while (cur !== startV) {
        let nx = segs.findIndex((s, j) => !used.has(j) && (s.start === cur || s.end === cur));
        if (nx < 0) break;
        used.add(nx);
        loop.push(nx);
        cur = segs[nx].start === cur ? segs[nx].end : segs[nx].start;
      }
      loops.push(loop);
    }
  }
  const n2 = (v: number) => +v.toFixed(2);
  const parts: string[] = [];
  for (const loop of loops) {
    if (!loop.length) continue;
    let cur = segs[loop[0]].start;
    parts.push(`M${n2(verts[cur].x)} ${n2(verts[cur].y)}`);
    for (const si of loop) {
      const s = segs[si];
      const fwd = s.start === cur;
      const a = cur,
        b = fwd ? s.end : s.start;
      const ts = fwd ? { x: s.tsx, y: s.tsy } : { x: s.tex, y: s.tey };
      const te = fwd ? { x: s.tex, y: s.tey } : { x: s.tsx, y: s.tsy };
      const c1x = verts[a].x + ts.x,
        c1y = verts[a].y + ts.y,
        c2x = verts[b].x + te.x,
        c2y = verts[b].y + te.y;
      parts.push(
        `C${n2(c1x)} ${n2(c1y)} ${n2(c2x)} ${n2(c2y)} ${n2(verts[b].x)} ${n2(verts[b].y)}`,
      );
      cur = b;
    }
    parts.push("Z");
  }
  return parts.length ? { d: parts.join(""), fillRule: windingRule } : null;
}

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

// Exact VISUAL bounding box of an SVG path `d` AFTER applying its affine `transform`. Includes
// bezier extrema (not just on-curve points or control points), so the box matches what the
// browser actually paints — letting us build a viewBox the path is truly centered in.
function pathVisualBBox(d: string, mat: Mat): BBox | null {
  const tx = (x: number, y: number): [number, number] => [
    mat[0] * x + mat[1] * y + mat[2],
    mat[3] * x + mat[4] * y + mat[5],
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const inc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  // Candidate values along ONE axis for a cubic p0→p3 (endpoints + in-range derivative roots).
  const cubicAxis = (p0: number, p1: number, p2: number, p3: number): number[] => {
    const vals = [p0, p3];
    const A = -p0 + 3 * p1 - 3 * p2 + p3,
      B = 2 * (p0 - 2 * p1 + p2),
      C = -p0 + p1;
    const roots: number[] = [];
    if (Math.abs(A) < 1e-9) {
      if (Math.abs(B) > 1e-9) roots.push(-C / B);
    } else {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        roots.push((-B + s) / (2 * A), (-B - s) / (2 * A));
      }
    }
    for (const t of roots)
      if (t > 0 && t < 1) {
        const u = 1 - t;
        vals.push(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
      }
    return vals;
  };
  const quadAxis = (p0: number, p1: number, p2: number): number[] => {
    const vals = [p0, p2];
    const den = p0 - 2 * p1 + p2;
    if (Math.abs(den) > 1e-9) {
      const t = (p0 - p1) / den;
      if (t > 0 && t < 1) vals.push((1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2);
    }
    return vals;
  };
  const toks = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let i = 0,
    cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    const c = toks[i++];
    if (c === "M") {
      cx = num();
      cy = num();
      sx = cx;
      sy = cy;
      inc(...tx(cx, cy));
    } else if (c === "L") {
      cx = num();
      cy = num();
      inc(...tx(cx, cy));
    } else if (c === "C") {
      const a1 = num(),
        b1 = num(),
        a2 = num(),
        b2 = num(),
        x = num(),
        y = num();
      const [P0x, P0y] = tx(cx, cy),
        [P1x, P1y] = tx(a1, b1),
        [P2x, P2y] = tx(a2, b2),
        [P3x, P3y] = tx(x, y);
      for (const v of cubicAxis(P0x, P1x, P2x, P3x)) {
        if (v < minX) minX = v;
        if (v > maxX) maxX = v;
      }
      for (const v of cubicAxis(P0y, P1y, P2y, P3y)) {
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
      cx = x;
      cy = y;
    } else if (c === "Q") {
      const a1 = num(),
        b1 = num(),
        x = num(),
        y = num();
      const [P0x, P0y] = tx(cx, cy),
        [P1x, P1y] = tx(a1, b1),
        [P2x, P2y] = tx(x, y);
      for (const v of quadAxis(P0x, P1x, P2x)) {
        if (v < minX) minX = v;
        if (v > maxX) maxX = v;
      }
      for (const v of quadAxis(P0y, P1y, P2y)) {
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
      cx = x;
      cy = y;
    } else if (c === "Z") {
      cx = sx;
      cy = sy;
    }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// Parse a "matrix(a b c d e f)" attribute (SVG order) back into our Mat (a c e b d f).
function parseMatrix(s: string): Mat {
  const m = s.match(/matrix\(([^)]+)\)/);
  const v = m ? m[1].trim().split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
  return [v[0], v[2], v[4], v[1], v[3], v[5]] as unknown as Mat;
}

// Extract the geometry of the node at `guidKey`, following symbolData.symbolID into
// masters exactly like the legacy export-svg walk. Pure: reads only from `index`.
export function extractGeometry(index: SvgIndex, guidKey: string): SvgGeometry {
  const { msg, byKey, children } = index;
  const blobs = msg.blobs;
  const out: SvgPath[] = [];

  const emit = (n: any, mat: Mat) => {
    const visiblePaints = (ps: any[]) =>
      (ps ?? []).filter((p) => p.visible !== false && p.type === "SOLID");
    const transform = `matrix(${mat[0]} ${mat[3]} ${mat[1]} ${mat[4]} ${mat[2]} ${mat[5]})`;
    // strokeGeometry is pre-outlined — render it as a FILL with the stroke paint.
    for (const [geos, paints] of [
      [n.fillGeometry, n.fillPaints],
      [n.strokeGeometry, n.strokePaints],
    ] as const) {
      for (const g of geos ?? []) {
        const ps = visiblePaints(paints);
        if (!ps.length) continue;
        // Multi-fill vectors stack paints on the SAME geometry (document order = paint
        // order). Opacity is per-paint; path data + winding rule are per-geometry.
        const d = decodePath(blobs, g.commandsBlob);
        const fr = g.windingRule === "ODD" ? "evenodd" : "nonzero";
        for (const p of ps) {
          out.push({
            d,
            fill: colorStr(p.color),
            fillRule: fr,
            opacity: (p.opacity ?? 1) * (n.opacity ?? 1),
            transform,
          });
        }
      }
    }
    // Vector-network fallback: a node carrying ONLY an editable vector network (no baked
    // fill/strokeGeometry — e.g. stroke-format glyphs). Decode it, but emit ONLY when a
    // visible solid paint exists; a paintless network node is an invisible structural layer
    // and must stay empty (no spurious geometry).
    if (
      !n.fillGeometry?.length &&
      !n.strokeGeometry?.length &&
      n.vectorData?.vectorNetworkBlob != null
    ) {
      const ps = visiblePaints(visiblePaints(n.fillPaints).length ? n.fillPaints : n.strokePaints);
      if (ps.length) {
        const ns = n.vectorData.normalizedSize;
        const sx = ns?.x && n.size?.x ? n.size.x / ns.x : 1;
        const sy = ns?.y && n.size?.y ? n.size.y / ns.y : 1;
        const vn = decodeVectorNetwork(blobs, n.vectorData.vectorNetworkBlob, sx, sy);
        if (vn)
          for (const p of ps)
            out.push({
              d: vn.d,
              fill: colorStr(p.color),
              fillRule: vn.fillRule,
              opacity: (p.opacity ?? 1) * (n.opacity ?? 1),
              transform,
            });
      }
    }
  };

  // The natural icon frame: the size of the deepest master the geometry is authored in
  // (Figma keeps the glyph's margins inside this frame). Starts at the root's own size.
  const rootNode0 = byKey.get(guidKey);
  let natW = Math.ceil(rootNode0?.size?.x ?? 0),
    natH = Math.ceil(rootNode0?.size?.y ?? 0);

  const walk = (k: string, mat: Mat, isRoot: boolean, frame: { w: number; h: number }) => {
    const n = byKey.get(k);
    if (!n || n.visible === false) return;
    const m = isRoot ? I : mul(mat, nodeMat(n)); // root transform drops → becomes the viewBox origin
    if (n.type !== "FRAME" && n.type !== "SECTION") {
      emit(n, m);
      if (frame.w > natW) natW = frame.w;
      if (frame.h > natH) natH = frame.h;
    }
    if (n.symbolData?.symbolID) {
      const mk = key(n.symbolData.symbolID);
      const master = byKey.get(mk);
      // Descend into the master at the master's OWN coordinate frame (no coordinate scaling —
      // SVG is vector, so we keep the glyph at its authored resolution and let the viewBox→
      // render-size mapping scale it). A 32×32 glyph placed as a 24×24 icon keeps its 32-space
      // geometry; the viewBox becomes 32×32 (margins intact) and the consumer renders at 24.
      const mf =
        master?.size && master.size.x > 0 && master.size.y > 0
          ? { w: Math.ceil(master.size.x), h: Math.ceil(master.size.y) }
          : frame;
      for (const c of children.get(mk) ?? []) walk(key(c.guid), m, false, mf);
    }
    for (const c of children.get(k) ?? []) walk(key(c.guid), m, false, frame);
  };

  const root = byKey.get(guidKey);
  if (!root) throw new Error("svg-lib: target not found: " + guidKey);
  walk(guidKey, I, true, { w: natW, h: natH });

  // viewBox = the icon's NATURAL frame (the master frame the glyph is authored in, margins
  // intact) — this is Figma's exact box, so the export is 1:1 and the consumer just renders
  // at whatever size it uses (SVG scales the vector). We do NOT re-centre or tightly crop, so
  // the glyph keeps its real position/margins. Only expand (never re-centre) if some stroke
  // geometry spills a hair past the frame, so nothing clips. Bezier+transform-aware bounds.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of out) {
    const bb = pathVisualBBox(p.d, parseMatrix(p.transform));
    if (!bb) continue;
    if (bb.minX < minX) minX = bb.minX;
    if (bb.minY < minY) minY = bb.minY;
    if (bb.maxX > maxX) maxX = bb.maxX;
    if (bb.maxY > maxY) maxY = bb.maxY;
  }
  let vx = 0,
    vy = 0,
    vw = natW || 1,
    vh = natH || 1;
  if (isFinite(minX)) {
    vx = Math.min(0, Math.floor(minX));
    vy = Math.min(0, Math.floor(minY));
    vw = Math.max(natW, Math.ceil(maxX)) - vx;
    vh = Math.max(natH, Math.ceil(maxY)) - vy;
  }
  if (vw < 1) vw = 1;
  if (vh < 1) vh = 1;
  const width = vw,
    height = vh;
  const fills: string[] = [];
  for (const p of out) if (!fills.includes(p.fill)) fills.push(p.fill);
  const geomHash = createHash("sha256")
    .update(out.map((p) => `${p.d}|${p.fillRule}|${p.transform}|${p.opacity}`).join(";"))
    .digest("hex")
    .slice(0, 16);

  return { width, height, viewBox: `${vx} ${vy} ${vw} ${vh}`, paths: out, fills, geomHash };
}

// Serialize a single <path> (or <Path> for react-native-svg). React-style camelCase
// attrs (fillRule/fillOpacity) so the same string drops into a .tsx component; the raw
// SVG file path (export-svg CLI) lower-cases them via `dom: true`.
function pathAttrs(p: SvgPath, fill: string | null, dom: boolean): string {
  const rule = dom ? "fill-rule" : "fillRule";
  const fop = dom ? "fill-opacity" : "fillOpacity";
  const a = [`d="${p.d}"`];
  if (fill !== null) a.push(`fill="${fill}"`);
  if (p.opacity < 1)
    a.push(dom ? `${fop}="${p.opacity.toFixed(3)}"` : `${fop}={${p.opacity.toFixed(3)}}`);
  a.push(`${rule}="${p.fillRule}"`);
  a.push(`transform="${p.transform}"`);
  return a.join(" ");
}

// Raw <svg> string for the export-svg CLI / standalone files.
//   recolor:"preserve"     → faithful per-path fills (duotone/multi); keeps opacities
//   recolor:"currentColor" → every path fill := "currentColor" (mono, recolorable)
export function toSvgString(
  geo: SvgGeometry,
  opts?: { recolor?: "preserve" | "currentColor" },
): string {
  const cc = opts?.recolor === "currentColor";
  const body = geo.paths
    .map((p) => `<path ${pathAttrs(p, cc ? "currentColor" : p.fill, true)}/>`)
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${geo.viewBox}" width="${geo.width}" height="${geo.height}">\n${body}\n</svg>\n`;
}

// Generate an owned, recolorable icon component (the RoastSquare pattern).
//   mono ⇒ fill is driven by the caller's `color` prop (web `currentColor`, RN `fill={color}`)
//   multi/duotone ⇒ faithful baked per-path fills; `color` is ignored
// Web emits an inline <svg> (required for currentColor recolouring — <img src> can't recolor).
// RN emits react-native-svg (a peer dependency of the consuming app).
export function emitIconComponent(
  name: string,
  geo: SvgGeometry,
  opts: { web: boolean; mono: boolean },
): string {
  const { web, mono } = opts;
  // Render at the glyph's ASPECT RATIO, not a forced square: a non-square glyph (e.g. a
  // stroke-arrow's 2×24 shaft, or a wide arrowhead) would otherwise be squished into size×size
  // and vanish. `size` drives the width; height follows the viewBox aspect. Square glyphs
  // (aspect 1 — the common case) are unchanged. The composing wrapper still positions it.
  const ar = geo.width > 0 ? geo.height / geo.width : 1;
  const hExpr = Math.abs(ar - 1) < 1e-6 ? "size" : `size * ${+ar.toFixed(5)}`;
  if (web) {
    const paths = geo.paths
      .map((p) => `      <path ${pathAttrs(p, mono ? null : p.fill, false)} />`)
      .join("\n");
    const svgFill = mono ? ` fill="currentColor"` : "";
    const svgStyle = mono ? ` style={{ color, ...style }}` : ` style={style}`;
    const props = mono
      ? `{ size = ${geo.width}, color = 'currentColor', style }: { size?: number; color?: string; style?: React.CSSProperties }`
      : `{ size = ${geo.width}, style }: { size?: number; style?: React.CSSProperties }`;
    return `import * as React from 'react';\n\n// AUTO-GENERATED owned icon (figma-to-ui codegen). ${mono ? "Recolour via the `color` prop." : "Multi-fill — colours baked from the design."}\nexport function ${name}(${props}) {\n  return (\n    <svg width={size} height={${hExpr}} viewBox="${geo.viewBox}"${svgFill}${svgStyle} aria-hidden="true">\n${paths}\n    </svg>\n  );\n}\n`;
  }
  // react-native-svg — each <Path> needs its own fill (no svg-level inheritance).
  const rnPath = (p: SvgPath): string => {
    const a = [`d="${p.d}"`, mono ? `fill={color}` : `fill="${p.fill}"`];
    if (p.opacity < 1) a.push(`fillOpacity={${p.opacity.toFixed(3)}}`);
    a.push(`fillRule="${p.fillRule}"`, `transform="${p.transform}"`);
    return `      <Path ${a.join(" ")} />`;
  };
  const paths = geo.paths.map(rnPath).join("\n");
  const props = mono
    ? `{ size = ${geo.width}, color = '#000' }: { size?: number; color?: string }`
    : `{ size = ${geo.width} }: { size?: number }`;
  return `import * as React from 'react';\nimport Svg, { Path } from 'react-native-svg'; // peer dependency\n\n// AUTO-GENERATED owned icon (figma-to-ui codegen). ${mono ? "Recolour via the `color` prop." : "Multi-fill — colours baked from the design."}\nexport function ${name}(${props}) {\n  return (\n    <Svg width={size} height={${hExpr}} viewBox="${geo.viewBox}">\n${paths}\n    </Svg>\n  );\n}\n`;
}
