// Resolve an instance/screen: compose master + symbolOverrides into the rendered
// tree and print it dump-style. The human-facing verifier for resolve-lib.mts and
// the input to Phase 5 render.mts.
// Usage: node resolve.mts <message.json> <guidKey> [maxDepth]
import { load } from "./lib.mts";
import { describeNode } from "./describe-lib.mts";
import { resolveScreen, type ResolvedNode } from "./resolve-lib.mts";

const argv = process.argv;
const index = load(argv[2]);
const target = argv[3];
const maxDepthArg = argv.slice(4).find((a) => !a.startsWith("--") && /^\d+$/.test(a));
const maxDepth = parseInt(maxDepthArg ?? "99", 10);
if (!target) throw new Error("usage: resolve.mts <message.json> <guidKey> [maxDepth]");

function walk(n: ResolvedNode, depth: number, prefix: string) {
  if (depth > maxDepth) return;
  const tags: string[] = [];
  if (n.fromInstance) tags.push(`[from ${n.fromInstance}]`);
  if (n.overrideApplied) tags.push(`[overridden: ${Object.keys(n.overrideApplied).join(",")}]`);
  if (n.unresolved) tags.push(`⚠ unresolved (${n.unresolved})`);
  if (n.unresolvedOverrides?.length) tags.push(`⚠ stale overrides: ${n.unresolvedOverrides.join("; ")}`);
  console.log(prefix + describeNode(n as any, { placeholderTag: true }) + ` [${n.path}]` + (tags.length ? " " + tags.join(" ") : ""));
  for (const c of n.children ?? []) {
    if ((c as any).visible === false) continue;
    walk(c, depth + 1, prefix + "  ");
  }
}

walk(resolveScreen(index, target), 0, "");
