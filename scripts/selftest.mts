// selftest.mts — runnable regression assertions for the pure libs plus the
// hand-built resolver guards (the Phase 2 §8 cycle / remote-master artifact that
// a real .fig cannot author). Runs under node AND bun:
//   node scripts/selftest.mts [message.json]
//   bun  scripts/selftest.mts [message.json]
// Pure + synthetic checks always run. Live-fixture checks run only when a decode
// is reachable (argv[2], else /tmp/figparse/message_new.json) and skip cleanly
// otherwise. Exits non-zero on any failure. Not imported by anything.
import * as fs from "fs";
import { load, key } from "./lib.mts";
import {
  letterSpacingToPx,
  letterSpacingStr,
  lineHeightPx,
  reconcileTextSize,
  classifyPlaceholderText,
  disambiguateJustify,
} from "./reconcile-lib.mts";
import { resolveInstance } from "./resolve-lib.mts";
import { cornerRadiusOf } from "./screens-lib.mts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function approx(name: string, got: number, want: number, tol = 0.001) {
  check(name, Math.abs(got - want) <= tol, `got ${got} want ${want}`);
}

// ── reconcile-lib: placeholder classifier (P0-3 string half) ────────────────
eq("classify Title (no override) → placeholder", classifyPlaceholderText("Title", false).placeholder, true);
eq("classify 'Buy now' → real", classifyPlaceholderText("Buy now", false).placeholder, false);
eq("classify Title + override → real", classifyPlaceholderText("Title", true).placeholder, false);
eq("classify equals master default → placeholder", classifyPlaceholderText("Welcome", false, "Welcome").placeholder, true);

// ── reconcile-lib: letterSpacing / lineHeight units (P0-2) ──────────────────
approx("letterSpacingToPx 4% @16 → 0.64", letterSpacingToPx({ value: 4, units: "PERCENT" }, 16), 0.64);
eq("letterSpacingStr 4% @16", letterSpacingStr({ value: 4, units: "PERCENT" }, 16), "4%→0.64px@16");
eq("letterSpacingStr 1px", letterSpacingStr({ value: 1, units: "PIXELS" }, 16), "1px");
eq("letterSpacingStr missing → 0", letterSpacingStr(undefined, 16), "0");
eq("lineHeightPx 36px", lineHeightPx({ value: 36, units: "PIXELS" }, 28), 36);
eq("lineHeightPx AUTO → null", lineHeightPx({ units: "AUTO" }, 16), null);

// ── reconcile-lib: box-vs-font reconciliation (P0-1) ────────────────────────
{
  // SingleLine title shape (mirrors fixture 1273:19842): 28/lh36 in a 20-tall box.
  const r = reconcileTextSize({ type: "TEXT", fontSize: 28, size: { x: 39, y: 20 }, textAutoResize: "WIDTH_AND_HEIGHT", lineHeight: { value: 36, units: "PIXELS" } });
  check("singleline conflict detected", r.conflicts.length === 1);
  eq("singleline source = geometry", r.source, "geometry");
  eq("singleline chosen ≈ 16", r.size, 16);
}
{
  // Modal title shape (mirrors fixture 1273:19851): consistent 16/lh20 in 20-tall box — MUST NOT flag.
  const r = reconcileTextSize({ type: "TEXT", fontSize: 16, size: { x: 39, y: 20 }, textAutoResize: "WIDTH_AND_HEIGHT", lineHeight: { value: 20, units: "PIXELS" } });
  eq("modal no conflict", r.conflicts.length, 0);
  eq("modal source = fontSize", r.source, "fontSize");
}
{
  // Multi-line auto-height wrap guard: integer-multiple test must NOT run on the 1.2× guess.
  const r = reconcileTextSize({ type: "TEXT", fontSize: 16, size: { x: 200, y: 62 }, textAutoResize: "HEIGHT", lineHeight: { units: "AUTO" } });
  eq("auto-wrap no false positive", r.conflicts.length, 0);
}
{
  // HEIGHT with a real line height at an exact integer multiple (2 lines) — no flag.
  const r = reconcileTextSize({ type: "TEXT", fontSize: 16, size: { x: 200, y: 48 }, textAutoResize: "HEIGHT", lineHeight: { value: 24, units: "PIXELS" } });
  eq("height 2-line multiple no conflict", r.conflicts.length, 0);
}
{
  // HEIGHT shorter than a single line — must flag.
  const r = reconcileTextSize({ type: "TEXT", fontSize: 16, size: { x: 200, y: 10 }, textAutoResize: "HEIGHT", lineHeight: { value: 24, units: "PIXELS" } });
  check("height shorter-than-line conflict", r.conflicts.length === 1);
}

// ── reconcile-lib: disambiguateJustify (space-evenly → space-between) ───────
{
  // 1. ROW, 2 children flush at both ends (header shape) → space-between.
  const r = disambiguateJustify(
    { mode: "row", justify: "space-evenly", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [{ box: { x: 20, y: 0, w: 288, h: 40 } }, { box: { x: 308, y: 0, w: 62, h: 40 } }],
  );
  eq("dj row flush both ends → space-between", r, "space-between");
}
{
  // 2. ROW, 2 children NOT flush (inset from both ends) → unchanged.
  const r = disambiguateJustify(
    { mode: "row", justify: "space-evenly", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [{ box: { x: 80, y: 0, w: 60, h: 40 } }, { box: { x: 200, y: 0, w: 60, h: 40 } }],
  );
  eq("dj row inset → space-evenly", r, "space-evenly");
}
{
  // 3. COLUMN flush top/bottom → space-between.
  const r = disambiguateJustify(
    { mode: "column", justify: "space-evenly", paddingTop: 4, paddingBottom: 4 },
    { w: 60, h: 120 },
    [{ box: { x: 0, y: 4, w: 20, h: 20 } }, { box: { x: 0, y: 84, w: 40, h: 32 } }],
  );
  eq("dj column flush top/bottom → space-between", r, "space-between");
}
{
  // 4. justify not space-evenly → returned unchanged (helper only touches space-evenly).
  const center = disambiguateJustify(
    { mode: "row", justify: "center", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [{ box: { x: 20, y: 0, w: 288, h: 40 } }, { box: { x: 308, y: 0, w: 62, h: 40 } }],
  );
  eq("dj center untouched", center, "center");
  const flexStart = disambiguateJustify(
    { mode: "row", justify: "flex-start", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [{ box: { x: 20, y: 0, w: 288, h: 40 } }, { box: { x: 308, y: 0, w: 62, h: 40 } }],
  );
  eq("dj flex-start untouched", flexStart, "flex-start");
}
{
  // 5. Absolute children excluded: 1 in-flow + 1 absolute → <2 in-flow → unchanged.
  const r = disambiguateJustify(
    { mode: "row", justify: "space-evenly", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [
      { box: { x: 20, y: 0, w: 288, h: 40 } },
      { box: { x: 308, y: 0, w: 62, h: 40 }, positioning: "absolute" },
    ],
  );
  eq("dj absolute excluded → space-evenly", r, "space-evenly");
}
{
  // 6. Tolerance boundary (tol=1.5). First child offset from start by exactly tol,
  // last child flush at end → still space-between.
  const atTol = disambiguateJustify(
    { mode: "row", justify: "space-evenly", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [{ box: { x: 21.5, y: 0, w: 286.5, h: 40 } }, { box: { x: 308, y: 0, w: 62, h: 40 } }],
  );
  eq("dj offset == tol still flush → space-between", atTol, "space-between");
  // Offset by tol+1 (2.5) → not flush → unchanged.
  const overTol = disambiguateJustify(
    { mode: "row", justify: "space-evenly", paddingLeft: 20, paddingRight: 20 },
    { w: 390, h: 40 },
    [{ box: { x: 22.5, y: 0, w: 285.5, h: 40 } }, { box: { x: 308, y: 0, w: 62, h: 40 } }],
  );
  eq("dj offset > tol not flush → space-evenly", overTol, "space-evenly");
}

// ── screens-lib: cornerRadiusOf (CODEGEN_BUGS_v2 B — independent per-corner) ──
{
  // Independent corners, only the left pair set (slider fill 1153:1957): TR/BR absent
  // (= 0) must NOT drop the radius — it's a left-rounded pill end.
  eq(
    "corner independent left-only → {9999,0,0,9999}",
    cornerRadiusOf({ rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 9999, rectangleBottomLeftCornerRadius: 9999 }),
    { tl: 9999, tr: 0, br: 0, bl: 9999 },
  );
  // Independent flag but all four equal → collapses to the uniform number.
  eq(
    "corner independent all-equal → number",
    cornerRadiusOf({ rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 8, rectangleTopRightCornerRadius: 8, rectangleBottomRightCornerRadius: 8, rectangleBottomLeftCornerRadius: 8 }),
    8,
  );
  // All four present, NOT independent, differing → object (existing behavior preserved).
  eq(
    "corner four-present differing → object",
    cornerRadiusOf({ rectangleTopLeftCornerRadius: 4, rectangleTopRightCornerRadius: 8, rectangleBottomRightCornerRadius: 4, rectangleBottomLeftCornerRadius: 8 }),
    { tl: 4, tr: 8, br: 4, bl: 8 },
  );
  // Uniform cornerRadius fallback, and the empty case.
  eq("corner uniform fallback → number", cornerRadiusOf({ cornerRadius: 12 }), 12);
  eq("corner none → undefined", cornerRadiusOf({}), undefined);
}

// ── resolve-lib: hand-built index guards (a real .fig cannot author these) ───
const G = (s: number, l: number) => ({ sessionID: s, localID: l });
function makeIndex(nodes: any[]): ReturnType<typeof load> {
  const byKey = new Map<string, any>();
  for (const n of nodes) byKey.set(key(n.guid), n);
  const children = new Map<string, any[]>();
  for (const n of nodes) {
    if (!n.parentIndex) continue;
    const pk = key(n.parentIndex.guid);
    if (!children.has(pk)) children.set(pk, []);
    children.get(pk)!.push(n);
  }
  for (const arr of children.values())
    arr.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : 1));
  return { msg: {} as any, nodes, byKey, children };
}
{
  // Cycle: master M(1:100) contains an instance pointing back to M → must terminate.
  const M = { guid: G(1, 100), type: "FRAME", name: "M" };
  const innerInst = { guid: G(1, 101), type: "INSTANCE", name: "inner", parentIndex: { guid: G(1, 100), position: "a" }, symbolData: { symbolID: G(1, 100) } };
  const outer = { guid: G(2, 1), type: "INSTANCE", name: "outer", symbolData: { symbolID: G(1, 100) } };
  const r = resolveInstance(makeIndex([M, innerInst, outer]), "2:1"); // must not hang/throw
  eq("cycle: outer composes one child", r.children.length, 1);
  eq("cycle: inner marked unresolved=cycle", r.children[0]?.unresolved, "cycle");
}
{
  // Remote master absent from the decode → labeled unresolved leaf, no crash.
  const remote = { guid: G(2, 2), type: "INSTANCE", name: "remote", componentKey: "ABC123", symbolData: { symbolID: G(9, 999) } };
  const r = resolveInstance(makeIndex([remote]), "2:2");
  check("remote: unresolved starts 'remote master'", typeof r.unresolved === "string" && r.unresolved.startsWith("remote master"), JSON.stringify(r.unresolved));
  eq("remote: no children", r.children.length, 0);
}
{
  // Override composition: a text override addressed by overrideKey is applied.
  const M2 = { guid: G(1, 200), type: "FRAME", name: "M2" };
  const t = { guid: G(1, 201), type: "TEXT", name: "label", overrideKey: G(14, 1), parentIndex: { guid: G(1, 200), position: "a" }, textData: { characters: "Default" } };
  const inst = { guid: G(2, 3), type: "INSTANCE", name: "card", symbolData: { symbolID: G(1, 200), symbolOverrides: [{ guidPath: { guids: [G(14, 1)] }, textData: { characters: "Real" } }] } };
  const r = resolveInstance(makeIndex([M2, t, inst]), "2:3");
  eq("override: composes one child", r.children.length, 1);
  eq("override: text → 'Real'", (r.children[0] as any)?.textData?.characters, "Real");
  eq("override: hasTextOverride flagged", r.children[0]?.hasTextOverride, true);
}

// ── live fixtures (skip cleanly when no decode is reachable) ─────────────────
const decodePath = process.argv[2] || "/tmp/figparse/message_new.json";
if (fs.existsSync(decodePath)) {
  const idx = load(decodePath);
  const a = idx.byKey.get("1273:19842");
  const b = idx.byKey.get("1273:19851");
  if (a) {
    const r = reconcileTextSize(a);
    check("live 1273:19842 flagged", r.conflicts.length > 0);
    eq("live 1273:19842 chosen ≈ 16", r.size, 16);
  } else console.error("  (live: 1273:19842 absent in decode — skipped)");
  if (b) eq("live 1273:19851 not flagged", reconcileTextSize(b).conflicts.length, 0);
  else console.error("  (live: 1273:19851 absent in decode — skipped)");
} else {
  console.error(`  (live-fixture checks skipped — no decode at ${decodePath})`);
}

console.error(`\nselftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
