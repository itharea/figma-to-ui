// Find nodes by name (case-insensitive regex) and print their ancestor path.
// Usage: node find.ts <message.json> <name-regex> [type-filter]
// Example: node find.ts msg.json "product.?card" SYMBOL
import { load, key } from "./lib.ts";

const { nodes, byKey } = load(process.argv[2]);
const re = new RegExp(process.argv[3] ?? ".", "i");
const typeFilter = process.argv[4];

function pathOf(n: any): string {
  const parts: string[] = [];
  let cur = n;
  while (cur?.parentIndex) {
    cur = byKey.get(key(cur.parentIndex.guid));
    if (cur) parts.unshift(cur.name ?? cur.type);
  }
  return parts.join(" > ");
}

for (const n of nodes) {
  if (!n.name || !re.test(n.name)) continue;
  if (typeFilter && n.type !== typeFilter) continue;
  const sz = n.size ? ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}` : "";
  const hidden = n.visible === false ? " (HIDDEN)" : "";
  console.log(`${n.type} "${n.name}"${sz}${hidden} [${key(n.guid)}]  —  ${pathOf(n)}`);
}
