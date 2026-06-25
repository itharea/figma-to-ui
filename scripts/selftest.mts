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
import { overlap, overlapArea, hasSignificantNonAdjacentOverlap } from "./layout-lib.mts";
import {
  cssVarName,
  treePath,
  tsAccessor,
  constIdent,
  literalFor,
  topoOrder,
  emitTheme,
  type ThemeVar,
} from "./theme-lib.mts";
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { buildContract, decodePng, encodePng, diffImages, type RGBAImage } from "./fidelity-lib.mts";
import { deriveLogicals } from "./components-lib.mts";

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

// ── layout-lib: overlap geometry + peek-stack detection (improvement #11) ────
{
  // strict overlap: edge-touching does NOT count; real intersection does.
  eq("overlap edge-touch → false", overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  eq("overlap real → true", overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }), true);
  eq("overlapArea disjoint → 0", overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }), 0);
  eq("overlapArea 5x10 → 50", overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }), 50);

  // negative-gap flex (slider track `blue`, guid 1153:1957 family): a fill bar + a thumb,
  // ADJACENT, overlapping ~30% — must STAY flex (no non-adjacent pair). #11 must not fire.
  eq(
    "peek-stack: adjacent slider bar+thumb → false",
    hasSignificantNonAdjacentOverlap([{ x: 0, y: 4, w: 117, h: 12 }, { x: 107, y: 0, w: 20, h: 20 }]),
    false,
  );
  // authored peek-carousel (collections-slider Frame 1686562511, 5 product cards): large
  // center + 4 progressively-smaller cards stacked behind — NON-ADJACENT pairs overlap
  // 34–88%. #11 must fire so codegen positions them absolutely even with no abs flag.
  eq(
    "peek-stack: collections 5-card carousel → true",
    hasSignificantNonAdjacentOverlap([
      { x: -4, y: 63, w: 160, h: 199 },
      { x: 19, y: 38, w: 200, h: 249 },
      { x: 210, y: 63, w: 160, h: 199 },
      { x: 150, y: 38, w: 200, h: 249 },
      { x: 53, y: 0, w: 260, h: 324 },
    ]),
    true,
  );
  // a clean flex row (3 cards laid out side by side, tiny frozen-bbox touches only) → false.
  eq(
    "peek-stack: clean side-by-side row → false",
    hasSignificantNonAdjacentOverlap([{ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }]),
    false,
  );
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

// ── theme-lib: name munging, literals, topo order, emit (issue #16/#17) ──────
{
  // name munging — the ONE rule codegen and theme-gen both consume.
  eq("cssVarName praline", cssVarName("Color/praline/950"), "--color-praline-950");
  eq("cssVarName comma decimal", cssVarName("Numbers/1,5"), "--numbers-1-5");
  eq("treePath splits on slash only (comma stays in leaf)", treePath("Numbers/1,5"), ["numbers", "1,5"]);
  eq("treePath lowercases first segment only", treePath("Color/praline/950"), ["color", "praline", "950"]);
  eq("tsAccessor bracket for numeric leaf", tsAccessor("Color/praline/950"), "color.praline['950']");
  eq("tsAccessor bracket for hyphen segment", tsAccessor("Typography/line-height/m"), "typography['line-height'].m");
  eq("constIdent keeps case, joins on _", constIdent("Numbers/18"), "Numbers_18");
  eq("constIdent comma → _", constIdent("Numbers/1,5"), "Numbers_1_5");
}
{
  // literalFor by type.
  eq("literalFor COLOR quoted", literalFor("COLOR", "#2a1e1e").code, "'#2a1e1e'");
  eq("literalFor FLOAT bare", literalFor("FLOAT", "18").code, "18");
  eq("literalFor STRING quoted", literalFor("STRING", "Lora").code, "'Lora'");
  eq("literalFor BOOLEAN bare", literalFor("BOOLEAN", "true").code, "true");
  const bad = literalFor("FLOAT", "alias→7:9");
  check("literalFor non-numeric FLOAT → quoted + warning", bad.code === "'alias→7:9'" && !!bad.warning, JSON.stringify(bad));
}
const tv = (name: string, type: string, value: string, guid: string, target?: string): ThemeVar => ({
  id: `token:${guid}`, name, set: "S", type, modes: { "Mode 1": value }, guid, defaultMode: "Mode 1",
  ...(target ? { aliasTargets: { "Mode 1": target } } : {}),
});
{
  // topo: a→b→c (c concrete) must emit c, then b, then a.
  const a = tv("X/a", "FLOAT", "18", "a", "b");
  const b = tv("X/b", "FLOAT", "18", "b", "c");
  const c = tv("X/c", "FLOAT", "18", "c");
  const { ordered, hadCycle } = topoOrder([a, b, c], "Mode 1");
  eq("topo 2-hop order c,b,a", ordered.map((v) => v.guid), ["c", "b", "a"]);
  check("topo no cycle", hadCycle === false);
}
{
  const n18 = tv("Numbers/18", "FLOAT", "18", "n18");
  const sm = tv("Typography/size/m", "FLOAT", "18", "sm", "n18");
  const pr = tv("Color/praline/950", "COLOR", "#2a1e1e", "pr");
  const fam = tv("Typography/family/Display", "STRING", "Lora", "fam");
  const vars = [pr, n18, sm, fam];
  const web = emitTheme(vars, { framework: "web" });
  check("emit web: alias → var() ref", web.code.includes("--typography-size-m: var(--numbers-18)"), web.code);
  check("emit web: concrete color literal", web.code.includes("--color-praline-950: #2a1e1e"), web.code);
  check("emit web: no warnings", web.warnings.length === 0, JSON.stringify(web.warnings));
  const rn = emitTheme(vars, { framework: "rn" });
  check("emit rn: alias const references target", rn.code.includes("const Typography_size_m = Numbers_18"), rn.code);
  check("emit rn: bracket key for numeric leaf", rn.code.includes("'950': Color_praline_950"), rn.code);
  check("emit rn: STRING const quoted", rn.code.includes("const Typography_family_Display = 'Lora'"), rn.code);
  // topological guarantee: a target const is declared BEFORE its referrer.
  check("emit rn: target declared before referrer",
    rn.code.indexOf("const Numbers_18") < rn.code.indexOf("const Typography_size_m") && rn.code.indexOf("const Numbers_18") >= 0,
    rn.code);
  check("emit rn: mode-keyed + defaultMode export", rn.code.includes("export const defaultMode = 'Mode 1'") && rn.code.includes("'Mode 1': (() =>"), rn.code);
}
{
  // dangling alias (target not in catalog — e.g. soft-deleted) → value fallback + warning.
  const d = tv("X/d", "FLOAT", "99", "d", "missing");
  const web = emitTheme([d], { framework: "web" });
  check("emit dangling: falls back to value", web.code.includes("--x-d: 99"), web.code);
  check("emit dangling: warns", web.warnings.some((w) => /dangling/.test(w)), JSON.stringify(web.warnings));
}

// ── components-lib: deriveLogicals prop model (findings #2/#3 — synthetic) ──
// Pure transform over synthetic ComponentProp[]; no decode / IR-artifact dependency.
const bind = (node: string, field: string) => [{ node, field }];
{
  // #3 — text + bool(default:true) on the SAME node must NOT collapse: a master-visible
  // node renders at zero props via show<X>=true + a master-default text fallback.
  const { logicals, logicalByDefKey } = deriveLogicals({
    props: [
      { name: "header", rawName: "Header", kind: "boolean", defKey: "b1", default: true, bindings: bind("N1", "visible") },
      { name: "baslik", rawName: "Başlık", kind: "text", defKey: "t1", default: "Test", bindings: bind("N1", "characters") },
    ],
  });
  eq("deriveLogicals: default-true text+bool NOT collapsed (2 props)", logicals.length, 2);
  const showHeader = logicals.find((l) => l.name === "showHeader") as any;
  const baslik = logicals.find((l) => l.name === "baslik") as any;
  check("deriveLogicals: showHeader is bool, defBool=true", !!showHeader && showHeader.role === "bool" && showHeader.defBool === true, JSON.stringify(showHeader));
  check("deriveLogicals: baslik is text, defText='Test', standalone", !!baslik && baslik.role === "text" && baslik.defText === "Test" && baslik.figNames.length === 1, JSON.stringify(baslik));
  check("deriveLogicals: both defKeys map (bool→showHeader, text→baslik)", logicalByDefKey.get("b1") === showHeader && logicalByDefKey.get("t1") === baslik, "");
}
{
  // text + bool(default:false) on the SAME node SHOULD collapse to one optional string
  // (master hides by default → pass a string to show, omit to hide). Behaviour preserved.
  const { logicals, logicalByDefKey } = deriveLogicals({
    props: [
      { name: "secondLine", rawName: "SecondLine", kind: "boolean", defKey: "b2", default: false, bindings: bind("N2", "visible") },
      { name: "line2", rawName: "Line2", kind: "text", defKey: "t2", default: "Addr", bindings: bind("N2", "characters") },
    ],
  });
  eq("deriveLogicals: default-false text+bool collapsed (1 prop)", logicals.length, 1);
  const lg = logicals[0] as any;
  check("deriveLogicals: collapsed → role text, figNames length 2", lg.role === "text" && lg.figNames.length === 2, JSON.stringify(lg));
  check("deriveLogicals: collapsed → both defKeys map to it", logicalByDefKey.get("b2") === lg && logicalByDefKey.get("t2") === lg, "");
}
{
  // #3 — standalone bool(default:true) → show<X> carrying defBool for the destructure default.
  const { logicals } = deriveLogicals({
    props: [{ name: "action", rawName: "action", kind: "boolean", defKey: "b3", default: true, bindings: bind("N3", "visible") }],
  });
  const lg = logicals[0] as any;
  check("deriveLogicals: standalone bool → showAction, role bool, defBool=true", lg.name === "showAction" && lg.role === "bool" && lg.defBool === true, JSON.stringify(lg));
}
{
  // #2 — instanceSwap carries the default SYMBOL guid so the slot is never silently empty.
  const { logicals } = deriveLogicals({
    props: [{ name: "instance", rawName: "Instance", kind: "instanceSwap", defKey: "s4", default: "315:2646", bindings: bind("N4", "symbolId") }],
  });
  const lg = logicals[0] as any;
  check("deriveLogicals: instanceSwap → slot, defSym set", lg.role === "slot" && lg.defSym === "315:2646", JSON.stringify(lg));
}

// ── fidelity-lib: contract builder (the elevation guardrail) ────────────────
{
  const node: any = {
    id: "1:2", path: "/p", guid: "1:2", type: "frame", name: "Card",
    box: { x: 0, y: 0, w: 100, h: 50, absX: 0, absY: 0 },
    layout: { mode: "row", gap: 8, paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4, align: "center" },
    style: { cornerRadius: 8, fills: [{ type: "solid", hex: "#ffffff" }] },
    children: [
      {
        id: "1:3", path: "/p/c", guid: "1:3", type: "text", name: "Label",
        box: { x: 0, y: 0, w: 40, h: 16, absX: 0, absY: 0 },
        font: { family: "Inter", appFamily: null, weight: "Medium", size: 16, sizeSource: "style", sizeToken: null, styleName: "Body/M", vars: null, lineHeightPx: 20, letterSpacingPx: 0, conflicts: [] },
        color: { hex: "#111111", var: null, varGuid: null, token: null, match: null },
        text: { value: "Hi", placeholder: false },
        style: { fills: [{ type: "solid", hex: "#111111" }] },
        children: [],
      },
    ],
  };
  const recs = buildContract(node);
  eq("contract: node count", recs.length, 2);
  eq("contract: root styleKey matches codegen", recs[0].styleKey, "n_1_2");
  eq("contract: root childCount", recs[0].childCount, 1);
  eq("contract: root bg fill", recs[0].invariants.bg, "#ffffff");
  eq("contract: root radius", recs[0].invariants.radius, "8");
  check("contract: layout captured", recs[0].invariants.layout === "row gap8 align:center pad[4,4,4,4]", recs[0].invariants.layout);
  check("contract: font size+family", /size16/.test(recs[1].invariants.font ?? "") && /fam:Inter/.test(recs[1].invariants.font ?? ""), recs[1].invariants.font);
  eq("contract: text color", recs[1].invariants.color, "#111111");
  check("contract: text fill not treated as bg", !("bg" in recs[1].invariants), JSON.stringify(recs[1].invariants));
}

// ── fidelity-lib: PNG roundtrip + image diff (the visual backstop) ───────────
{
  const img: RGBAImage = { width: 2, height: 2, rgba: new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   10, 20, 30, 200,
  ]) };
  const round = decodePng(encodePng(img));
  eq("png roundtrip: dims", [round.width, round.height], [2, 2]);
  eq("png roundtrip: pixels identical", Array.from(round.rgba), Array.from(img.rgba));

  const white: RGBAImage = { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(255) };
  const black: RGBAImage = { width: 4, height: 4, rgba: (() => { const a = new Uint8Array(4 * 4 * 4); for (let i = 0; i < a.length; i++) a[i] = i % 4 === 3 ? 255 : 0; return a; })() };
  approx("diff: identical → 0%", diffImages(white, white).score, 0);
  approx("diff: white vs black → 100%", diffImages(white, black).score, 100, 0.5);
}

// ── raw.mts: dispatch smoke (confirms all 8 folded lib imports resolve) ──────
{
  const rawPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "raw.mts");
  const r = spawnSync(process.argv[0], [rawPath], { encoding: "utf8" });
  check("raw.mts no-arg → exit 1", r.status === 1, `status ${r.status}`);
  check("raw.mts no-arg → prints usage", /usage: raw\.mts/.test(r.stderr ?? ""), (r.stderr ?? "").slice(0, 120));
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
