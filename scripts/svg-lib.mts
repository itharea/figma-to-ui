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

// Extract the geometry of the node at `guidKey`, following symbolData.symbolID into
// masters exactly like the legacy export-svg walk. Pure: reads only from `index`.
export function extractGeometry(index: SvgIndex, guidKey: string): SvgGeometry {
  const { msg, byKey, children } = index;
  const blobs = msg.blobs;
  const out: SvgPath[] = [];

  const emit = (n: any, mat: Mat) => {
    const visiblePaints = (ps: any[]) => (ps ?? []).filter((p) => p.visible !== false && p.type === "SOLID");
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
  };

  const walk = (k: string, mat: Mat, isRoot: boolean) => {
    const n = byKey.get(k);
    if (!n || n.visible === false) return;
    const m = isRoot ? I : mul(mat, nodeMat(n)); // root transform drops → becomes the viewBox origin
    if (n.type !== "FRAME" && n.type !== "SECTION") emit(n, m);
    if (n.symbolData?.symbolID) {
      for (const c of children.get(key(n.symbolData.symbolID)) ?? []) walk(key(c.guid), m, false);
    }
    for (const c of children.get(k) ?? []) walk(key(c.guid), m, false);
  };

  const root = byKey.get(guidKey);
  if (!root) throw new Error("svg-lib: target not found: " + guidKey);
  walk(guidKey, I, true);

  const width = Math.ceil(root.size?.x ?? 0);
  const height = Math.ceil(root.size?.y ?? 0);
  const fills: string[] = [];
  for (const p of out) if (!fills.includes(p.fill)) fills.push(p.fill);
  const geomHash = createHash("sha256")
    .update(out.map((p) => `${p.d}|${p.fillRule}|${p.transform}|${p.opacity}`).join(";"))
    .digest("hex")
    .slice(0, 16);

  return { width, height, viewBox: `0 0 ${width} ${height}`, paths: out, fills, geomHash };
}

// Serialize a single <path> (or <Path> for react-native-svg). React-style camelCase
// attrs (fillRule/fillOpacity) so the same string drops into a .tsx component; the raw
// SVG file path (export-svg CLI) lower-cases them via `dom: true`.
function pathAttrs(p: SvgPath, fill: string | null, dom: boolean): string {
  const rule = dom ? "fill-rule" : "fillRule";
  const fop = dom ? "fill-opacity" : "fillOpacity";
  const a = [`d="${p.d}"`];
  if (fill !== null) a.push(`fill="${fill}"`);
  if (p.opacity < 1) a.push(dom ? `${fop}="${p.opacity.toFixed(3)}"` : `${fop}={${p.opacity.toFixed(3)}}`);
  a.push(`${rule}="${p.fillRule}"`);
  a.push(`transform="${p.transform}"`);
  return a.join(" ");
}

// Raw <svg> string for the export-svg CLI / standalone files.
//   recolor:"preserve"     → faithful per-path fills (duotone/multi); keeps opacities
//   recolor:"currentColor" → every path fill := "currentColor" (mono, recolorable)
export function toSvgString(geo: SvgGeometry, opts?: { recolor?: "preserve" | "currentColor" }): string {
  const cc = opts?.recolor === "currentColor";
  const body = geo.paths.map((p) => `<path ${pathAttrs(p, cc ? "currentColor" : p.fill, true)}/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${geo.viewBox}" width="${geo.width}" height="${geo.height}">\n${body}\n</svg>\n`;
}

// Generate an owned, recolorable icon component (the RoastSquare pattern).
//   mono ⇒ fill is driven by the caller's `color` prop (web `currentColor`, RN `fill={color}`)
//   multi/duotone ⇒ faithful baked per-path fills; `color` is ignored
// Web emits an inline <svg> (required for currentColor recolouring — <img src> can't recolor).
// RN emits react-native-svg (a peer dependency of the consuming app).
export function emitIconComponent(name: string, geo: SvgGeometry, opts: { web: boolean; mono: boolean }): string {
  const { web, mono } = opts;
  if (web) {
    const paths = geo.paths
      .map((p) => `      <path ${pathAttrs(p, mono ? null : p.fill, false)} />`)
      .join("\n");
    const svgFill = mono ? ` fill="currentColor"` : "";
    const svgStyle = mono ? ` style={{ color, ...style }}` : ` style={style}`;
    const props = mono
      ? `{ size = ${geo.width}, color = 'currentColor', style }: { size?: number; color?: string; style?: React.CSSProperties }`
      : `{ size = ${geo.width}, style }: { size?: number; style?: React.CSSProperties }`;
    return `import * as React from 'react';\n\n// AUTO-GENERATED owned icon (figma-to-ui codegen). ${mono ? "Recolour via the `color` prop." : "Multi-fill — colours baked from the design."}\nexport function ${name}(${props}) {\n  return (\n    <svg width={size} height={size} viewBox="${geo.viewBox}"${svgFill}${svgStyle} aria-hidden="true">\n${paths}\n    </svg>\n  );\n}\n`;
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
  return `import * as React from 'react';\nimport Svg, { Path } from 'react-native-svg'; // peer dependency\n\n// AUTO-GENERATED owned icon (figma-to-ui codegen). ${mono ? "Recolour via the `color` prop." : "Multi-fill — colours baked from the design."}\nexport function ${name}(${props}) {\n  return (\n    <Svg width={size} height={size} viewBox="${geo.viewBox}">\n${paths}\n    </Svg>\n  );\n}\n`;
}
