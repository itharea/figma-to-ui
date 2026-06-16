// Print the document skeleton: DOCUMENT → CANVAS (pages) → top-level frames.
// Usage: node tree.ts <message.json>
import { load, key } from "./lib.ts";

const { nodes, children } = load(process.argv[2]);

const roots = nodes.filter((n: any) => n.type === "DOCUMENT" || !n.parentIndex);
for (const r of roots) {
  console.log(`ROOT ${r.type} "${r.name}" ${key(r.guid)}`);
  for (const page of children.get(key(r.guid)) ?? []) {
    console.log(`  PAGE ${page.type} "${page.name}" ${key(page.guid)} visible=${page.visible !== false}`);
    for (const f of children.get(key(page.guid)) ?? []) {
      const sz = f.size ? `${Math.round(f.size.x)}x${Math.round(f.size.y)}` : "";
      const pos = f.transform ? `@(${Math.round(f.transform.m02)},${Math.round(f.transform.m12)})` : "";
      console.log(`    ${f.type} "${f.name}" ${sz} ${pos} ${key(f.guid)}`);
    }
  }
}
