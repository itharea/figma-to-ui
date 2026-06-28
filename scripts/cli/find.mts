// Find nodes by name (case-insensitive regex) and print their ancestor path.
// Usage: node find.mts <message.json> <name-regex> [type-filter] [--under <name>]
// Example: node find.mts msg.json "product.?card" SYMBOL
//          node find.mts msg.json "Version=" SYMBOL --under Header
import { load, key } from "../lib/figma-index.mts";

const { nodes, byKey } = load(process.argv[2]);

// --under <name> scopes matches to nodes whose ancestor path contains a node
// whose name matches <name>. Scan argv tolerantly: the value is the next token.
const argv = process.argv.slice(3);
let underRe: RegExp | null = null;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--under") {
    underRe = new RegExp(argv[++i] ?? ".", "i");
  } else {
    positional.push(argv[i]);
  }
}

const re = new RegExp(positional[0] ?? ".", "i");
const typeFilter = positional[1];

function ancestors(n: any): any[] {
  const parts: any[] = [];
  let cur = n;
  while (cur?.parentIndex) {
    cur = byKey.get(key(cur.parentIndex.guid));
    if (cur) parts.unshift(cur);
  }
  return parts;
}

function pathOf(n: any): string {
  return ancestors(n)
    .map((c) => c.name ?? c.type)
    .join(" > ");
}

for (const n of nodes) {
  if (!n.name || !re.test(n.name)) continue;
  if (typeFilter && n.type !== typeFilter) continue;
  if (underRe && !ancestors(n).some((a) => a.name && underRe!.test(a.name))) continue;
  const sz = n.size ? ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}` : "";
  const hidden = n.visible === false ? " (HIDDEN)" : "";
  console.log(`${n.type} "${n.name}"${sz}${hidden} [${key(n.guid)}]  —  ${pathOf(n)}`);
}
