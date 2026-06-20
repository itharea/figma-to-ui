// Diff two repeated frames/states (P2-4): resolve BOTH subtrees first (else
// INSTANCE nodes dead-end at instanceOf and per-node deltas inside instances stay
// invisible), align nodes by name-path, and report property deltas. Surfaces
// designer drift — it does NOT pick a canonical winner silently.
//
// Usage: node diff-frames.mts <message.json> <guidA> <guidB>
import { load, key } from "./lib.mts";
import { resolveScreen, type ResolvedNode } from "./resolve-lib.mts";
import { colorStr } from "./lib.mts";
import { letterSpacingStr, reconcileTextSize } from "./reconcile-lib.mts";

const msgPath = process.argv[2];
const a = process.argv[3];
const b = process.argv[4];
if (!msgPath || !a || !b) throw new Error("usage: diff-frames.mts <message.json> <guidA> <guidB>");

const index = load(msgPath);
const ra = resolveScreen(index, a);
const rb = resolveScreen(index, b);

// Align by a name-path key (the resolved `path` is per-tree-unique and includes
// instance guids, so it won't match across two trees — reuse find.mts's pathOf
// shape over names instead, with a per-parent ordinal to disambiguate siblings).
function indexByNamePath(root: ResolvedNode): Map<string, ResolvedNode> {
  const map = new Map<string, ResolvedNode>();
  const counts = new Map<string, number>();
  (function walk(n: ResolvedNode, prefix: string) {
    const base = `${prefix}/${n.type}:${n.name ?? ""}`;
    const k = `${base}#${(counts.get(base) ?? 0)}`;
    counts.set(base, (counts.get(base) ?? 0) + 1);
    map.set(k, n);
    for (const c of n.children ?? []) walk(c, k);
  })(root, "");
  return map;
}

const ia = indexByNamePath(ra);
const ib = indexByNamePath(rb);

// Property extractors → comparable display string per node.
function props(n: ResolvedNode): Record<string, string> {
  const p: Record<string, string> = {};
  if (n.type === "TEXT") {
    const fn = (n as any).fontName;
    if (fn) p.fontName = `${fn.family} ${fn.style}`;
    const rec = reconcileTextSize(n as any);
    if ((n as any).fontSize !== undefined) p.fontSize = String(rec.size ?? (n as any).fontSize);
    if ((n as any).lineHeight)
      p.lineHeight = `${(n as any).lineHeight.value}${(n as any).lineHeight.units === "PERCENT" ? "%" : "px"}`;
    p.letterSpacing = letterSpacingStr((n as any).letterSpacing, (n as any).fontSize);
    const chars = (n as any).textData?.characters ?? "";
    p.text = JSON.stringify(chars.length > 60 ? chars.slice(0, 60) + "…" : chars);
  }
  const solid = ((n as any).fillPaints ?? []).find((x: any) => x.visible !== false && x.type === "SOLID");
  if (solid) p.color = colorStr(solid.color);
  if ((n as any).size) p.size = `${Math.round((n as any).size.x)}x${Math.round((n as any).size.y)}`;
  if ((n as any).stackSpacing !== undefined) p.gap = String((n as any).stackSpacing);
  if ((n as any).cornerRadius) p.radius = String((n as any).cornerRadius);
  return p;
}

console.log(`# diff-frames: A=${a}  B=${b}`);
console.log(`# These are conflicting specs (possible designer drift). NO canonical`);
console.log(`# winner is chosen — confirm which .fig export / which frame is canonical.`);

let lines = 0;
const onlyA: string[] = [];
const onlyB: string[] = [];
for (const [k, na] of ia) {
  const nb = ib.get(k);
  if (!nb) {
    onlyA.push(`${na.type} "${na.name}"`);
    continue;
  }
  const pa = props(na);
  const pb = props(nb);
  const deltas: string[] = [];
  for (const field of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (pa[field] !== pb[field]) deltas.push(`${field} ${pa[field] ?? "∅"}→${pb[field] ?? "∅"}`);
  }
  if (deltas.length) {
    console.log(`${na.name ?? na.type}: ${deltas.join("  ")}`);
    lines++;
  }
}
for (const [k, nb] of ib) if (!ia.has(k)) onlyB.push(`${nb.type} "${nb.name}"`);

if (onlyA.length) console.log(`\n# only in A (${onlyA.length}): ${onlyA.slice(0, 20).join(", ")}${onlyA.length > 20 ? " …" : ""}`);
if (onlyB.length) console.log(`# only in B (${onlyB.length}): ${onlyB.slice(0, 20).join(", ")}${onlyB.length > 20 ? " …" : ""}`);
if (!lines && !onlyA.length && !onlyB.length) console.log("\n(no per-node property deltas — frames are structurally identical)");
