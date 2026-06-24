// fidelity-lib.mts — the pure logic behind the elevation guardrail (fidelity.mts).
//
// Two jobs, both deterministic, NO top-level side effects (principle: logic lives
// in *-lib.mts, the CLI is a thin shell — same as reconcile-lib/theme-lib):
//
//   1. CONTRACT  — walk a resolved IR subtree and emit the per-node invariants the
//      ELEVATED component MUST preserve (geometry, typography, color token, layout,
//      borders, the variant→structure tree). This is the on-ethos "truth not pixels"
//      half: the agent diffs its refactor against this list. Fields mirror exactly
//      what codegen.mts emits, so the contract and the scaffold never drift.
//
//   2. IMAGE DIFF — decode two PNGs (Node zlib, no deps), compare on a cell grid,
//      and report an overall drift score + the worst regions, optionally a heatmap.
//      The visual backstop: diff an app screenshot of the elevated component against
//      the render-over-IR reference. Surfaces drift; the agent adjudicates.
import * as zlib from "zlib";
import { disambiguateJustify } from "./reconcile-lib.mts";
import type { IRNode } from "./screens-lib.mts";

// ============================================================================
// 1. CONTRACT
// ============================================================================

export type ContractRecord = {
  depth: number;
  styleKey: string; // n_<id> — the same key codegen.mts uses for this node's style
  id: string;
  guid: string;
  type: string;
  name: string;
  childCount: number;
  invariants: Record<string, string>; // field → must-preserve value (display string)
};

// SAME key codegen.mts derives, so a contract row maps 1:1 to a scaffold style block.
function styleKeyOf(n: IRNode): string {
  return `n_${((n.id || n.guid || "x") as string).replace(/[^A-Za-z0-9]+/g, "_")}`;
}

function colorInvariant(c: any): string | undefined {
  if (!c || !c.hex) return undefined;
  if (c.var) return `${c.hex} (var ${c.var})`; // bound → ground truth, must reference the theme
  if (c.token) return `${c.hex} (token ${c.token})`;
  if (c.match === "none" || (typeof c.match === "string" && c.match.startsWith("nearest")))
    return `${c.hex} [${c.match} — adjudicate]`;
  return c.hex;
}

// One node → the must-preserve invariants. Mirrors codegen.mts nodeStyleBody /
// textStyleBody / flexChildLines field-for-field.
function nodeInvariants(n: IRNode): Record<string, string> {
  const inv: Record<string, string> = {};
  // geometry
  if (n.box) {
    if (n.box.w) inv.w = String(n.box.w);
    if (n.box.h) inv.h = String(n.box.h);
  }
  const s = n.style;
  // background fill (first solid) — a TEXT node's fill IS its text color (emitted as
  // `color` below, mirroring codegen's textStyleBody), so never treat it as a bg.
  const fill = n.type !== "text" ? s?.fills?.find((f: any) => f.type === "solid" && f.hex) : undefined;
  if (fill) {
    const c = colorInvariant({ hex: (fill as any).hex, var: (fill as any).var, match: (fill as any).var ? "bound" : null });
    if (c) inv.bg = c;
  }
  const imgFill = s?.fills?.find((f: any) => f.type === "image" && (f as any).imageHash);
  if (imgFill) inv.image = `${String((imgFill as any).imageHash).slice(0, 12)}… (export + wire src)`;
  if (s?.cornerRadius !== undefined)
    inv.radius = typeof s.cornerRadius === "number"
      ? String(s.cornerRadius)
      : `${s.cornerRadius.tl}/${s.cornerRadius.tr}/${s.cornerRadius.br}/${s.cornerRadius.bl}`;
  if (s?.strokes?.length) {
    const st: any = s.strokes[0];
    const c = colorInvariant({ hex: st.hex, var: st.var, match: st.var ? "bound" : null });
    const widths = s.borderWidths
      ? `${s.borderWidths.top}/${s.borderWidths.right}/${s.borderWidths.bottom}/${s.borderWidths.left}`
      : String(st.weight);
    inv.border = `${widths} ${c ?? ""}${st.dash?.length ? " dashed" : ""} (${st.align})`.trim();
  }
  if (s?.opacity !== undefined) inv.opacity = String(s.opacity);
  if (s?.effects?.length) {
    const e: any = s.effects[0];
    inv.effect = `${e.type} ${e.offsetX},${e.offsetY} r${e.radius}${e.spread ? ` s${e.spread}` : ""} ${e.hex ?? "#000"}${s.effects.length > 1 ? ` (+${s.effects.length - 1})` : ""}`;
  }
  // auto-layout container
  const l = n.layout;
  if (l) {
    const pads = [l.paddingTop, l.paddingRight, l.paddingBottom, l.paddingLeft];
    const j = disambiguateJustify(l as any, n.box as any, (n.children as any) ?? []);
    inv.layout =
      `${l.mode}` +
      (l.gap !== undefined ? ` gap${l.gap}` : "") +
      (j ? ` justify:${j}` : "") +
      (l.align ? ` align:${l.align}` : "") +
      (pads.some((p) => p !== undefined) ? ` pad[${pads.map((p) => p ?? 0).join(",")}]` : "") +
      (l.wrap ? " wrap" : "");
  }
  // as a flex child
  const child: string[] = [];
  if (n.grow) child.push(`grow${n.grow}`);
  if (n.alignSelf) child.push(`self:${n.alignSelf}`);
  if (n.minW) child.push(`minW${n.minW}`);
  if (n.minH) child.push(`minH${n.minH}`);
  if (n.aspectRatio) child.push(`ar${n.aspectRatio}`);
  if ((n as any).positioning === "absolute") child.push("absolute");
  if (child.length) inv.child = child.join(" ");
  // typography
  const f = n.font;
  if (f) {
    const v = f.vars;
    const parts: string[] = [];
    if (f.styleName) parts.push(`"${f.styleName}"`);
    if (f.size != null) parts.push(`size${f.size}${v?.size ? `(var ${v.size})` : f.sizeToken ? `(token ${f.sizeToken})` : ""}`);
    if (f.lineHeightPx != null) parts.push(`lh${f.lineHeightPx}${v?.lineHeight ? `(var ${v.lineHeight})` : ""}`);
    if (f.letterSpacingPx || v?.letterSpacing) parts.push(`ls${f.letterSpacingPx}${v?.letterSpacing ? `(var ${v.letterSpacing})` : ""}`);
    const fam = f.appFamily ?? f.family;
    if (v?.family) parts.push(`fam:${f.family}(var ${v.family})`);
    else if (fam) parts.push(`fam:${fam}`);
    if (f.weight) parts.push(`w:${f.weight}${v?.weight ? `(var ${v.weight})` : ""}`);
    if (parts.length) inv.font = parts.join(" ");
    if (f.conflicts?.length)
      inv.conflicts = f.conflicts.map((c: any) => `${c.field} ${c.declared}→~${c.chosen}`).join("; ");
  }
  if (n.type === "text") {
    const c = colorInvariant(n.color);
    if (c) inv.color = c;
    if (n.text?.case) inv.case = n.text.case;
    if (n.text?.align) inv.align = n.text.align;
    if (n.text?.value != null) inv.text = JSON.stringify(String(n.text.value).slice(0, 48));
    if ((n.text as any)?.placeholder) inv.placeholder = `true — confirm copy`;
  }
  return inv;
}

export type BuildContractOpts = { skipHidden?: boolean };

// Walk a resolved IR subtree → the ordered per-node contract. Depth + childCount +
// order capture the variant→structure tree (the structural invariant).
export function buildContract(root: IRNode, opts: BuildContractOpts = {}): ContractRecord[] {
  const out: ContractRecord[] = [];
  (function walk(n: IRNode, depth: number) {
    if (!n) return;
    if (opts.skipHidden && (n as any).visible === false) return;
    const kids = (n.children ?? []).filter((c: any) => !(opts.skipHidden && c.visible === false));
    out.push({
      depth,
      styleKey: styleKeyOf(n),
      id: (n.id as string) ?? "",
      guid: (n.guid as string) ?? "",
      type: n.type,
      name: n.name ?? "",
      childCount: kids.length,
      invariants: nodeInvariants(n),
    });
    for (const c of kids) walk(c as IRNode, depth + 1);
  })(root, 0);
  return out;
}

// Render the contract as an indented, copy-pasteable checklist (one node per line).
export function formatContract(records: ContractRecord[], header?: string): string {
  const lines: string[] = [];
  if (header) {
    lines.push(`# fidelity contract — ${header}`);
    lines.push(`# ${records.length} node(s). Each line is an invariant the elevated component MUST preserve.`);
    lines.push(`# Indent = tree depth (the variant→structure shape); styleKey maps to the scaffold's style block.`);
    lines.push("");
  }
  for (const r of records) {
    const pad = "  ".repeat(r.depth);
    const head = `${pad}${r.type} "${r.name}" [${r.styleKey}]${r.childCount ? ` (${r.childCount} child)` : ""}`;
    const inv = Object.entries(r.invariants).map(([k, v]) => `${k}=${v}`);
    lines.push(inv.length ? `${head}  ·  ${inv.join("  ")}` : head);
  }
  return lines.join("\n");
}

// ============================================================================
// 2. IMAGE DIFF (PNG, zero deps via Node zlib)
// ============================================================================

export type RGBAImage = { width: number; height: number; rgba: Uint8Array };

// Minimal PNG decoder: 8-bit, non-interlaced, colorType 2 (RGB) / 6 (RGBA) / 0
// (grayscale) — what headless Chrome and our encoder below emit. Throws (caller
// degrades) on anything fancier.
export function decodePng(buf: Buffer | Uint8Array): RGBAImage {
  const b = Buffer.from(buf);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error("not a PNG");
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bitDepth ${bitDepth} (need 8)`);
  if (interlace !== 0) throw new Error("unsupported interlaced PNG");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported PNG colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  const paeth = (a: number, bb: number, c: number) => {
    const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p++];
      const a = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const ul = x >= channels ? prev[x - channels] : 0;
      let val = rawByte;
      if (filter === 1) val = rawByte + a;
      else if (filter === 2) val = rawByte + up;
      else if (filter === 3) val = rawByte + ((a + up) >> 1);
      else if (filter === 4) val = rawByte + paeth(a, up, ul);
      cur[x] = val & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      if (channels === 1) {
        out[di] = out[di + 1] = out[di + 2] = cur[si];
        out[di + 3] = 255;
      } else {
        out[di] = cur[si];
        out[di + 1] = cur[si + 1];
        out[di + 2] = cur[si + 2];
        out[di + 3] = channels === 4 ? cur[si + 3] : 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
}

function crc32(buf: Buffer): number {
  // Node ≥ 22.2 exposes zlib.crc32; fall back to a table for Bun/older runtimes.
  const z: any = zlib;
  if (typeof z.crc32 === "function") return z.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

// Minimal PNG encoder (8-bit RGBA, filter 0). Used to write the diff heatmap.
export function encodePng(img: RGBAImage): Buffer {
  const { width, height, rgba } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export type DriftCell = { x: number; y: number; w: number; h: number; diff: number };
export type DiffResult = { score: number; width: number; height: number; cells: DriftCell[]; heatmap: RGBAImage };

// Composite RGBA over white, return [r,g,b].
function overWhite(rgba: Uint8Array, i: number): [number, number, number] {
  const a = rgba[i + 3] / 255;
  return [
    rgba[i] * a + 255 * (1 - a),
    rgba[i + 1] * a + 255 * (1 - a),
    rgba[i + 2] * a + 255 * (1 - a),
  ];
}

// Compare candidate vs reference on a cell grid. Candidate is nearest-sampled to the
// reference grid (handles a different screenshot scale). score = mean per-channel
// diff as a 0–100 percentage. cells = the grid, with per-cell mean diff (for the
// heatmap + the worst-region report).
export function diffImages(ref: RGBAImage, cand: RGBAImage, opts: { cell?: number } = {}): DiffResult {
  const W = ref.width, H = ref.height;
  const cell = Math.max(1, opts.cell ?? (Math.round(Math.max(W, H) / 40) || 1));
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const cellDiff = new Float64Array(cols * rows);
  const cellN = new Uint32Array(cols * rows);
  let total = 0, count = 0;
  const sx = cand.width / W, sy = cand.height / H;
  for (let y = 0; y < H; y++) {
    const cy = Math.min(cand.height - 1, Math.floor(y * sy));
    for (let x = 0; x < W; x++) {
      const cx = Math.min(cand.width - 1, Math.floor(x * sx));
      const ri = (y * W + x) * 4;
      const ci = (cy * cand.width + cx) * 4;
      const [r0, g0, b0] = overWhite(ref.rgba, ri);
      const [r1, g1, b1] = overWhite(cand.rgba, ci);
      const d = (Math.abs(r0 - r1) + Math.abs(g0 - g1) + Math.abs(b0 - b1)) / 3;
      total += d; count++;
      const cidx = Math.floor(y / cell) * cols + Math.floor(x / cell);
      cellDiff[cidx] += d; cellN[cidx]++;
    }
  }
  const score = count ? (total / count / 255) * 100 : 0;
  // heatmap: reference desaturated + red overlay scaled by per-cell diff.
  const heat = new Uint8Array(W * H * 4);
  const cells: DriftCell[] = [];
  for (let cyi = 0; cyi < rows; cyi++)
    for (let cxi = 0; cxi < cols; cxi++) {
      const cidx = cyi * cols + cxi;
      const cd = cellN[cidx] ? cellDiff[cidx] / cellN[cidx] : 0;
      cells.push({ x: cxi * cell, y: cyi * cell, w: Math.min(cell, W - cxi * cell), h: Math.min(cell, H - cyi * cell), diff: +(cd / 255 * 100).toFixed(2) });
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const cidx = Math.floor(y / cell) * cols + Math.floor(x / cell);
      const cd = cellN[cidx] ? cellDiff[cidx] / cellN[cidx] : 0;
      const t = Math.min(1, cd / 64); // 0..1 intensity
      const ri = (y * W + x) * 4;
      const [r0, g0, b0] = overWhite(ref.rgba, ri);
      const gray = (r0 + g0 + b0) / 3 * 0.5 + 127 * 0.5; // wash out the base
      const di = (y * W + x) * 4;
      heat[di] = Math.round(gray * (1 - t) + 255 * t);
      heat[di + 1] = Math.round(gray * (1 - t));
      heat[di + 2] = Math.round(gray * (1 - t));
      heat[di + 3] = 255;
    }
  cells.sort((a, b) => b.diff - a.diff);
  return { score: +score.toFixed(3), width: W, height: H, cells, heatmap: { width: W, height: H, rgba: heat } };
}
