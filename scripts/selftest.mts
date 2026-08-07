// selftest.mts — runnable regression assertions for the pure libs plus the
// hand-built resolver guards (the Phase 2 §8 cycle / remote-master artifact that
// a real .fig cannot author). Runs under node AND bun:
//   node scripts/selftest.mts [message.json]
//   bun  scripts/selftest.mts [message.json]
// Pure + synthetic checks always run. Live-fixture checks run only when a decode
// is reachable (argv[2], else /tmp/figparse/message_new.json) and skip cleanly
// otherwise. Exits non-zero on any failure. Not imported by anything.
import * as fs from "fs";
import { load, key } from "./lib/figma-index.mts";
import {
  letterSpacingToPx,
  letterSpacingStr,
  lineHeightPx,
  reconcileTextSize,
  classifyPlaceholderText,
  disambiguateJustify,
} from "./lib/reconcile-lib.mts";
import { resolveInstance } from "./lib/resolve-lib.mts";
import { cornerRadiusOf } from "./lib/screens-lib.mts";
import { overlap, overlapArea, hasSignificantNonAdjacentOverlap } from "./lib/layout-lib.mts";
import {
  cssVarName,
  treePath,
  tsAccessor,
  constIdent,
  literalFor,
  topoOrder,
  emitTheme,
  type ThemeVar,
} from "./lib/theme-lib.mts";
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { extractGeometry, toSvgString, emitIconComponent } from "./lib/svg-lib.mts";
import { deriveLogicals } from "./lib/components-lib.mts";
import { slugify, uniqueSlug, kebab, camel, compIdent } from "./lib/naming.mts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  check(
    name,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
  );
}
function approx(name: string, got: number, want: number, tol = 0.001) {
  check(name, Math.abs(got - want) <= tol, `got ${got} want ${want}`);
}

// ── naming: slug / kebab / camel / PascalCase identifiers (shared munging) ───
eq(
  "slugify lowercases + collapses",
  slugify("Product Card / Collections!"),
  "product-card-collections",
);
eq("slugify trims edge runs", slugify("--Hello--"), "hello");
{
  const taken = new Set<string>();
  eq("uniqueSlug first → base", uniqueSlug("Splash", taken), "splash");
  eq("uniqueSlug collision → -2", uniqueSlug("Splash", taken), "splash-2");
  eq("uniqueSlug empty → set", uniqueSlug("—", taken), "set");
}
eq("kebab splits camel + cleans", kebab("SingleLine"), "single-line");
eq("kebab snake/space → -", kebab("dropdown_no value"), "dropdown-no-value");
eq("camel transliterates Turkish", camel("Başlık"), "baslik");
eq("camel keeps existing camel", camel("actionText"), "actionText");
eq("camel single word lowercased", camel("Icon"), "icon");
eq("camel empty → prop", camel("—"), "prop");
eq("compIdent → PascalCase", compIdent("product-card collections"), "ProductCardCollections");
eq("compIdent empty → Component", compIdent(""), "Component");

// ── reconcile-lib: placeholder classifier (string half) ────────────────
eq(
  "classify Title (no override) → placeholder",
  classifyPlaceholderText("Title", false).placeholder,
  true,
);
eq("classify 'Buy now' → real", classifyPlaceholderText("Buy now", false).placeholder, false);
eq("classify Title + override → real", classifyPlaceholderText("Title", true).placeholder, false);
eq(
  "classify equals master default → placeholder",
  classifyPlaceholderText("Welcome", false, "Welcome").placeholder,
  true,
);

// ── reconcile-lib: letterSpacing / lineHeight units ──────────────────
approx(
  "letterSpacingToPx 4% @16 → 0.64",
  letterSpacingToPx({ value: 4, units: "PERCENT" }, 16),
  0.64,
);
eq("letterSpacingStr 4% @16", letterSpacingStr({ value: 4, units: "PERCENT" }, 16), "4%→0.64px@16");
eq("letterSpacingStr 1px", letterSpacingStr({ value: 1, units: "PIXELS" }, 16), "1px");
eq("letterSpacingStr missing → 0", letterSpacingStr(undefined, 16), "0");
eq("lineHeightPx 36px", lineHeightPx({ value: 36, units: "PIXELS" }, 28), 36);
eq("lineHeightPx AUTO → null", lineHeightPx({ units: "AUTO" }, 16), null);

// ── reconcile-lib: box-vs-font reconciliation ────────────────────────
{
  // SingleLine title shape (mirrors fixture 1273:19842): 28/lh36 in a 20-tall box.
  const r = reconcileTextSize({
    type: "TEXT",
    fontSize: 28,
    size: { x: 39, y: 20 },
    textAutoResize: "WIDTH_AND_HEIGHT",
    lineHeight: { value: 36, units: "PIXELS" },
  });
  check("singleline conflict detected", r.conflicts.length === 1);
  eq("singleline source = geometry", r.source, "geometry");
  eq("singleline chosen ≈ 16", r.size, 16);
}
{
  // Modal title shape (mirrors fixture 1273:19851): consistent 16/lh20 in 20-tall box — MUST NOT flag.
  const r = reconcileTextSize({
    type: "TEXT",
    fontSize: 16,
    size: { x: 39, y: 20 },
    textAutoResize: "WIDTH_AND_HEIGHT",
    lineHeight: { value: 20, units: "PIXELS" },
  });
  eq("modal no conflict", r.conflicts.length, 0);
  eq("modal source = fontSize", r.source, "fontSize");
}
{
  // Multi-line auto-height wrap guard: integer-multiple test must NOT run on the 1.2× guess.
  const r = reconcileTextSize({
    type: "TEXT",
    fontSize: 16,
    size: { x: 200, y: 62 },
    textAutoResize: "HEIGHT",
    lineHeight: { units: "AUTO" },
  });
  eq("auto-wrap no false positive", r.conflicts.length, 0);
}
{
  // HEIGHT with a real line height at an exact integer multiple (2 lines) — no flag.
  const r = reconcileTextSize({
    type: "TEXT",
    fontSize: 16,
    size: { x: 200, y: 48 },
    textAutoResize: "HEIGHT",
    lineHeight: { value: 24, units: "PIXELS" },
  });
  eq("height 2-line multiple no conflict", r.conflicts.length, 0);
}
{
  // HEIGHT shorter than a single line — must flag.
  const r = reconcileTextSize({
    type: "TEXT",
    fontSize: 16,
    size: { x: 200, y: 10 },
    textAutoResize: "HEIGHT",
    lineHeight: { value: 24, units: "PIXELS" },
  });
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
  eq(
    "overlap edge-touch → false",
    overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }),
    false,
  );
  eq(
    "overlap real → true",
    overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }),
    true,
  );
  eq(
    "overlapArea disjoint → 0",
    overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }),
    0,
  );
  eq(
    "overlapArea 5x10 → 50",
    overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }),
    50,
  );

  // negative-gap flex (slider track `blue`, guid 1153:1957 family): a fill bar + a thumb,
  // ADJACENT, overlapping ~30% — must STAY flex (no non-adjacent pair). #11 must not fire.
  eq(
    "peek-stack: adjacent slider bar+thumb → false",
    hasSignificantNonAdjacentOverlap([
      { x: 0, y: 4, w: 117, h: 12 },
      { x: 107, y: 0, w: 20, h: 20 },
    ]),
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
    hasSignificantNonAdjacentOverlap([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 100, y: 0, w: 100, h: 100 },
      { x: 200, y: 0, w: 100, h: 100 },
    ]),
    false,
  );
}

// ── screens-lib: cornerRadiusOf (independent per-corner) ──
{
  // Independent corners, only the left pair set (slider fill 1153:1957): TR/BR absent
  // (= 0) must NOT drop the radius — it's a left-rounded pill end.
  eq(
    "corner independent left-only → {9999,0,0,9999}",
    cornerRadiusOf({
      rectangleCornerRadiiIndependent: true,
      rectangleTopLeftCornerRadius: 9999,
      rectangleBottomLeftCornerRadius: 9999,
    }),
    { tl: 9999, tr: 0, br: 0, bl: 9999 },
  );
  // Independent flag but all four equal → collapses to the uniform number.
  eq(
    "corner independent all-equal → number",
    cornerRadiusOf({
      rectangleCornerRadiiIndependent: true,
      rectangleTopLeftCornerRadius: 8,
      rectangleTopRightCornerRadius: 8,
      rectangleBottomRightCornerRadius: 8,
      rectangleBottomLeftCornerRadius: 8,
    }),
    8,
  );
  // All four present, NOT independent, differing → object (existing behavior preserved).
  eq(
    "corner four-present differing → object",
    cornerRadiusOf({
      rectangleTopLeftCornerRadius: 4,
      rectangleTopRightCornerRadius: 8,
      rectangleBottomRightCornerRadius: 4,
      rectangleBottomLeftCornerRadius: 8,
    }),
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
  const innerInst = {
    guid: G(1, 101),
    type: "INSTANCE",
    name: "inner",
    parentIndex: { guid: G(1, 100), position: "a" },
    symbolData: { symbolID: G(1, 100) },
  };
  const outer = {
    guid: G(2, 1),
    type: "INSTANCE",
    name: "outer",
    symbolData: { symbolID: G(1, 100) },
  };
  const r = resolveInstance(makeIndex([M, innerInst, outer]), "2:1"); // must not hang/throw
  eq("cycle: outer composes one child", r.children.length, 1);
  eq("cycle: inner marked unresolved=cycle", r.children[0]?.unresolved, "cycle");
}
{
  // Remote master absent from the decode → labeled unresolved leaf, no crash.
  const remote = {
    guid: G(2, 2),
    type: "INSTANCE",
    name: "remote",
    componentKey: "ABC123",
    symbolData: { symbolID: G(9, 999) },
  };
  const r = resolveInstance(makeIndex([remote]), "2:2");
  check(
    "remote: unresolved starts 'remote master'",
    typeof r.unresolved === "string" && r.unresolved.startsWith("remote master"),
    JSON.stringify(r.unresolved),
  );
  eq("remote: no children", r.children.length, 0);
}
{
  // Override composition: a text override addressed by overrideKey is applied.
  const M2 = { guid: G(1, 200), type: "FRAME", name: "M2" };
  const t = {
    guid: G(1, 201),
    type: "TEXT",
    name: "label",
    overrideKey: G(14, 1),
    parentIndex: { guid: G(1, 200), position: "a" },
    textData: { characters: "Default" },
  };
  const inst = {
    guid: G(2, 3),
    type: "INSTANCE",
    name: "card",
    symbolData: {
      symbolID: G(1, 200),
      symbolOverrides: [{ guidPath: { guids: [G(14, 1)] }, textData: { characters: "Real" } }],
    },
  };
  const r = resolveInstance(makeIndex([M2, t, inst]), "2:3");
  eq("override: composes one child", r.children.length, 1);
  eq("override: text → 'Real'", (r.children[0] as any)?.textData?.characters, "Real");
  eq("override: hasTextOverride flagged", r.children[0]?.hasTextOverride, true);
}

// ── resolve-lib: component properties (TEXT / VISIBLE / INSTANCE_SWAP) ───────
// The modern override mechanism: master `componentPropDefs` (default) + instance
// `componentPropAssignments` (value) + per-node `componentPropRefs` (which field it
// drives). Each block also asserts the un-assigned case still yields the MASTER's
// value, so wiring props in cannot start clobbering correct output.
{
  // TEXT prop: the assignment must beat the master default, and must not throw away
  // the master's rich-text metadata while doing so.
  const MT = {
    guid: G(1, 300),
    type: "FRAME",
    name: "MT",
    // A set-member master's defs are stubs `{id, parentPropDefId}` — no value here.
    componentPropDefs: [{ id: G(1, 310), type: "TEXT", parentPropDefId: G(3, 1) }],
  };
  const label = {
    guid: G(1, 301),
    type: "TEXT",
    name: "label",
    parentIndex: { guid: G(1, 300), position: "a" },
    textData: { characters: "Master", styleOverrideTable: [{ styleID: 7 }] },
    componentPropRefs: [{ defID: G(1, 310), componentPropNodeField: "TEXT_DATA" }],
  };
  const assigned = {
    guid: G(2, 10),
    type: "INSTANCE",
    name: "assigned",
    symbolData: { symbolID: G(1, 300) },
    componentPropAssignments: [
      { defID: G(1, 310), value: { textDataValue: { characters: "Supplied" } } },
    ],
  };
  const bare = {
    guid: G(2, 11),
    type: "INSTANCE",
    name: "bare",
    symbolData: { symbolID: G(1, 300) },
  };
  const idx = makeIndex([MT, label, assigned, bare]);
  const ra = resolveInstance(idx, "2:10");
  eq(
    "prop TEXT: assignment beats master default",
    (ra.children[0] as any)?.textData?.characters,
    "Supplied",
  );
  eq(
    "prop TEXT: master rich-text metadata survives",
    (ra.children[0] as any)?.textData?.styleOverrideTable,
    [{ styleID: 7 }],
  );
  eq("prop TEXT: hasTextOverride flagged", ra.children[0]?.hasTextOverride, true);
  eq("prop TEXT: masterDefaultText cleared", ra.children[0]?.masterDefaultText, undefined);
  const rb = resolveInstance(idx, "2:11");
  eq(
    "prop TEXT: unassigned keeps master default",
    (rb.children[0] as any)?.textData?.characters,
    "Master",
  );
  eq("prop TEXT: unassigned is not flagged overridden", rb.children[0]?.hasTextOverride, undefined);
  eq("prop TEXT: unassigned keeps masterDefaultText", rb.children[0]?.masterDefaultText, "Master");
}
{
  // BOOL prop → VISIBLE. Uses the varValue-shaped assignment (`varValue.value`).
  const MV = { guid: G(1, 400), type: "FRAME", name: "MV" };
  const badge = {
    guid: G(1, 401),
    type: "FRAME",
    name: "badge",
    parentIndex: { guid: G(1, 400), position: "a" },
    visible: true,
    componentPropRefs: [{ defID: G(1, 410), componentPropNodeField: "VISIBLE" }],
  };
  const hidden = {
    guid: G(2, 12),
    type: "INSTANCE",
    name: "hidden",
    symbolData: { symbolID: G(1, 400) },
    componentPropAssignments: [{ defID: G(1, 410), varValue: { value: { boolValue: false } } }],
  };
  const shown = {
    guid: G(2, 13),
    type: "INSTANCE",
    name: "shown",
    symbolData: { symbolID: G(1, 400) },
  };
  const idx = makeIndex([MV, badge, hidden, shown]);
  eq(
    "prop VISIBLE: false hides the node",
    (resolveInstance(idx, "2:12").children[0] as any)?.visible,
    false,
  );
  eq(
    "prop VISIBLE: unassigned stays visible",
    (resolveInstance(idx, "2:13").children[0] as any)?.visible,
    true,
  );
}
{
  // Ordering: props are applied BEFORE symbolOverrides, so an explicit override on
  // the same node wins. The control instance proves the prop is otherwise live.
  const MO = { guid: G(1, 500), type: "FRAME", name: "MO" };
  const label = {
    guid: G(1, 501),
    type: "TEXT",
    name: "label",
    overrideKey: G(15, 1),
    parentIndex: { guid: G(1, 500), position: "a" },
    textData: { characters: "Master" },
    componentPropRefs: [{ defID: G(1, 510), componentPropNodeField: "TEXT_DATA" }],
  };
  const assignment = {
    defID: G(1, 510),
    varValue: { value: { textDataValue: { characters: "FromProp" } } },
  };
  const propOnly = {
    guid: G(2, 14),
    type: "INSTANCE",
    name: "propOnly",
    symbolData: { symbolID: G(1, 500) },
    componentPropAssignments: [assignment],
  };
  const both = {
    guid: G(2, 15),
    type: "INSTANCE",
    name: "both",
    symbolData: {
      symbolID: G(1, 500),
      symbolOverrides: [
        { guidPath: { guids: [G(15, 1)] }, textData: { characters: "FromOverride" } },
      ],
    },
    componentPropAssignments: [assignment],
  };
  const idx = makeIndex([MO, label, propOnly, both]);
  eq(
    "prop vs override: prop alone applies",
    (resolveInstance(idx, "2:14").children[0] as any)?.textData?.characters,
    "FromProp",
  );
  eq(
    "prop vs override: explicit override beats the prop",
    (resolveInstance(idx, "2:15").children[0] as any)?.textData?.characters,
    "FromOverride",
  );
}
{
  // INSTANCE_SWAP: the nested instance must be RE-COMPOSED from the swapped master.
  // Guards both traps: the nested `{symbolIdValue:{guid}}` / `{guidValue}` value
  // shapes, and idempotency — without the symbolID rewrite the node recomposes from
  // its ORIGINAL master once per ancestor until the cycle guard emits unresolved.
  const A = { guid: G(1, 600), type: "FRAME", name: "A" };
  const Aglyph = {
    guid: G(1, 601),
    type: "TEXT",
    name: "glyph",
    parentIndex: { guid: G(1, 600), position: "a" },
    textData: { characters: "A" },
  };
  const B = { guid: G(1, 700), type: "FRAME", name: "B" };
  const Bglyph = {
    guid: G(1, 701),
    type: "TEXT",
    name: "glyph",
    parentIndex: { guid: G(1, 700), position: "a" },
    textData: { characters: "B" },
  };
  const O = { guid: G(1, 800), type: "FRAME", name: "O" };
  const Oicon = {
    guid: G(1, 801),
    type: "INSTANCE",
    name: "icon",
    parentIndex: { guid: G(1, 800), position: "a" },
    symbolData: { symbolID: G(1, 600) },
    componentPropRefs: [{ defID: G(1, 810), componentPropNodeField: "OVERRIDDEN_SYMBOL_ID" }],
  };
  const swapValue = { varValue: { value: { symbolIdValue: { guid: G(1, 700) } } } };
  const swapped = {
    guid: G(2, 16),
    type: "INSTANCE",
    name: "swapped",
    symbolData: { symbolID: G(1, 800) },
    componentPropAssignments: [{ defID: G(1, 810), ...swapValue }],
  };
  // One extra instance level, so the swap post-pass runs again at an ancestor.
  const W = { guid: G(1, 900), type: "FRAME", name: "W" };
  const Wo = {
    guid: G(1, 901),
    type: "INSTANCE",
    name: "o",
    parentIndex: { guid: G(1, 900), position: "a" },
    symbolData: { symbolID: G(1, 800) },
    componentPropAssignments: [{ defID: G(1, 810), ...swapValue }],
  };
  const wrapped = {
    guid: G(2, 17),
    type: "INSTANCE",
    name: "wrapped",
    symbolData: { symbolID: G(1, 900) },
  };
  // Default-side coverage: the def itself carries the swap, in the initialValue
  // shape ({guidValue}, one level shallower than varValue's {symbolIdValue:{guid}}).
  const D = {
    guid: G(1, 850),
    type: "FRAME",
    name: "D",
    componentPropDefs: [
      { id: G(1, 860), type: "INSTANCE_SWAP", initialValue: { guidValue: G(1, 700) } },
    ],
  };
  const Dicon = {
    guid: G(1, 851),
    type: "INSTANCE",
    name: "icon",
    parentIndex: { guid: G(1, 850), position: "a" },
    symbolData: { symbolID: G(1, 600) },
    componentPropRefs: [{ defID: G(1, 860), componentPropNodeField: "OVERRIDDEN_SYMBOL_ID" }],
  };
  const byDefault = {
    guid: G(2, 18),
    type: "INSTANCE",
    name: "byDefault",
    symbolData: { symbolID: G(1, 850) },
  };
  const assignmentWins = {
    guid: G(2, 19),
    type: "INSTANCE",
    name: "assignmentWins",
    symbolData: { symbolID: G(1, 850) },
    componentPropAssignments: [
      { defID: G(1, 860), varValue: { value: { symbolIdValue: { guid: G(1, 600) } } } },
    ],
  };
  const idx = makeIndex([
    A,
    Aglyph,
    B,
    Bglyph,
    O,
    Oicon,
    W,
    Wo,
    D,
    Dicon,
    swapped,
    wrapped,
    byDefault,
    assignmentWins,
  ]);
  const unresolvedCount = (n: any): number =>
    (n.unresolved ? 1 : 0) +
    (n.children ?? []).reduce((a: number, c: any) => a + unresolvedCount(c), 0);

  const icon = resolveInstance(idx, "2:16").children[0] as any;
  eq("swap: recomposed from the swapped master", icon?.children?.[0]?.textData?.characters, "B");
  eq("swap: exactly one child (composed once)", icon?.children?.length, 1);
  eq("swap: symbolID repointed at the swap", key(icon?.symbolData?.symbolID), "1:700");
  eq("swap: no unresolved on the swapped node", icon?.unresolved, undefined);

  const nested = resolveInstance(idx, "2:17");
  eq(
    "swap: still swapped one instance level down",
    (nested.children[0] as any)?.children?.[0]?.children?.[0]?.textData?.characters,
    "B",
  );
  eq("swap: idempotent — no cycle from the ancestor re-run", unresolvedCount(nested), 0);

  eq(
    "swap: initialValue {guidValue} shape unwraps",
    (resolveInstance(idx, "2:18").children[0] as any)?.children?.[0]?.textData?.characters,
    "B",
  );
  eq(
    "swap: assignment beats the def default",
    (resolveInstance(idx, "2:19").children[0] as any)?.children?.[0]?.textData?.characters,
    "A",
  );
}
{
  // FIELD_KEYS: fields real exports override that the original list dropped. The
  // per-side border weight and its independence flag must travel together, and a
  // field NOT on the list must still be ignored (guard against copying o wholesale).
  const MF = { guid: G(1, 1000), type: "FRAME", name: "MF" };
  const box = {
    guid: G(1, 1001),
    type: "FRAME",
    name: "box",
    overrideKey: G(16, 1),
    parentIndex: { guid: G(1, 1000), position: "a" },
    styleIdForFill: "master-style",
    borderStrokeWeightsIndependent: false,
    borderTopWeight: 0,
    stackPositioning: "AUTO",
  };
  const inst = {
    guid: G(2, 20),
    type: "INSTANCE",
    name: "card",
    symbolData: {
      symbolID: G(1, 1000),
      symbolOverrides: [
        {
          guidPath: { guids: [G(16, 1)] },
          styleIdForFill: "override-style",
          borderStrokeWeightsIndependent: true,
          borderTopWeight: 4,
          stackPositioning: "ABSOLUTE",
          targetAspectRatio: { x: 1, y: 2 },
          notAFieldWeResolve: "ignored",
        },
      ],
    },
  };
  const b = resolveInstance(makeIndex([MF, box, inst]), "2:20").children[0] as any;
  eq("FIELD_KEYS: styleIdForFill override applied", b?.styleIdForFill, "override-style");
  eq(
    "FIELD_KEYS: per-side weight rides with its independence flag",
    [b?.borderStrokeWeightsIndependent, b?.borderTopWeight],
    [true, 4],
  );
  eq("FIELD_KEYS: stackPositioning override applied", b?.stackPositioning, "ABSOLUTE");
  eq("FIELD_KEYS: targetAspectRatio override applied", b?.targetAspectRatio, { x: 1, y: 2 });
  eq("FIELD_KEYS: unlisted field is not copied", b?.notAFieldWeResolve, undefined);
}

// ── theme-lib: name munging, literals, topo order, emit ──────
{
  // name munging — the ONE rule codegen and theme-gen both consume.
  eq("cssVarName praline", cssVarName("Color/praline/950"), "--color-praline-950");
  eq("cssVarName comma decimal", cssVarName("Numbers/1,5"), "--numbers-1-5");
  eq("treePath splits on slash only (comma stays in leaf)", treePath("Numbers/1,5"), [
    "numbers",
    "1,5",
  ]);
  eq("treePath lowercases first segment only", treePath("Color/praline/950"), [
    "color",
    "praline",
    "950",
  ]);
  eq(
    "tsAccessor bracket for numeric leaf",
    tsAccessor("Color/praline/950"),
    "color.praline['950']",
  );
  eq(
    "tsAccessor bracket for hyphen segment",
    tsAccessor("Typography/line-height/m"),
    "typography['line-height'].m",
  );
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
  check(
    "literalFor non-numeric FLOAT → quoted + warning",
    bad.code === "'alias→7:9'" && !!bad.warning,
    JSON.stringify(bad),
  );
}
const tv = (
  name: string,
  type: string,
  value: string,
  guid: string,
  target?: string,
): ThemeVar => ({
  id: `token:${guid}`,
  name,
  set: "S",
  type,
  modes: { "Mode 1": value },
  guid,
  defaultMode: "Mode 1",
  ...(target ? { aliasTargets: { "Mode 1": target } } : {}),
});
{
  // topo: a→b→c (c concrete) must emit c, then b, then a.
  const a = tv("X/a", "FLOAT", "18", "a", "b");
  const b = tv("X/b", "FLOAT", "18", "b", "c");
  const c = tv("X/c", "FLOAT", "18", "c");
  const { ordered, hadCycle } = topoOrder([a, b, c], "Mode 1");
  eq(
    "topo 2-hop order c,b,a",
    ordered.map((v) => v.guid),
    ["c", "b", "a"],
  );
  check("topo no cycle", hadCycle === false);
}
{
  const n18 = tv("Numbers/18", "FLOAT", "18", "n18");
  const sm = tv("Typography/size/m", "FLOAT", "18", "sm", "n18");
  const pr = tv("Color/praline/950", "COLOR", "#2a1e1e", "pr");
  const fam = tv("Typography/family/Display", "STRING", "Lora", "fam");
  const vars = [pr, n18, sm, fam];
  const web = emitTheme(vars, { framework: "web" });
  check(
    "emit web: alias → var() ref",
    web.code.includes("--typography-size-m: var(--numbers-18)"),
    web.code,
  );
  check(
    "emit web: concrete color literal",
    web.code.includes("--color-praline-950: #2a1e1e"),
    web.code,
  );
  check("emit web: no warnings", web.warnings.length === 0, JSON.stringify(web.warnings));
  const rn = emitTheme(vars, { framework: "rn" });
  check(
    "emit rn: alias const references target",
    rn.code.includes("const Typography_size_m = Numbers_18"),
    rn.code,
  );
  check(
    "emit rn: bracket key for numeric leaf",
    rn.code.includes("'950': Color_praline_950"),
    rn.code,
  );
  check(
    "emit rn: STRING const quoted",
    rn.code.includes("const Typography_family_Display = 'Lora'"),
    rn.code,
  );
  // topological guarantee: a target const is declared BEFORE its referrer.
  check(
    "emit rn: target declared before referrer",
    rn.code.indexOf("const Numbers_18") < rn.code.indexOf("const Typography_size_m") &&
      rn.code.indexOf("const Numbers_18") >= 0,
    rn.code,
  );
  check(
    "emit rn: mode-keyed + defaultMode export",
    rn.code.includes("export const defaultMode = 'Mode 1'") && rn.code.includes("'Mode 1': (() =>"),
    rn.code,
  );
}
{
  // dangling alias (target not in catalog — e.g. soft-deleted) → value fallback + warning.
  const d = tv("X/d", "FLOAT", "99", "d", "missing");
  const web = emitTheme([d], { framework: "web" });
  check("emit dangling: falls back to value", web.code.includes("--x-d: 99"), web.code);
  check(
    "emit dangling: warns",
    web.warnings.some((w) => /dangling/.test(w)),
    JSON.stringify(web.warnings),
  );
}

// ── components-lib: deriveLogicals prop model (synthetic) ──
// Pure transform over synthetic ComponentProp[]; no decode / IR-artifact dependency.
const bind = (node: string, field: string) => [{ node, field }];
{
  // #3 — text + bool(default:true) on the SAME node must NOT collapse: a master-visible
  // node renders at zero props via show<X>=true + a master-default text fallback.
  const { logicals, logicalByDefKey } = deriveLogicals({
    props: [
      {
        name: "header",
        rawName: "Header",
        kind: "boolean",
        defKey: "b1",
        default: true,
        bindings: bind("N1", "visible"),
      },
      {
        name: "baslik",
        rawName: "Başlık",
        kind: "text",
        defKey: "t1",
        default: "Test",
        bindings: bind("N1", "characters"),
      },
    ],
  });
  eq("deriveLogicals: default-true text+bool NOT collapsed (2 props)", logicals.length, 2);
  const showHeader = logicals.find((l) => l.name === "showHeader") as any;
  const baslik = logicals.find((l) => l.name === "baslik") as any;
  check(
    "deriveLogicals: showHeader is bool, defBool=true",
    !!showHeader && showHeader.role === "bool" && showHeader.defBool === true,
    JSON.stringify(showHeader),
  );
  check(
    "deriveLogicals: baslik is text, defText='Test', standalone",
    !!baslik && baslik.role === "text" && baslik.defText === "Test" && baslik.figNames.length === 1,
    JSON.stringify(baslik),
  );
  check(
    "deriveLogicals: both defKeys map (bool→showHeader, text→baslik)",
    logicalByDefKey.get("b1") === showHeader && logicalByDefKey.get("t1") === baslik,
    "",
  );
}
{
  // text + bool(default:false) on the SAME node SHOULD collapse to one optional string
  // (master hides by default → pass a string to show, omit to hide). Behaviour preserved.
  const { logicals, logicalByDefKey } = deriveLogicals({
    props: [
      {
        name: "secondLine",
        rawName: "SecondLine",
        kind: "boolean",
        defKey: "b2",
        default: false,
        bindings: bind("N2", "visible"),
      },
      {
        name: "line2",
        rawName: "Line2",
        kind: "text",
        defKey: "t2",
        default: "Addr",
        bindings: bind("N2", "characters"),
      },
    ],
  });
  eq("deriveLogicals: default-false text+bool collapsed (1 prop)", logicals.length, 1);
  const lg = logicals[0] as any;
  check(
    "deriveLogicals: collapsed → role text, figNames length 2",
    lg.role === "text" && lg.figNames.length === 2,
    JSON.stringify(lg),
  );
  check(
    "deriveLogicals: collapsed → both defKeys map to it",
    logicalByDefKey.get("b2") === lg && logicalByDefKey.get("t2") === lg,
    "",
  );
}
{
  // #3 — standalone bool(default:true) → show<X> carrying defBool for the destructure default.
  const { logicals } = deriveLogicals({
    props: [
      {
        name: "action",
        rawName: "action",
        kind: "boolean",
        defKey: "b3",
        default: true,
        bindings: bind("N3", "visible"),
      },
    ],
  });
  const lg = logicals[0] as any;
  check(
    "deriveLogicals: standalone bool → showAction, role bool, defBool=true",
    lg.name === "showAction" && lg.role === "bool" && lg.defBool === true,
    JSON.stringify(lg),
  );
}
{
  // #2 — instanceSwap carries the default SYMBOL guid so the slot is never silently empty.
  const { logicals } = deriveLogicals({
    props: [
      {
        name: "instance",
        rawName: "Instance",
        kind: "instanceSwap",
        defKey: "s4",
        default: "315:2646",
        bindings: bind("N4", "symbolId"),
      },
    ],
  });
  const lg = logicals[0] as any;
  check(
    "deriveLogicals: instanceSwap → slot, defSym set",
    lg.role === "slot" && lg.defSym === "315:2646",
    JSON.stringify(lg),
  );
}

// ── svg-lib: geometry extraction + recolor + dedup-by-shape (internal icons) ─
{
  // A synthetic decoded index with one VECTOR node "1:1": M0 0 L10 0 Z, solid fill.
  const blob = (() => {
    const bytes: number[] = [];
    const f = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeFloatLE(v);
      bytes.push(b[0], b[1], b[2], b[3]);
    };
    bytes.push(1);
    f(0);
    f(0); // M0 0
    bytes.push(2);
    f(10);
    f(0); // L10 0
    bytes.push(0); // Z
    return { bytes };
  })();
  const mkIndex = (color: { r: number; g: number; b: number; a: number }) => {
    const node: any = {
      guid: { sessionID: 1, localID: 1 },
      type: "VECTOR",
      visible: true,
      opacity: 1,
      size: { x: 24, y: 24 },
      fillGeometry: [{ commandsBlob: 0, windingRule: "NONZERO" }],
      fillPaints: [{ type: "SOLID", visible: true, opacity: 1, color }],
    };
    return { msg: { blobs: [blob] }, byKey: new Map([["1:1", node]]), children: new Map() } as any;
  };
  const geoBlack = extractGeometry(mkIndex({ r: 0, g: 0, b: 0, a: 1 }), "1:1");
  eq("svg: one path extracted", geoBlack.paths.length, 1);
  eq("svg: one distinct fill (mono)", geoBlack.fills.length, 1);
  eq("svg: fill hex from master paint", geoBlack.fills[0], "#000000");
  // viewBox = the icon's natural frame (Figma's exact box, margins intact), expanded only if
  // geometry spills past it. The synthetic line (0,0)-(10,0) sits inside the 24×24 node → the
  // frame is used verbatim (1:1), the glyph keeps its real position. No re-centre, no crop.
  eq("svg: viewBox is the natural frame (1:1)", geoBlack.viewBox, "0 0 24 24");

  const geoRed = extractGeometry(mkIndex({ r: 1, g: 0, b: 0, a: 1 }), "1:1");
  check(
    "svg: geomHash is colour-independent (dedup key)",
    geoBlack.geomHash === geoRed.geomHash,
    `${geoBlack.geomHash} vs ${geoRed.geomHash}`,
  );

  const cc = toSvgString(geoBlack, { recolor: "currentColor" });
  check(
    "svg: currentColor mode recolours",
    /fill="currentColor"/.test(cc) && !/#000000/.test(cc),
    cc.slice(0, 120),
  );
  const pre = toSvgString(geoBlack, { recolor: "preserve" });
  check("svg: preserve mode keeps the hex", /fill="#000000"/.test(pre), pre.slice(0, 120));

  const webMono = emitIconComponent("HouseSimpleIcon", geoBlack, { web: true, mono: true });
  check(
    "svg: web mono icon = currentColor + color prop",
    /fill="currentColor"/.test(webMono) && /style=\{\{ color/.test(webMono),
    webMono.slice(0, 160),
  );
  const rnMono = emitIconComponent("HouseSimpleIcon", geoBlack, { web: false, mono: true });
  check(
    "svg: rn mono icon = react-native-svg + fill={color}",
    /react-native-svg/.test(rnMono) && /fill=\{color\}/.test(rnMono),
    rnMono.slice(0, 160),
  );
}

// ── raw.mts: dispatch smoke (confirms all 8 folded lib imports resolve) ──────
{
  const rawPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli", "raw.mts");
  const r = spawnSync(process.argv[0], [rawPath], { encoding: "utf8" });
  check("raw.mts no-arg → exit 1", r.status === 1, `status ${r.status}`);
  check(
    "raw.mts no-arg → prints usage",
    /usage: raw\.mts/.test(r.stderr ?? ""),
    (r.stderr ?? "").slice(0, 120),
  );
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
