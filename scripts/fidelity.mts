// fidelity.mts — the elevation guardrail. After codegen.mts scaffolds a component
// and you (the agent) elevate it into a clean component, this proves you did not
// break the 1:1 mapping. Two modes (logic in fidelity-lib.mts):
//
//   CONTRACT (default, deterministic, no Chrome):
//     node fidelity.mts <ir-dir> <id> [--variant <v>] [--json]
//   prints the per-node invariants the elevated code MUST preserve (geometry,
//   typography, color token, layout, borders, the variant→structure tree). Diff
//   your refactor against this — every line must still hold.
//
//   IMAGE DIFF (visual backstop, needs Chrome + a candidate screenshot):
//     node fidelity.mts <ir-dir> <id> --variant <v> --candidate app.png [--out heatmap.png] [--max-diff <pct>]
//   renders the IR reference (via render.mts --ir) and diffs your app's screenshot
//   of the elevated component against it; reports an overall drift score + the worst
//   regions. Surfaces drift; you adjudicate (real copy replacing a placeholder is an
//   expected, legitimate diff).
//
// <id> is a component set name/slug, or a screen-file slug / node id / guid.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import type { IRNode } from "./screens-lib.mts";
import { mapValue } from "./components-lib.mts";
import { buildContract, formatContract, decodePng, encodePng, diffImages } from "./fidelity-lib.mts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dir = argv[0];
const id = argv[1];
if (!dir || !id || id.startsWith("--"))
  throw new Error(
    "usage: fidelity.mts <ir-dir> <id> [--variant <v>] [--candidate <png>] [--out <heatmap.png>] [--json] [--images <dir>] [--cell <px>] [--max-diff <pct>]"
  );
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const wantVariant = flag("--variant");
const candidate = flag("--candidate");
const outHeat = flag("--out");
const asJson = argv.includes("--json");
const imagesDir = flag("--images");
const cell = flag("--cell") ? parseInt(flag("--cell")!, 10) : undefined;
const maxDiff = flag("--max-diff") ? parseFloat(flag("--max-diff")!) : undefined;

const slugify = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const readJSON = (rel: string): any => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const manifest = readJSON("manifest.json") ?? {};

// screens artifact list (manifest first, else glob screens/**/*.json)
function screenRels(): string[] {
  if (manifest.artifacts?.screens?.length) return manifest.artifacts.screens;
  const sdir = path.join(dir, "screens");
  if (!fs.existsSync(sdir)) return [];
  const out: string[] = [];
  (function w(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) w(fp);
      else if (e.name.endsWith(".json")) out.push(path.relative(dir, fp));
    }
  })(sdir);
  return out;
}

function findNodeByGuid(guid: string): IRNode | null {
  for (const rel of screenRels()) {
    let hit: IRNode | null = null;
    (function w(n: any) {
      if (!n || hit) return;
      if (n.guid === guid) { hit = n; return; }
      for (const c of n.children ?? []) w(c);
    })(readJSON(rel));
    if (hit) return hit;
  }
  return null;
}

function findNodeById(needle: string): IRNode | null {
  for (const rel of screenRels()) {
    let hit: IRNode | null = null;
    (function w(n: any) {
      if (!n || hit) return;
      if (n.id === needle || n.guid === needle) { hit = n; return; }
      for (const c of n.children ?? []) w(c);
    })(readJSON(rel));
    if (hit) return hit;
  }
  return null;
}

// --- locate the component set (slug-tolerant, same as codegen.mts) ------------
function loadComponent(): any | null {
  const compDir = path.join(dir, "components");
  if (!fs.existsSync(compDir)) return null;
  const want = slugify(id);
  for (const f of fs.readdirSync(compDir)) {
    if (!f.endsWith(".json")) continue;
    const c = JSON.parse(fs.readFileSync(path.join(compDir, f), "utf8"));
    if (f.replace(/\.json$/, "") === want || slugify(c.name ?? "") === want) return c;
  }
  return null;
}

// A target = a resolved IR root + a label + the id render.mts --ir should draw.
type Target = { root: IRNode; label: string; renderId: string };

function resolveTargets(): Target[] {
  const comp = loadComponent();
  if (comp) {
    // The variant's prop-union key, computed with the SAME mapValue codegen uses, so
    // --variant accepts the literal the agent sees in the generated union type
    // (e.g. "single-line" for Version=SingleLine, "modal", "large").
    const axisNames = Object.keys(comp.axes ?? {});
    const variantKey = (v: any) =>
      axisNames.length ? axisNames.map((a) => mapValue(String(v.props?.[a] ?? ""))).join("/") : "default";
    const variantLabel = (v: any) => variantKey(v) || v.rawName || v.guidKey;
    const variantMatches = (v: any, want: string) => {
      const w = slugify(want);
      if (slugify(variantKey(v)) === w || slugify(v.rawName ?? "") === w || v.guidKey === want) return true;
      return Object.values(v.props ?? {}).some((pv) => slugify(String(pv)) === w || slugify(mapValue(String(pv))) === w);
    };

    let variants: any[] = comp.variants ?? [];
    if (wantVariant) {
      const v = variants.find((x) => variantMatches(x, wantVariant));
      if (!v) throw new Error(`variant "${wantVariant}" not in set "${comp.name}". Variants: ${variants.map(variantLabel).join(", ")}`);
      variants = [v];
    }
    const targets: Target[] = [];
    for (const v of variants) {
      const root = findNodeByGuid(v.guidKey);
      if (!root) { console.error(`(skip) variant ${variantLabel(v)}: subtree not found by guid ${v.guidKey}`); continue; }
      targets.push({ root, label: `${comp.name} / ${variantLabel(v)}`, renderId: v.guidKey });
    }
    if (!targets.length) throw new Error(`no renderable variant subtrees for set "${comp.name}"`);
    return targets;
  }
  // screen file slug?
  const rel = screenRels().find((r) => slugify(path.basename(r, ".json")) === slugify(id));
  if (rel) { const root = readJSON(rel); if (root) return [{ root, label: path.basename(rel, ".json"), renderId: id }]; }
  // node id / guid
  const node = findNodeById(id);
  if (node) return [{ root: node, label: `${node.type} "${node.name}"`, renderId: id }];
  throw new Error(`"${id}" is not a component set, screen slug, node id, or guid in ${dir}`);
}

const targets = resolveTargets();

// === IMAGE DIFF mode =========================================================
if (candidate) {
  if (targets.length !== 1)
    throw new Error(`--candidate needs a single target — pass --variant to pick one (got ${targets.length})`);
  const t = targets[0];
  if (!fs.existsSync(candidate)) throw new Error(`candidate not found: ${candidate}`);

  // render the IR reference via render.mts --ir (reuse — no re-implementation)
  const refPng = path.join(os.tmpdir(), `fidelity-ref-${process.pid}.png`);
  const rArgs = ["--ir", dir, t.renderId, refPng];
  if (imagesDir) rArgs.push("--images", imagesDir);
  const r = spawnSync(process.argv[0], [path.join(scriptDir, "render.mts"), ...rArgs], { encoding: "utf8" });
  if (!fs.existsSync(refPng)) {
    console.error(`could not render the IR reference (render.mts): ${(r.stderr ?? "").trim().slice(0, 300)}`);
    console.error("→ image diff needs Chrome; the deterministic CONTRACT mode (drop --candidate) needs nothing.");
    process.exit(2);
  }

  const ref = decodePng(fs.readFileSync(refPng));
  const cand = decodePng(fs.readFileSync(candidate));
  const res = diffImages(ref, cand, { cell });
  fs.rmSync(refPng, { force: true });

  console.log(`# fidelity image diff — ${t.label}`);
  console.log(`# reference ${ref.width}×${ref.height}  candidate ${cand.width}×${cand.height}`);
  console.log(`drift score: ${res.score}%  (0 = identical; this is an aid, not a hard gate)`);
  const worst = res.cells.filter((c) => c.diff > 1).slice(0, 12);
  if (worst.length) {
    console.log(`worst regions (x,y,w,h → diff%):`);
    for (const c of worst) console.log(`  (${c.x},${c.y},${c.w},${c.h}) → ${c.diff}%`);
  } else console.log("no region exceeds 1% — visually faithful.");
  if (outHeat) { fs.writeFileSync(outHeat, encodePng(res.heatmap)); console.error(`heatmap → ${outHeat}`); }
  if (maxDiff !== undefined && res.score > maxDiff) {
    console.error(`FAIL: drift ${res.score}% > --max-diff ${maxDiff}%`);
    process.exit(1);
  }
  process.exit(0);
}

// === CONTRACT mode (default) =================================================
if (asJson) {
  const payload = targets.map((t) => ({ target: t.label, records: buildContract(t.root) }));
  console.log(JSON.stringify(targets.length === 1 ? payload[0] : payload, null, 2));
} else {
  for (const t of targets) {
    console.log(formatContract(buildContract(t.root), t.label));
    console.log("");
  }
}
