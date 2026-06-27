// Manifest icons under a screen (P2-7): list each icon instance, resolve it to its
// library export name (the layer name is usually a public library export, e.g.
// Phosphor `MagnifyingGlass` — SKILL.md §8 step 6), and emit the exact additions
// for the consuming wrapper's icon-name union so a name is never imported without
// being mapped.
//
// Usage: node icons.mts <message.json> <screen-guidKey>
import { load, key } from "../lib/figma-index.mts";
import { resolveScreen, type ResolvedNode } from "../lib/resolve-lib.mts";
import { isMonoColorIconFill } from "../lib/intent-lib.mts";

const msgPath = process.argv[2];
const screen = process.argv[3];
if (!msgPath || !screen) throw new Error("usage: icons.mts <message.json> <screen-guidKey>");

const index = load(msgPath);
const root = resolveScreen(index, screen);

// A node is "icon-like" when it is an INSTANCE/SYMBOL whose name reads like a
// PascalCase library export (Phosphor & friends) on a small square-ish box, or a
// layer name carrying a `name=<Icon>` variant tag (the icon-set page convention).
const PASCAL = /^[A-Z][A-Za-z0-9]+$/;
const NAME_TAG = /name=\s*([A-Za-z][\w./-]*)/i;

function exportName(n: ResolvedNode): string | null {
  const raw = (n.name ?? "").trim();
  if (!raw) return null;
  // `name=Foobar` variant tag → take the value; strip a leading "Tabbar / " etc.
  const tag = raw.match(NAME_TAG);
  if (tag) {
    const v = tag[1]
      .split("/")
      .pop()!
      .replace(/-filled$/i, "")
      .trim();
    if (PASCAL.test(v)) return v;
  }
  if (PASCAL.test(raw.replace(/-filled$/i, ""))) return raw.replace(/-filled$/i, "");
  return null;
}

type Hit = { name: string; export: string; mono: boolean; guid: string; size: string };
const hits: Hit[] = [];
function walk(n: ResolvedNode) {
  const sid = (n as any).symbolData?.symbolID;
  if ((n.type === "INSTANCE" || n.type === "SYMBOL") && sid) {
    const ex = exportName(n);
    const sz = (n as any).size;
    const square = sz && Math.abs(sz.x - sz.y) <= Math.max(4, sz.x * 0.25) && sz.x <= 96;
    if (ex && square) {
      hits.push({
        name: n.name ?? "",
        export: ex,
        mono: subtreeMono(n),
        guid: n.guid,
        size: sz ? `${Math.round(sz.x)}x${Math.round(sz.y)}` : "",
      });
      return; // don't descend into a recognized icon (its vector children aren't icons)
    }
  }
  for (const c of n.children ?? []) walk(c);
}
// an icon is mono-color if its own fill or any descendant fill is pure white/black
function subtreeMono(n: ResolvedNode): boolean {
  if (isMonoColorIconFill(n)) return true;
  return (n.children ?? []).some(subtreeMono);
}
walk(root);

// dedupe export names, keep first occurrence count
const byExport = new Map<string, { count: number; mono: boolean; sample: Hit }>();
for (const h of hits) {
  const e = byExport.get(h.export);
  if (e) {
    e.count++;
    e.mono = e.mono || h.mono;
  } else byExport.set(h.export, { count: 1, mono: h.mono, sample: h });
}

console.log(
  `# icons under ${root.name} [${screen}] — ${hits.length} instance(s), ${byExport.size} distinct`,
);
if (!byExport.size) {
  console.log("# (no library-named icon instances found)");
} else {
  console.log(`\n## inventory`);
  for (const [ex, info] of [...byExport].sort((x, y) => x[0].localeCompare(y[0])))
    console.log(
      `${ex}  ×${info.count}  ${info.sample.size}${info.mono ? "  (mono — recolor in consumer)" : ""}  e.g. [${info.sample.guid}]`,
    );

  // exact union additions for the wrapper (e.g. AppIconName) — never import an
  // unmapped name.
  console.log(`\n## add to the icon-name union (AppIconName)`);
  const names = [...byExport.keys()].sort();
  console.log(`export type AppIconName =`);
  console.log(names.map((n) => `  | '${n}'`).join("\n") + ";");
  console.log(
    `\n# import { ${names.join(", ")} } from 'phosphor-react-native'; // or your icon lib`,
  );
}
