// ir.mts — a dumb reader over an emitted IR directory. NO decode. The default
// access mode is a DIRECT READ of the small per-file JSON; ir.mts only answers
// cross-cutting questions a single file can't. Tolerates fields that arrive in
// later phases (match=…, conflicts) by treating them as absent.
// Usage: node ir.mts <ir-dir> <query>
//   ir.mts ir-new "fonts where appFamily is empty"
//   ir.mts ir-new "colors with match=none"        (match arrives Phase 8)
//   ir.mts ir-new "nodes with conflicts"          (conflicts arrive Phase 7)
import * as fs from "fs";
import * as path from "path";

const [, , dir, ...rest] = process.argv;
const query = rest.join(" ").trim().toLowerCase();
if (!dir || !query)
  throw new Error('usage: ir.mts <ir-dir> <query>   e.g. ir.mts ir-new "fonts where appFamily is empty"');

const readJSON = (rel: string): any => {
  const p = path.join(dir, rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

if (/fonts.*appfamily.*empty|fonts where appfamily/.test(query)) {
  const fonts = readJSON("fonts.json") ?? [];
  const hits = fonts.filter((f: any) => !f.appFamily);
  if (!hits.length) console.error("(no fonts with an empty appFamily slot)");
  for (const f of hits) console.log(`${f.family}  (count ${f.count}, used by: ${(f.usedBy ?? []).join(", ")})`);
} else if (/colors.*match.*none|colors with match/.test(query)) {
  const colors = readJSON("tokens/colors.json") ?? [];
  // match field arrives in Phase 8; tolerate its absence (nothing matches yet).
  const hits = colors.filter((c: any) => c.match === "none");
  if (!hits.length) console.error("(no colors with match=none — the match field arrives in Phase 8)");
  for (const c of hits) console.log(`${c.name}  ${JSON.stringify(c.modes)}`);
} else if (/nodes with conflicts|conflicts/.test(query)) {
  // Phase 7 screens live at screens/<page>/<screen>.json. The reconciled
  // conflicts[] hang off each node's `font` (and other reconciled objects); walk
  // every screen file and report nodes carrying a non-empty font.conflicts.
  const screensDir = path.join(dir, "screens");
  const files: string[] = [];
  if (fs.existsSync(screensDir)) {
    for (const page of fs.readdirSync(screensDir)) {
      const pageDir = path.join(screensDir, page);
      if (!fs.statSync(pageDir).isDirectory()) {
        if (page.endsWith(".json")) files.push(path.join("screens", page));
        continue;
      }
      for (const f of fs.readdirSync(pageDir))
        if (f.endsWith(".json")) files.push(path.join("screens", page, f));
    }
  }
  let any = false;
  for (const rel of files) {
    const data = readJSON(rel);
    const walk = (n: any) => {
      const conf = n?.font?.conflicts ?? n?.conflicts;
      if (Array.isArray(conf) && conf.length) {
        any = true;
        console.log(`${n.id ?? "?"}  ${n.path ?? ""}  ${JSON.stringify(conf)}`);
      }
      for (const c of n?.children ?? []) walk(c);
    };
    walk(data);
  }
  if (!any) console.error("(no nodes with conflicts in any screen)");
} else {
  throw new Error(
    `unrecognized query: "${rest.join(" ")}". Supported: "fonts where appFamily is empty", "colors with match=none", "nodes with conflicts".`
  );
}
