// Dump a node's subtree as one line per node: type, name, size, position,
// fills/strokes, radius, auto-layout, font, text, effects. This dump is the
// per-screen implementation artifact — complete and unambiguous.
// Usage: node dump.mts <message.json> <guidKey> [maxDepth]
// (guidKey like "735:14256" — get it from tree.mts or find.mts)
import { load, key, absCoords } from "./lib.mts";
import { describeNode } from "./describe-lib.mts";
import { resolveScreen, type ResolvedNode } from "./resolve-lib.mts";

const argv = process.argv;
const abs = argv.includes("--abs"); // scan for the flag; keep maxDepth positional
const resolve = argv.includes("--resolve"); // opt-in instance resolution (Phase 2 Task 2)
const index = load(argv[2]);
const { byKey, children } = index;
const target = argv[3];
const maxDepthArg = argv.slice(4).find((a) => !a.startsWith("--") && /^\d+$/.test(a));
const maxDepth = parseInt(maxDepthArg ?? "99", 10);
if (!target) throw new Error("usage: dump.mts <message.json> <guidKey> [maxDepth] [--abs] [--resolve]");

const absFn = (n: any) => absCoords(byKey, key(n.guid));

// Default fast path: raw tree, no resolution (the "raw tools stay" principle).
function walk(k: string, depth: number, prefix: string) {
  const n = byKey.get(k);
  if (!n) return;
  console.log(prefix + describeNode(n, { abs: abs ? absFn : undefined }) + ` [${k}]`);
  if (depth >= maxDepth) return;
  for (const c of children.get(k) ?? []) {
    if (c.visible === false) continue;
    walk(key(c.guid), depth + 1, prefix + "  ");
  }
}

// --resolve: compose master + overrides, tag placeholder/overridden text.
function walkResolved(n: ResolvedNode, depth: number, prefix: string) {
  if (depth > maxDepth) return;
  const tags: string[] = [];
  if (n.fromInstance) tags.push(`[from ${n.fromInstance}]`);
  if (n.overrideApplied) tags.push(`[overridden: ${Object.keys(n.overrideApplied).join(",")}]`);
  if (n.unresolved) tags.push(`⚠ unresolved (${n.unresolved})`);
  if (n.unresolvedOverrides?.length) tags.push(`⚠ stale overrides: ${n.unresolvedOverrides.join("; ")}`);
  console.log(prefix + describeNode(n as any, { placeholderTag: true }) + ` [${n.guid}]` + (tags.length ? " " + tags.join(" ") : ""));
  for (const c of n.children ?? []) {
    if ((c as any).visible === false) continue;
    walkResolved(c, depth + 1, prefix + "  ");
  }
}

if (resolve) walkResolved(resolveScreen(index, target), 0, "");
else walk(target, 0, "");
