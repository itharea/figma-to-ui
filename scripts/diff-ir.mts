// diff-ir.mts — design-version diff over two emitted IR trees (Phase 9 / IR-PLAN
// Phase 4, generalizing P2-4 diff-frames). Consumes the IR ONLY — never re-decodes
// a blob, never re-resolves instances. Because each IR is already reconciled +
// provenance-stamped, the diff compares TRUTH vs TRUTH (not raw contradiction vs
// raw contradiction). It SURFACES drift; it never picks a canonical export.
//
// Usage: node diff-ir.mts <ir-old> <ir-new>
//
// Identity contract (§4): refuse to diff an IR against itself (same dir, or equal
// manifest.sourceHash — nothing to diff). Staleness: if a manifest's recorded
// source path still exists on disk, re-hash it and WARN on a mismatch with the
// stored sourceHash; if it is absent/moved, SKIP that check (do not error).
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const oldDir = process.argv[2];
const newDir = process.argv[3];
if (!oldDir || !newDir) throw new Error("usage: diff-ir.mts <ir-old> <ir-new>");

const readJSON = (dir: string, rel: string): any => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};

const manifest = (dir: string): any => {
  const m = readJSON(dir, "manifest.json");
  if (!m) { console.error(`diff-ir: ${dir}: no manifest.json — not an IR directory`); process.exit(2); }
  return m;
};

const mOld = manifest(oldDir);
const mNew = manifest(newDir);

// --- identity guard: refuse to diff an IR against itself --------------------
if (path.resolve(oldDir) === path.resolve(newDir)) {
  console.error("diff-ir: refusing to diff an IR against itself (same directory given twice) — nothing to diff");
  process.exit(2);
}
if (mOld.sourceHash && mOld.sourceHash === mNew.sourceHash) {
  console.error(
    `diff-ir: refusing to diff: both IRs share sourceHash ${String(mOld.sourceHash).slice(0, 12)}… — they were built from identical bytes, nothing to diff`
  );
  process.exit(2);
}

// --- staleness check (only when the recorded source still exists) -----------
function checkStale(label: string, m: any) {
  const srcPath = m?.source?.path;
  const stored = m?.sourceHash ?? m?.source?.hash;
  if (!srcPath || !stored) return;
  if (!fs.existsSync(srcPath)) {
    console.error(`  (${label}: source ${srcPath} absent/moved — staleness check skipped)`);
    return;
  }
  const cur = crypto.createHash("sha256").update(fs.readFileSync(srcPath)).digest("hex");
  if (cur !== stored)
    console.error(
      `⚠ ${label}: IR is STALE — its source ${srcPath} has changed since build ` +
        `(stored ${String(stored).slice(0, 12)}… ≠ current ${cur.slice(0, 12)}…). Re-run build-ir.`
    );
}
checkStale("ir-old", mOld);
checkStale("ir-new", mNew);

// --- helpers ----------------------------------------------------------------
const out: string[] = [];
const section = (title: string) => out.push("", `## ${title}`);
const line = (s: string) => out.push(s);

// set add/remove on a list of {key,label}
function setDiff<T>(
  oldItems: T[],
  newItems: T[],
  keyOf: (t: T) => string,
  labelOf: (t: T) => string
): { added: string[]; removed: string[]; common: [T, T][] } {
  const oldMap = new Map(oldItems.map((i) => [keyOf(i), i]));
  const newMap = new Map(newItems.map((i) => [keyOf(i), i]));
  const added: string[] = [];
  const removed: string[] = [];
  const common: [T, T][] = [];
  for (const [k, v] of newMap) if (!oldMap.has(k)) added.push(labelOf(v));
  for (const [k, v] of oldMap) if (!newMap.has(k)) removed.push(labelOf(v));
  for (const [k, v] of oldMap) if (newMap.has(k)) common.push([v, newMap.get(k)!]);
  return { added, removed, common };
}

// --- screens (manifest artifact list) ---------------------------------------
section("Screens");
{
  const so: string[] = mOld.artifacts?.screens ?? [];
  const sn: string[] = mNew.artifacts?.screens ?? [];
  const d = setDiff(so, sn, (s) => s, (s) => s);
  if (!d.added.length && !d.removed.length) line("(no screens added or removed)");
  for (const a of d.added) line(`+ screen ${a}`);
  for (const r of d.removed) line(`- screen ${r}`);
}

// --- components -------------------------------------------------------------
section("Components");
{
  const co: string[] = mOld.artifacts?.components ?? [];
  const cn: string[] = mNew.artifacts?.components ?? [];
  const d = setDiff(co, cn, (s) => s, (s) => s);
  if (!d.added.length && !d.removed.length) line("(no components added or removed)");
  for (const a of d.added) line(`+ component ${a}`);
  for (const r of d.removed) line(`- component ${r}`);
  // changed variant matrices on shared component files (align by file name)
  for (const [oName, nName] of d.common) {
    const o = readJSON(oldDir, `components/${oName}`);
    const n = readJSON(newDir, `components/${nName}`);
    if (!o || !n) continue;
    if (JSON.stringify(o.axes) !== JSON.stringify(n.axes))
      line(`~ component ${nName}: axes ${JSON.stringify(o.axes)} → ${JSON.stringify(n.axes)}`);
    else if (o.propApi !== n.propApi)
      line(`~ component ${nName}: propApi "${o.propApi}" → "${n.propApi}"`);
  }
}

// --- tokens (per file, per mode) --------------------------------------------
// Compare color/spacing/radius token files by token id; report per-mode value
// drift. Truth-vs-truth: a changed token = a real designer change.
section("Tokens");
{
  let anyTok = false;
  for (const file of ["tokens/colors.json", "tokens/spacing.json", "tokens/radius.json"]) {
    const o = readJSON(oldDir, file) ?? [];
    const n = readJSON(newDir, file) ?? [];
    const d = setDiff<any>(o, n, (t) => t.id ?? t.guid, (t) => `${t.name} ${JSON.stringify(t.modes)}`);
    for (const a of d.added) { line(`+ token ${file} ${a}`); anyTok = true; }
    for (const r of d.removed) { line(`- token ${file} ${r}`); anyTok = true; }
    for (const [ot, nt] of d.common) {
      const modes = new Set([...Object.keys(ot.modes ?? {}), ...Object.keys(nt.modes ?? {})]);
      for (const m of modes) {
        const ov = ot.modes?.[m];
        const nv = nt.modes?.[m];
        if (ov !== nv) { line(`~ token ${nt.name} [${m}]: ${ov} → ${nv}`); anyTok = true; }
      }
    }
  }
  if (!anyTok) line("(no token changes)");
}

// --- typography / type-spec drift -------------------------------------------
// Drift in family/size/weight/lineHeight/letterSpacing on a shared type style.
section("Type specs");
{
  const o = readJSON(oldDir, "tokens/typography.json") ?? [];
  const n = readJSON(newDir, "tokens/typography.json") ?? [];
  const d = setDiff<any>(o, n, (t) => t.id ?? t.guid ?? t.name, (t) => t.name);
  let anyT = false;
  for (const a of d.added) { line(`+ type ${a}`); anyT = true; }
  for (const r of d.removed) { line(`- type ${r}`); anyT = true; }
  const fields: [string, (t: any) => any][] = [
    ["family", (t) => t.family],
    ["size", (t) => t.size],
    ["weight", (t) => t.weight],
    ["lineHeightPx", (t) => t.lineHeightPx],
    ["letterSpacingPx@size", (t) => t["letterSpacingPx@size"]],
  ];
  for (const [ot, nt] of d.common) {
    const drifts: string[] = [];
    for (const [name, get] of fields) {
      const ov = get(ot);
      const nv = get(nt);
      if (ov !== nv) drifts.push(`${name} ${ov}→${nv}`);
    }
    if (drifts.length) { line(`~ type ${nt.name}: ${drifts.join(", ")}`); anyT = true; }
  }
  if (!anyT) line("(no type-spec drift)");
}

// --- per-screen node + color drift (align by path, never guid) --------------
// For each screen present in BOTH IRs, align nodes by `path` (the resolver's
// stable composite address — §4 identity rule; name is only a secondary label)
// and report added/removed nodes plus changed colors (with token deltas).
section("Per-screen nodes & colors");
{
  const so: string[] = mOld.artifacts?.screens ?? [];
  const sn: string[] = mNew.artifacts?.screens ?? [];
  const shared = so.filter((s) => sn.includes(s));
  type Flat = { path: string; name: string; type: string; hex: string | null; token: string | null; match: string | null };
  const flatten = (root: any): Map<string, Flat> => {
    const m = new Map<string, Flat>();
    (function walk(n: any) {
      if (!n) return;
      m.set(n.path, {
        path: n.path,
        name: n.name,
        type: n.type,
        hex: n.color?.hex ?? null,
        token: n.color?.token ?? null,
        match: n.color?.match ?? null,
      });
      for (const c of n.children ?? []) walk(c);
    })(root);
    return m;
  };
  let any = false;
  for (const rel of shared) {
    const o = readJSON(oldDir, rel);
    const n = readJSON(newDir, rel);
    if (!o || !n) continue;
    const om = flatten(o);
    const nm = flatten(n);
    const local: string[] = [];
    for (const [p, node] of nm) if (!om.has(p)) local.push(`  + node ${node.type} "${node.name}" @ ${p}`);
    for (const [p, node] of om) if (!nm.has(p)) local.push(`  - node ${node.type} "${node.name}" @ ${p}`);
    for (const [p, on] of om) {
      const nn = nm.get(p);
      if (!nn) continue;
      if (on.hex !== nn.hex)
        local.push(`  ~ color @ ${p} (${nn.name}): ${on.hex}${tokSuffix(on)} → ${nn.hex}${tokSuffix(nn)}`);
      else if (on.token !== nn.token)
        local.push(`  ~ token @ ${p} (${nn.name}): ${on.token ?? "—"} → ${nn.token ?? "—"}`);
    }
    if (local.length) { line(`screen ${rel}:`); local.forEach(line); any = true; }
  }
  function tokSuffix(f: { token: string | null; match: string | null }): string {
    return f.token ? ` [${f.token}${f.match ? " " + f.match : ""}]` : f.match ? ` [${f.match}]` : "";
  }
  if (!any) line("(no per-screen node or color drift on shared screens)");
}

console.error(`diff-ir: ${oldDir} → ${newDir}`);
console.log(out.join("\n").replace(/^\n/, ""));
