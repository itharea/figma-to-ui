// ir-validate.mts — the ship gate (Phase 9 / IR-PLAN "Validation gates"). Asserts,
// from the IR ALONE (no decode, no re-resolve), that the IR is safe to implement
// against. A failing gate IS the automated "ask, don't ship" list: each failure
// prints the node `guid` (drop back to node.mts) and which decisions.json entry
// would resolve it. Exits NON-ZERO on any failure (usable in CI / pre-ship).
//
// Usage: node ir-validate.mts <ir-dir>
//
// Gates (§4 Task 2):
//   1. tokens   — every color adjudicated against the theme. ONLY when a --theme
//                 was used: pass on match:"exact", a tokenConfirms upgrade, or a
//                 tokenRejects (deliberately-new). An un-adjudicated none/nearest
//                 fails. match:null ⇒ NO theme (greenfield) ⇒ gate skipped.
//   2. fonts    — every font has a non-null appFamily (ALWAYS enforced, greenfield
//                 included: substitution is a decision nowhere in the bytes).
//   3. placeholders — no unresolved placeholder:true text.
//   4. conflicts    — no open font.conflicts[].
//   5. provenance   — no reconciled field missing source/match (build-integrity).
import * as fs from "fs";
import * as path from "path";
import { provenanceViolations, type IRNode } from "./screens-lib.mts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: ir-validate.mts <ir-dir>");

const readJSON = (rel: string): any => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};

const manifest = readJSON("manifest.json");
if (!manifest) { console.error(`ir-validate: ${dir}: no manifest.json — not an IR directory`); process.exit(2); }

// Did the build apply a --theme? The token gate only runs when one did. Trust the
// manifest, but cross-check the IR itself: every color carrying match:null means no
// code token layer exists to bind (greenfield, Phase 8 §6a) — skip the token gate.
const themeUsed = !!manifest.theme;

type Failure = { gate: string; guid?: string; detail: string; fix: string };
const failures: Failure[] = [];

// --- gather screen files ----------------------------------------------------
const screenRels: string[] = manifest.artifacts?.screens ?? [];

// --- a single walk per screen collects every node-level gate ----------------
let sawThemedColor = false; // any color with a non-null match ⇒ a theme really bound
function walk(n: IRNode, screenRel: string) {
  // gate 2: fonts — appFamily always required
  if (n.font) {
    if (!n.font.appFamily)
      failures.push({
        gate: "font",
        guid: n.guid,
        detail: `font "${n.font.family}" has no appFamily (text "${n.text?.value ?? ""}")`,
        fix: `decisions.fontMap["${n.font.family}"] = "<app font>"`,
      });
    // gate 4: open reconciliation conflicts
    for (const c of n.font.conflicts ?? [])
      failures.push({
        gate: "conflict",
        guid: n.guid,
        detail: `${n.name}: ${c.field} ${c.declared}→~${c.chosen} (box.y=${c.boxY} vs lh=${c.lhPx}) — ${c.reason}`,
        fix: `confirm the reconciled size in decisions (or fix the design); placeholders/tokenConfirms don't clear a size conflict`,
      });
  }
  // gate 3: unresolved placeholder text
  if (n.text?.placeholder)
    failures.push({
      gate: "placeholder",
      guid: n.guid,
      detail: `text ${JSON.stringify(n.text.value)} is an un-confirmed placeholder (${n.text.reason})`,
      fix: `decisions.placeholders["${n.guid}"] = { "placeholder": false }  (or set real "text")`,
    });
  // gate 1: color adjudication. A color BOUND to a Figma variable (match:"bound",
  // var!=null) is ADJUDICATED by the bytes themselves (ground truth) — it ALWAYS
  // PASSES, greenfield or themed; never fail a bound color. (A-variables / spec #3.)
  if (n.color?.var != null || n.color?.match === "bound") {
    // bound — pass, no gate. fall through (no theme check below).
  } else if (themeUsed && n.color?.hex) {
    const m = n.color.match;
    if (m != null) sawThemedColor = true;
    // match:null ⇒ greenfield (no theme bound) — not a failure. exact/rejected/a
    // confirmed token are adjudicated. none/nearest un-adjudicated ⇒ fail.
    if (m === "none" || (typeof m === "string" && m.startsWith("nearest")))
      failures.push({
        gate: "token",
        guid: n.guid,
        detail: `color ${n.color.hex} is ${m} — not adjudicated against the theme`,
        fix: `decisions.tokenConfirms["color:${n.color.hex}"] = "<token>"  OR  decisions.tokenRejects += "color:${n.color.hex}"`,
      });
  }
  for (const c of n.children) walk(c, screenRel);
}

for (const rel of screenRels) {
  const root = readJSON(rel);
  if (!root) continue;
  walk(root, rel);
  // gate 5: build-integrity provenance — every reconciled field carries source/match
  for (const v of provenanceViolations(root))
    failures.push({ gate: "provenance", detail: `${rel}: ${v}`, fix: "build bug — rebuild with current build-ir.mts" });
}

// If --theme was claimed but NO color ever bound (every match:null), the IR is
// effectively greenfield: the token gate was correctly inert (no false failures).
if (themeUsed && !sawThemedColor)
  console.error("  note: --theme recorded but no color bound a token (all match:null) — token gate inert (greenfield)");

// --- report -----------------------------------------------------------------
const byGate: Record<string, Failure[]> = {};
for (const f of failures) (byGate[f.gate] ??= []).push(f);

if (!failures.length) {
  console.error(`ir-validate: ${dir} — PASS (all gates green)`);
  console.log("PASS");
  process.exit(0);
}

console.error(`ir-validate: ${dir} — FAIL (${failures.length} unresolved across ${Object.keys(byGate).length} gate(s))`);
const lines: string[] = [];
for (const gate of Object.keys(byGate)) {
  lines.push(`## ${gate} (${byGate[gate].length})`);
  for (const f of byGate[gate]) {
    lines.push(`  ✗ ${f.guid ? `[${f.guid}] ` : ""}${f.detail}`);
    lines.push(`     → fix: ${f.fix}`);
  }
}
console.log(lines.join("\n"));
process.exit(1);
