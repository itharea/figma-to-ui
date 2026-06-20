// Export a vector node (logo, illustration, custom icon) as an SVG file by
// decoding fillGeometry/strokeGeometry blobs and composing transforms.
// Usage: node export-svg.mts <message.json> <guidKey> <out.svg> [--png]
import * as fs from "fs";
import { rasterizeFile } from "./raster-lib.mts";
import { load, key, colorStr, type Mat, I, mul, nodeMat } from "./lib.mts";

const { msg, byKey, children } = load(process.argv[2]);
// --png is parsed tolerantly (scan argv); the SVG out path is the first non-flag
// positional after the guidKey, so default (SVG-only) behavior is unchanged.
const png = process.argv.includes("--png");
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
const target = positional[0];
const outFile = positional[1];
if (!target || !outFile) throw new Error("usage: export-svg.mts <message.json> <guidKey> <out.svg> [--png]");
const blobs = msg.blobs;

// blob byte stream: [uint8 opcode][float32 LE args…]
// 0=Z, 1=M x y, 2=L x y, 3=Q cx cy x y, 4=C c1x c1y c2x c2y x y
function decodePath(blobIdx: number): string {
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

// Mat / I / mul / nodeMat now live in lib.mts (one matrix impl, reused).
const paths: string[] = [];

function emit(n: any, mat: Mat) {
  const visiblePaints = (ps: any[]) => (ps ?? []).filter((p) => p.visible !== false && p.type === "SOLID");
  const matStr = `matrix(${mat[0]} ${mat[3]} ${mat[1]} ${mat[4]} ${mat[2]} ${mat[5]})`;
  // strokeGeometry is pre-outlined — render it as a FILL with the stroke paint
  for (const [geos, paints] of [
    [n.fillGeometry, n.fillPaints],
    [n.strokeGeometry, n.strokePaints],
  ] as const) {
    for (const g of geos ?? []) {
      const ps = visiblePaints(paints);
      if (!ps.length) continue;
      const op = (ps[0].opacity ?? 1) * (n.opacity ?? 1);
      paths.push(
        `<path d="${decodePath(g.commandsBlob)}" fill="${colorStr(ps[0].color)}"${op < 1 ? ` fill-opacity="${op.toFixed(3)}"` : ""} fill-rule="${g.windingRule === "ODD" ? "evenodd" : "nonzero"}" transform="${matStr}"/>`
      );
    }
  }
}

function walk(k: string, mat: Mat, isRoot: boolean) {
  const n = byKey.get(k);
  if (!n || n.visible === false) return;
  const m = isRoot ? I : mul(mat, nodeMat(n)); // root's own transform is dropped (it becomes the viewBox origin)
  if (n.type !== "FRAME" && n.type !== "SECTION") emit(n, m);
  // INSTANCE nodes have no children in the tree — follow the master's subtree
  // at the instance's position. (Per-instance fill overrides are not applied;
  // good enough for shape extraction — recolor in the consuming component.)
  if (n.symbolData?.symbolID) {
    for (const c of children.get(key(n.symbolData.symbolID)) ?? []) walk(key(c.guid), m, false);
  }
  for (const c of children.get(k) ?? []) walk(key(c.guid), m, false);
}

const root = byKey.get(target);
if (!root) throw new Error("target not found: " + target);
walk(target, I, true);

const w = Math.ceil(root.size?.x ?? 0);
const h = Math.ceil(root.size?.y ?? 0);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${paths.join("\n")}\n</svg>\n`;
fs.writeFileSync(outFile, svg);
console.log(`wrote ${outFile}: ${w}x${h}, ${paths.length} paths, ${(svg.length / 1024).toFixed(1)}KB`);

// --png: rasterize the just-written SVG with the SKILL.md §6 headless-Chrome
// trick (window-size = the SVG's natural px; @3x). Degrades gracefully: if Chrome
// is absent the .svg above still stands and we note the skipped PNG.
if (png) {
  const pngOut = outFile.replace(/\.svg$/i, "") + ".png";
  const r = rasterizeFile(outFile, pngOut, w, h, 3);
  if (r.ok) console.log(`wrote ${pngOut}: ${w * 3}x${h * 3} (@3x)`);
  else console.error(`⚠ PNG skipped (${r.reason}); ${outFile} written`);
}
