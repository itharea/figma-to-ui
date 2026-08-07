// selftest.mts — runnable regression assertions for the pure libs plus the
// hand-built resolver guards (the Phase 2 §8 cycle / remote-master artifact that
// a real .fig cannot author). Runs under node AND bun:
//   node scripts/selftest.mts [message.json]
//   bun  scripts/selftest.mts [message.json]
// Pure + synthetic checks always run. Live-fixture checks run only when a decode
// is reachable (argv[2], else /tmp/figparse/message_new.json) and skip cleanly
// otherwise. Exits non-zero on any failure. Not imported by anything.
import * as fs from "fs";
import { load, key, I, type Mat } from "./lib/figma-index.mts";
import * as os from "os";
import { normalizeAssetRefs } from "./lib/assetref-lib.mts";
import {
  letterSpacingToPx,
  letterSpacingStr,
  lineHeightPx,
  reconcileTextSize,
  classifyPlaceholderText,
  disambiguateJustify,
} from "./lib/reconcile-lib.mts";
import { resolveInstance } from "./lib/resolve-lib.mts";
import {
  cornerRadiusOf,
  buildScreen,
  provenanceViolations,
  type VarIndex,
  imagePlacement,
  type IRFill,
  buildLayout,
  type IRNode,
} from "./lib/screens-lib.mts";
import {
  overlap,
  overlapArea,
  hasSignificantNonAdjacentOverlap,
  sizingLines,
} from "./lib/layout-lib.mts";
import { assembleTypography } from "./lib/ir-lib.mts";
import {
  cssVarName,
  treePath,
  tsAccessor,
  constIdent,
  literalFor,
  topoOrder,
  emitTheme,
  resolveMode,
  variableUseCensus,
  type ThemeVar,
} from "./lib/theme-lib.mts";
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { extractGeometry, toSvgString, emitIconComponent } from "./lib/svg-lib.mts";
import { deriveLogicals, mapValue, proposePropApi } from "./lib/components-lib.mts";
import {
  slugify,
  uniqueSlug,
  kebab,
  camel,
  compIdent,
  propIdent,
  axisPropNames,
  isSafeIdent,
  RESERVED_WORDS,
} from "./lib/naming.mts";

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

// ── naming: Latin transliteration (#49) ─────────────────────────────────────
// slugify/kebab used to DROP non-ASCII rather than fold it, and their output is not
// internal — kebab feeds mapValue, i.e. the public value union of a generated component,
// and slugify names the files. Whole words were being lost ("öğütücü" → "tc"/"").
for (const [fig, want] of [
  ["öğütücü", "ogutucu"],
  ["sütlaç", "sutlac"],
  ["güllaç", "gullac"],
  ["trileçe", "trilece"],
  ["keşfet", "kesfet"],
  ["açık", "acik"],
  ["hazırlanıyor", "hazirlaniyor"],
  ["iade talebi alındı", "iade-talebi-alindi"],
] as const) {
  eq(`slugify transliterates "${fig}"`, slugify(fig), want);
  eq(`kebab transliterates "${fig}"`, kebab(fig), want);
}
// General Latin, not one language: strokes and ligatures have no NFKD decomposition.
eq("slugify folds strokes + ligatures", slugify("Straße Æther Łódź"), "strasse-aether-lodz");
eq("compIdent transliterates", compIdent("öğütücü seçimi"), "OgutucuSecimi");
eq("mapValue folds a non-ASCII variant value", mapValue("Hazırlanıyor"), "hazirlaniyor");
eq("mapValue keeps its synonyms", mapValue("L"), "large");

// ── naming: identifier sanitisation (#49) ───────────────────────────────────
// An axis / prop name reaches the emitted scaffold as a bare identifier — in the Props
// type, in the destructuring pattern, and in the dispatcher's switch key. "item count"
// (kebab → "item-count") and "in" (reserved) both made the file fail to PARSE.
eq("propIdent: space → camelCase", propIdent("item count"), "itemCount");
eq("propIdent: reserved word suffixed", propIdent("in"), "inProp");
eq("propIdent: reserved word (class)", propIdent("class"), "classProp");
eq("propIdent: leading digit prefixed", propIdent("941"), "prop941");
eq("propIdent: already-safe name unchanged", propIdent("actionText"), "actionText");
eq("propIdent: idempotent", propIdent(propIdent("item count")), "itemCount");
eq("propIdent: transliterates", propIdent("Öğütücü tipi"), "ogutucuTipi");
eq("propIdent: unnameable → prop", propIdent("—"), "prop");
{
  // The cheap end-to-end proof the scaffold parses: every emitted identifier must be
  // bindable. Sweep the whole reserved set plus the shapes seen in real exports.
  const names = [
    ...RESERVED_WORDS,
    "item count",
    "941",
    "—",
    "a/b",
    "iade talebi alındı",
    "Öğütücü",
    "  ",
    "Size / L",
  ];
  const bad = names.filter((n) => !isSafeIdent(propIdent(n)));
  check("propIdent: arbitrary names → bindable identifiers", bad.length === 0, bad.join(", "));
}
{
  // Collision safety: two distinct axes that sanitise alike must NOT merge — merging
  // drops an axis from the type while the dispatcher still composes both values.
  const m = axisPropNames(["item count", "item-count", "in"]);
  eq(
    "axisPropNames: collision → suffixed, never merged",
    [...m.values()],
    ["itemCount", "itemCount2", "inProp"],
  );
  eq("axisPropNames: keyed by the raw axis name", m.get("item-count"), "itemCount2");
}
{
  const api = proposePropApi({
    axes: { type: ["kahve", "seki"], "item count": ["more than 3", "less than 4", "1"] },
    variants: [],
  });
  eq(
    "proposePropApi: axis with a space → a legal identifier",
    api,
    "type: 'kahve' | 'seki'; itemCount: 'more-than-3' | 'less-than-4' | '1'",
  );
  const keys = proposePropApi({ axes: { in: ["a"], "item count": ["b"] }, variants: [] })
    .split(";")
    .map((s) => s.split(":")[0].trim());
  check("proposePropApi: every declared key is bindable", keys.every(isSafeIdent), keys.join(", "));
}
eq(
  "proposePropApi: single axis is still `variant`",
  proposePropApi({ axes: { "item count": ["öğütücü", "sütlaç"] }, variants: [] }),
  "variant: 'ogutucu' | 'sutlac'",
);

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

// ── layout-lib: sizingLines — hug/fill/fixed per CSS axis ────────────────────
{
  // Synthetic IR nodes: a 200×40 box, varied only in the sizing fields under test.
  const node = (p: Partial<IRNode>): IRNode => ({
    id: "n_0",
    path: "/Page/Frame",
    guid: "1:1",
    type: "frame",
    name: "Frame",
    box: { x: 0, y: 0, w: 200, h: 40, absX: 0, absY: 0 },
    children: [],
    ...p,
  });
  const HUG_W = "width: 'fit-content', // hug";
  const HUG_H = "height: 'fit-content', // hug";

  // A ROW stack's PRIMARY axis is horizontal, its COUNTER axis vertical…
  eq(
    "sizing row hug/fixed → hug width, fixed height",
    sizingLines(node({ layout: { mode: "row", primarySizing: "hug", counterSizing: "fixed" } })),
    [HUG_W, "height: 40,"],
  );
  eq(
    "sizing row fixed/hug → fixed width, hug height",
    sizingLines(node({ layout: { mode: "row", primarySizing: "fixed", counterSizing: "hug" } })),
    ["width: 200,", HUG_H],
  );
  // …and a COLUMN stack's is the other way round.
  eq(
    "sizing column hug/fixed → hug height, fixed width",
    sizingLines(node({ layout: { mode: "column", primarySizing: "hug", counterSizing: "fixed" } })),
    ["width: 200,", HUG_H],
  );
  eq(
    "sizing column fixed/hug → hug width, fixed height",
    sizingLines(node({ layout: { mode: "column", primarySizing: "fixed", counterSizing: "hug" } })),
    [HUG_W, "height: 40,"],
  );
  // Both axes fixed → the measured box, exactly as before the fix (regression guard).
  eq(
    "sizing row fixed/fixed → measured box",
    sizingLines(node({ layout: { mode: "row", primarySizing: "fixed", counterSizing: "fixed" } })),
    ["width: 200,", "height: 40,"],
  );

  // FILL: `grow` fills along the PARENT's primary axis, `alignSelf:'stretch'` across its
  // counter one — so which CSS axis is dropped depends on parentMode, not on the node.
  eq(
    "sizing grow in a row parent → width omitted",
    sizingLines(node({ grow: 1, parentMode: "row" })),
    ["height: 40,"],
  );
  eq(
    "sizing grow in a column parent → height omitted",
    sizingLines(node({ grow: 1, parentMode: "column" })),
    ["width: 200,"],
  );
  eq(
    "sizing stretch in a row parent → height omitted",
    sizingLines(node({ alignSelf: "stretch", parentMode: "row" })),
    ["width: 200,"],
  );
  eq(
    "sizing stretch in a column parent → width omitted",
    sizingLines(node({ alignSelf: "stretch", parentMode: "column" })),
    ["height: 40,"],
  );
  // grow + stretch in the same parent fills BOTH axes → nothing to emit.
  eq(
    "sizing grow + stretch → both axes omitted",
    sizingLines(node({ grow: 1, alignSelf: "stretch", parentMode: "row" })),
    [],
  );
  // Fill outranks the node's OWN mode: a hugging row told to grow must not emit hug.
  eq(
    "sizing fill outranks own hug",
    sizingLines(
      node({
        layout: { mode: "row", primarySizing: "hug", counterSizing: "fixed" },
        grow: 1,
        parentMode: "row",
      }),
    ),
    ["height: 40,"],
  );
  // No parentMode ⇒ the parent is not auto-layout, so nothing fills: keep the box.
  eq("sizing grow without parentMode → measured box", sizingLines(node({ grow: 1 })), [
    "width: 200,",
    "height: 40,",
  ]);
  // A plain node with no auto-layout keeps its measured box (unchanged behaviour).
  eq("sizing no layout → measured box", sizingLines(node({})), ["width: 200,", "height: 40,"]);
  // A zero measurement stays omitted, as it always was.
  eq(
    "sizing zero height omitted",
    sizingLines(node({ box: { x: 0, y: 0, w: 200, h: 0, absX: 0, absY: 0 } })),
    ["width: 200,"],
  );

  // TEXT nodes state the same intent in autoResize.
  const text = (autoResize: string | null) => node({ type: "text", name: "Label", autoResize });
  eq("sizing text autoResize HEIGHT → fixed width, hug height", sizingLines(text("HEIGHT")), [
    "width: 200,",
    HUG_H,
  ]);
  eq("sizing text autoResize WIDTH_AND_HEIGHT → hug both", sizingLines(text("WIDTH_AND_HEIGHT")), [
    HUG_W,
    HUG_H,
  ]);
  eq("sizing text autoResize NONE → fixed both", sizingLines(text("NONE")), [
    "width: 200,",
    "height: 40,",
  ]);
  eq("sizing text autoResize absent → fixed both", sizingLines(text(null)), [
    "width: 200,",
    "height: 40,",
  ]);
  // A node whose IR carries no box at all (defensive: the field is schema-required, but
  // sizingLines must never emit `width: undefined`).
  eq("sizing missing box → nothing", sizingLines(node({ box: undefined as any })), []);
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

// ── screens-lib: fill and stroke are independent node paints (both survive) ──
{
  // A node's fill and its stroke live in two SEPARATE paint arrays; collapsing the
  // node to one colour drops whichever loses, and the survivor looks plausible.
  // `bound` binds the paint to a variable, so `hex` must come from the variable's
  // RESOLVED value — never the (deliberately wrong here) cached literal.
  const paint = (v: number, bound?: [number, number]) => ({
    type: "SOLID",
    visible: true,
    color: { r: v, g: v, b: v, a: 1 },
    ...(bound
      ? {
          colorVar: {
            value: { alias: { guid: { sessionID: bound[0], localID: bound[1] } } },
            dataType: "ALIAS",
            resolvedDataType: "COLOR",
          },
        }
      : {}),
  });
  const ir = (fields: any, varIndex: VarIndex = new Map()) =>
    buildScreen(
      {
        guid: "1:10",
        path: "1:10",
        type: "VECTOR",
        name: "glyph",
        size: { x: 24, y: 24 },
        children: [],
        ...fields,
      },
      I,
      {},
      varIndex,
    );

  // regression guard: a fill-only node is untouched — same `color`, no `stroke` key.
  const fillOnly = ir({ fillPaints: [paint(1)] });
  eq("paints: fill-only node keeps its color", fillOnly.color?.hex, "#ffffff");
  eq("paints: fill-only node emits no stroke", fillOnly.stroke, undefined);

  // stroke-only (an outline glyph): the stroke is the node's only colour.
  const strokeOnly = ir({ strokePaints: [paint(0.5)], strokeWeight: 2 });
  eq("paints: stroke-only node emits no color", strokeOnly.color, undefined);
  eq("paints: stroke-only node carries the stroke hex", strokeOnly.stroke?.hex, "#808080");

  // the defect: filled AND outlined, each bound to its OWN token. Both must survive
  // with their own hex and var — the fill must not stand in for the stroke.
  const varIndex: VarIndex = new Map([
    ["9:1", { name: "Color/surface/base", value: "#ffffff" }],
    ["9:2", { name: "Color/border/strong", value: "#333333" }],
  ]);
  const both = ir(
    {
      fillPaints: [paint(0, [9, 1])], // cached literals are stale; the vars win
      strokePaints: [paint(0, [9, 2])],
      strokeWeight: 2,
      strokeAlign: "CENTER",
    },
    varIndex,
  );
  eq(
    "paints: filled+outlined keeps the fill",
    [both.color?.hex, both.color?.var],
    ["#ffffff", "Color/surface/base"],
  );
  eq(
    "paints: filled+outlined keeps the stroke",
    [both.stroke?.hex, both.stroke?.var],
    ["#333333", "Color/border/strong"],
  );
  eq("paints: a bound stroke is match:bound", both.stroke?.match, "bound");
  eq("paints: stroke provenance keys match color's", provenanceViolations(both), []);
  // weight is NOT duplicated onto the node — a 2px outline vs a hairline is read off
  // style.strokes[], which is built from the same paint array and always accompanies it.
  eq("paints: stroke weight readable from style.strokes", both.style?.strokes?.[0]?.weight, 2);

  // visibility: an invisible stroke paint is ignored, and a visible one stacked
  // behind it still wins (paint arrays are stacks, not single slots).
  const hidden = ir({ fillPaints: [paint(1)], strokePaints: [{ ...paint(0), visible: false }] });
  eq("paints: invisible stroke paint is ignored", hidden.stroke, undefined);
  eq("paints: invisible stroke does not disturb the fill", hidden.color?.hex, "#ffffff");
  const stacked = ir({ strokePaints: [{ ...paint(0), visible: false }, paint(0.5)] });
  eq("paints: first VISIBLE stroke paint wins", stacked.stroke?.hex, "#808080");
}

// ── screens-lib: image fill placement (imageScaleMode → background-size) ─────
{
  const img = (extra: Partial<IRFill> = {}): IRFill => ({
    type: "image",
    imageHash: "ab",
    ...extra,
  });
  const css = (f: IRFill) => {
    const p = imagePlacement(f);
    return [p.size, p.repeat, p.resizeMode];
  };
  // The four modes are NOT interchangeable: emitting them all as `cover` scales a
  // STRETCH raster by the larger ratio and crops the overflow by a different amount
  // per source aspect (a 20-variant photo set: 14 STRETCH + 4 FILL visible paints).
  eq("image FILL → cover", css(img({ scaleMode: "FILL" })), ["cover", "no-repeat", "cover"]);
  eq("image FIT → contain", css(img({ scaleMode: "FIT" })), ["contain", "no-repeat", "contain"]);
  eq("image STRETCH → 100% 100%", css(img({ scaleMode: "STRETCH" })), [
    "100% 100%",
    "no-repeat",
    "stretch",
  ]);
  eq("image TILE → repeat + intrinsic size", css(img({ scaleMode: "TILE" })), [
    "auto",
    "repeat",
    "repeat",
  ]);
  eq(
    "image TILE anchors top-left",
    imagePlacement(img({ scaleMode: "TILE" })).position,
    "top left",
  );
  // Regression guard: the previously-correct inputs must not move. An ABSENT mode keeps
  // the historical `cover` (Figma's own default for a new image paint) and stays silent.
  eq("image no mode → cover (unchanged)", css(img()), ["cover", "no-repeat", "cover"]);
  eq("image no mode → no TODO note", imagePlacement(img()).note, undefined);
  eq("image FILL → no TODO note", imagePlacement(img({ scaleMode: "FILL" })).note, undefined);
  eq("image STRETCH → no TODO note", imagePlacement(img({ scaleMode: "STRETCH" })).note, undefined);
  // The three cases CSS cannot express must come back flagged, never silently wrong.
  // STRETCH + a non-null imageTransform is Figma's "Crop" (a 2×3 placement matrix), so
  // `100% 100%` would distort it — approximated as cover and reported.
  const crop = imagePlacement(
    img({
      scaleMode: "STRETCH",
      imageTransform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    }),
  );
  eq("image STRETCH+crop matrix → cover", crop.size, "cover");
  check("image STRETCH+crop matrix → flagged", /crop matrix/.test(crop.note ?? ""), crop.note);
  const tiled = imagePlacement(img({ scaleMode: "TILE", scalingFactor: 0.5 }));
  eq("image TILE factor ≠ 1 → size still auto", tiled.size, "auto");
  check("image TILE factor ≠ 1 → flagged", /scalingFactor 0\.5/.test(tiled.note ?? ""), tiled.note);
  eq(
    "image TILE factor 1 → no note",
    imagePlacement(img({ scaleMode: "TILE", scalingFactor: 1 })).note,
    undefined,
  );
  const unknown = imagePlacement(img({ scaleMode: "SOMETHING_NEW" }));
  eq("image unknown mode → cover default", unknown.size, "cover");
  check(
    "image unknown mode → flagged",
    /unknown imageScaleMode/.test(unknown.note ?? ""),
    unknown.note,
  );
}

// ── screens-lib: stacked image paints — the VISIBLE one wins ────────────────
{
  // Nodes do carry stacked image paints whose first entry is hidden. style.fills[] is a
  // VISIBLE-paint list, so every emitter's "first image fill" is the first VISIBLE one —
  // taking fillPaints[0] off the raw node would extract the wrong raster (and the wrong
  // scale mode with it).
  const IDENT: Mat = [1, 0, 0, 1, 0, 0];
  const rect = (fillPaints: any[]): any => ({
    guid: "1:1",
    path: "Root",
    name: "photo",
    type: "RECTANGLE",
    size: { x: 100, y: 60 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    fillPaints,
    children: [],
  });
  const stacked = buildScreen(
    rect([
      { type: "IMAGE", visible: false, image: { hash: "aaaa" }, imageScaleMode: "FILL" },
      { type: "IMAGE", image: { hash: "bbbb" }, imageScaleMode: "STRETCH" },
    ]),
    IDENT,
  );
  eq("stacked paints: hidden fill dropped", stacked.style?.fills?.length, 1);
  eq("stacked paints: the VISIBLE raster wins", stacked.style?.fills?.[0].imageHash, "bbbb");
  eq("stacked paints: the VISIBLE mode wins", stacked.style?.fills?.[0].scaleMode, "STRETCH");
  // Placement fields are pass-throughs, emitted only where they mean something:
  // scalingFactor for TILE, imageTransform only when non-null.
  const tile = buildScreen(
    rect([{ type: "IMAGE", image: { hash: "cccc" }, imageScaleMode: "TILE", scalingFactor: 0.25 }]),
    IDENT,
  );
  eq("IMAGE paint → placement carried into the IR", tile.style?.fills?.[0], {
    type: "image",
    imageHash: "cccc",
    scaleMode: "TILE",
    scalingFactor: 0.25,
  });
  const plain = buildScreen(
    rect([{ type: "IMAGE", image: { hash: "dddd" }, imageScaleMode: "FILL", scalingFactor: 0.25 }]),
    IDENT,
  );
  eq("non-TILE paint drops the meaningless scalingFactor", plain.style?.fills?.[0], {
    type: "image",
    imageHash: "dddd",
    scaleMode: "FILL",
  });
}

// ── screens-lib: buildLayout sizing defaults (the two axes default OPPOSITELY) ──
{
  // stackPrimarySizing/stackCounterSizing are omit-when-default, so ABSENT is a real
  // value: primary absent ⇒ hug, counter absent ⇒ fixed. All four combinations, on a
  // row — the fallback must depend on the FIELD, never on presence alone.
  eq("sizing both absent → hug / fixed", buildLayout({ stackMode: "HORIZONTAL" }), {
    mode: "row",
    primarySizing: "hug",
    counterSizing: "fixed",
  });
  eq(
    "sizing primary FIXED, counter absent → fixed / fixed",
    buildLayout({ stackMode: "HORIZONTAL", stackPrimarySizing: "FIXED" }),
    { mode: "row", primarySizing: "fixed", counterSizing: "fixed" },
  );
  eq(
    "sizing primary absent, counter RESIZE_TO_FIT → hug / hug",
    buildLayout({ stackMode: "HORIZONTAL", stackCounterSizing: "RESIZE_TO_FIT" }),
    { mode: "row", primarySizing: "hug", counterSizing: "hug" },
  );
  eq(
    "sizing both written → fixed / hug",
    buildLayout({
      stackMode: "HORIZONTAL",
      stackPrimarySizing: "FIXED",
      stackCounterSizing: "RESIZE_TO_FIT",
    }),
    { mode: "row", primarySizing: "fixed", counterSizing: "hug" },
  );
  // The implicit-size variant is still a hug on either axis.
  eq(
    "sizing RESIZE_TO_FIT_WITH_IMPLICIT_SIZE → hug / hug",
    buildLayout({
      stackMode: "HORIZONTAL",
      stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
      stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
    }),
    { mode: "row", primarySizing: "hug", counterSizing: "hug" },
  );
  // Primary/counter are the STACK's own axes: the mapping is identical for a column,
  // so the same raw bytes must not flip meaning with stackMode.
  eq("sizing column both absent → hug / fixed", buildLayout({ stackMode: "VERTICAL" }), {
    mode: "column",
    primarySizing: "hug",
    counterSizing: "fixed",
  });
  eq(
    "sizing column both written → fixed / hug",
    buildLayout({
      stackMode: "VERTICAL",
      stackPrimarySizing: "FIXED",
      stackCounterSizing: "RESIZE_TO_FIT",
    }),
    { mode: "column", primarySizing: "fixed", counterSizing: "hug" },
  );
  // Regression guard: sizing is always emitted, but every other field keeps its
  // omit-when-absent behaviour, and a non-stack node still gets no layout block at all.
  eq(
    "layout keeps omit-when-absent for gap/padding/justify/align/wrap",
    buildLayout({
      stackMode: "HORIZONTAL",
      stackSpacing: 8,
      stackVerticalPadding: 4,
      stackPrimaryAlignItems: "SPACE_BETWEEN",
      stackWrap: "WRAP",
    }),
    {
      mode: "row",
      primarySizing: "hug",
      counterSizing: "fixed",
      gap: 8,
      paddingTop: 4,
      justify: "space-between",
      wrap: true,
    },
  );
  eq("layout absent stackMode → null", buildLayout({ stackMode: "NONE" }), null);
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
  return {
    msg: {} as any,
    nodes,
    byKey,
    children,
    assetRefs: { keyedAssets: 0, rewrites: 0, byField: {}, unresolved: {} },
  };
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

// ── ir-lib: text-style typography bindings live in EITHER consumption map ────
{
  // Figma stores a text style's 5 per-property variable bindings in
  // `variableConsumptionMap` OR `parameterConsumptionMap` depending on how the style was
  // authored — same entry shape either way. Four hand-built styles: bound via the
  // parameter map only, via the variable map only, via both (the variable map must win),
  // and via neither (all 5 null).
  const V = (l: number, name: string) => ({ guid: G(3, l), type: "VARIABLE", name });
  const vars = [
    V(1, "Typography/family/sans"),
    V(2, "Typography/weight/regular"),
    V(3, "Typography/size/m"),
    V(4, "Typography/line-height/m"),
    V(5, "Typography/spacing/m"),
    V(11, "Typography/family/serif"),
    V(12, "Typography/weight/bold"),
    V(13, "Typography/size/l"),
    V(14, "Typography/line-height/l"),
    V(15, "Typography/spacing/l"),
  ];
  // One entry per typography field, aliased to variables G(3, base…base+4). FONT_STYLE
  // nests its alias a level deeper than the rest, exactly as the real format does.
  const entries = (base: number) => [
    { variableField: "FONT_FAMILY", variableData: { value: { alias: { guid: G(3, base) } } } },
    {
      variableField: "FONT_STYLE",
      variableData: {
        value: { fontStyleValue: { asString: { value: { alias: { guid: G(3, base + 1) } } } } },
      },
    },
    { variableField: "FONT_SIZE", variableData: { value: { alias: { guid: G(3, base + 2) } } } },
    { variableField: "LINE_HEIGHT", variableData: { value: { alias: { guid: G(3, base + 3) } } } },
    {
      variableField: "LETTER_SPACING",
      variableData: { value: { alias: { guid: G(3, base + 4) } } },
    },
  ];
  const style = (l: number, name: string, maps: Record<string, unknown>) => ({
    guid: G(4, l),
    type: "STYLE",
    styleType: "TEXT",
    name,
    fontSize: 18,
    fontName: { family: "Sans Placeholder", style: "Regular" },
    lineHeight: { value: 24, units: "PIXELS" },
    ...maps,
  });
  const byName = new Map(
    assembleTypography(
      makeIndex([
        ...vars,
        style(1, "param-only", { parameterConsumptionMap: { entries: entries(1) } }),
        style(2, "var-only", { variableConsumptionMap: { entries: entries(1) } }),
        style(3, "both", {
          parameterConsumptionMap: { entries: entries(11) },
          variableConsumptionMap: { entries: entries(1) },
        }),
        style(4, "unbound", {}),
      ]),
    ).map((t) => [t.name, t.vars]),
  );
  const bound = {
    family: "Typography/family/sans",
    weight: "Typography/weight/regular",
    size: "Typography/size/m",
    lineHeight: "Typography/line-height/m",
    letterSpacing: "Typography/spacing/m",
  };
  const unbound = {
    family: null,
    weight: null,
    size: null,
    lineHeight: null,
    letterSpacing: null,
  };
  eq("typography vars: parameterConsumptionMap alone binds all 5", byName.get("param-only"), bound);
  eq(
    "typography vars: variableConsumptionMap alone still binds all 5",
    byName.get("var-only"),
    bound,
  );
  eq("typography vars: both maps set → variable map wins on all 5", byName.get("both"), bound);
  eq("typography vars: neither map → all 5 null", byName.get("unbound"), unbound);
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

// ── theme-lib: --mode roots the REQUESTED mode (synthetic two-mode catalog) ──
// A variable present in both modes: rooting must pick the requested mode's value, and every
// other mode must survive as a switchable class emitted AFTER :root (equal specificity).
const dual = (name: string, guid: string, a: string, b: string): ThemeVar => ({
  id: `token:${guid}`,
  name,
  set: "S",
  type: "STRING",
  modes: { "Mode 1": a, "Brand / alt": b },
  guid,
  defaultMode: "Mode 1",
});
{
  const vars = [dual("Typography/family/heading", "f1", "Alpha", "Beta")];
  const base = emitTheme(vars, { framework: "web" });
  check(
    "emit web: no --mode keeps the collection default rooted",
    /:root \{\n  --typography-family-heading: Alpha;/.test(base.code),
    base.code,
  );
  check(
    "emit web: no --mode still emits the other mode as a class",
    base.code.includes(".mode-brand-alt {"),
    base.code,
  );
  const picked = emitTheme(vars, { framework: "web", activeMode: "Brand / alt" });
  check(
    "emit web: --mode roots the REQUESTED mode",
    /:root \{\n  --typography-family-heading: Beta;/.test(picked.code),
    picked.code,
  );
  check(
    "emit web: the unrooted mode is still emitted as a class",
    /\.mode-mode-1 \{\n  --typography-family-heading: Alpha;/.test(picked.code),
    picked.code,
  );
  check(
    "emit web: the class block comes AFTER :root so the opt-in can win",
    picked.code.indexOf(":root {") < picked.code.indexOf(".mode-mode-1 {"),
    picked.code,
  );
  const rn = emitTheme(vars, { framework: "rn", activeMode: "Brand / alt" });
  check(
    "emit rn: --mode drives defaultMode, both modes kept",
    rn.code.includes("export const defaultMode = 'Brand / alt'") &&
      rn.code.includes("'Mode 1': (() =>"),
    rn.code,
  );
  // a mode name is free text: the slug the CSS advertises must select it back.
  eq(
    "resolveMode by slug",
    resolveMode(["Mode 1", "Brand / alt"], "brand-alt").mode,
    "Brand / alt",
  );
  eq("resolveMode case-insensitive", resolveMode(["Mode 1"], "mode 1").mode, "Mode 1");
  const miss = resolveMode(["Mode 1", "Brand / alt"], "Nope");
  eq(
    "resolveMode unknown reports, never falls back",
    [miss.mode, (miss as any).reason],
    [null, "unknown"],
  );
  const unknown = emitTheme(vars, { framework: "web", activeMode: "Nope" });
  check(
    "emit web: an unmatched mode warns instead of silently rooting the default",
    unknown.warnings.some((w) => /requested mode "Nope" is unknown/.test(w)),
    JSON.stringify(unknown.warnings),
  );
}

// ── theme-lib: live-use census settles duplicate names ──
// A renumbered scale can leave superseded variables behind under the SAME name; reference
// count from non-VARIABLE nodes is the only thing in the bytes that tells them apart.
{
  const g = (s: number, l: number) => ({ sessionID: s, localID: l });
  const nodes = [
    // the two same-named variables themselves — a VARIABLE never votes for another variable
    { guid: g(1, 128), type: "VARIABLE", name: "T/size/xs" },
    { guid: g(129, 3353), type: "VARIABLE", name: "T/size/xs" },
    // a text style binding the live one (deep FONT_STYLE-shaped nesting) …
    {
      guid: g(5, 1),
      type: "TEXT",
      variableConsumptionMap: {
        entries: [
          {
            variableField: "FONT_SIZE",
            variableData: { value: { alias: { guid: g(129, 3353) } } },
          },
        ],
      },
    },
    // … and a paint binding it too (the other binding shape).
    {
      guid: g(5, 2),
      type: "FRAME",
      fillPaints: [{ colorVar: { value: { alias: { guid: g(129, 3353) } } } }],
    },
  ];
  const census = variableUseCensus(nodes);
  eq("census counts every binding shape", census.get("129:3353"), 2);
  eq("census: the superseded variable has zero references", census.get("1:128"), undefined);

  const dead = tv("T/size/xs", "FLOAT", "14", "1:128");
  const live = tv("T/size/xs", "FLOAT", "16", "129:3353");
  // DECLARATION ORDER MUST NOT MATTER — the whole defect was that it did.
  const orders: [string, ThemeVar[]][] = [
    ["dead first", [dead, live]],
    ["live first", [live, dead]],
  ];
  for (const [label, vars] of orders) {
    const web = emitTheme(vars, { framework: "web", uses: census });
    check(
      `census (${label}): the live variable takes the canonical name`,
      web.code.includes("--t-size-xs: 16"),
      web.code,
    );
    check(
      `census (${label}): the zero-reference duplicate is dropped, not suffixed`,
      !web.code.includes("--t-size-xs-2"),
      web.code,
    );
    eq(
      `census (${label}): the drop is reported`,
      web.dropped.map((d) => [d.name, d.guid, d.keptGuid]),
      [["T/size/xs", "1:128", "129:3353"]],
    );
  }
  // no census → nothing is dropped, but the tie-break is the guid (later-created wins),
  // never array order: both orderings must agree.
  const a = emitTheme([dead, live], { framework: "web" });
  const b = emitTheme([live, dead], { framework: "web" });
  check(
    "no census: tie breaks on guid, not declaration order",
    a.code.includes("--t-size-xs: 16") && b.code.includes("--t-size-xs: 16"),
    a.code + b.code,
  );
  check(
    "no census: the duplicate is kept and suffixed (nothing lost)",
    a.dropped.length === 0 && a.code.includes("--t-size-xs-2: 14"),
    a.code,
  );
  check(
    "no census: the suffixing still warns",
    a.warnings.some((w) => /name collision/.test(w)),
    JSON.stringify(a.warnings),
  );
  // a duplicate that ANOTHER variable aliases is live even with zero direct references.
  const aliased = tv("T/size/s", "FLOAT", "18", "2:1");
  const usedTwin = tv("T/size/s", "FLOAT", "20", "3:1");
  const referrer = tv("T/size/alias", "FLOAT", "18", "4:1", "2:1");
  const guarded = emitTheme([aliased, usedTwin, referrer], {
    framework: "web",
    uses: new Map([
      ["3:1", 4],
      ["4:1", 1],
    ]),
  });
  eq("census: an alias target is never dropped", guarded.dropped.length, 0);
  check(
    "census: the referenced twin still takes the canonical name",
    guarded.code.includes("--t-size-s: 20") && guarded.code.includes("--t-size-s-2: 18"),
    guarded.code,
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
{
  // #49 — a component prop is free to be named `in`. It lands in a destructuring pattern
  // (`function X({ header, in })`), which is a SyntaxError, so the prop model must
  // sanitise; two props that sanitise alike must still stay distinct.
  const { logicals } = deriveLogicals({
    props: [
      {
        name: "in",
        rawName: "in",
        kind: "text",
        defKey: "t5",
        default: null,
        bindings: bind("N5", "characters"),
      },
      {
        name: "In",
        rawName: "In",
        kind: "instanceSwap",
        defKey: "s5",
        default: null,
        bindings: bind("N6", "symbolId"),
      },
      {
        name: "item count",
        rawName: "item count",
        kind: "text",
        defKey: "t6",
        default: "2",
        bindings: bind("N7", "characters"),
      },
    ],
  });
  eq(
    "deriveLogicals: reserved name suffixed, collision de-duped",
    logicals.map((l) => l.name),
    ["inProp", "inProp2", "itemCount"],
  );
  const bad = logicals.filter((l) => !isSafeIdent(l.name)).map((l) => l.name);
  check("deriveLogicals: every emitted prop name is bindable", bad.length === 0, bad.join(", "));
  check(
    "deriveLogicals: raw Figma names kept for traceability",
    logicals.every((l) => l.figNames.length > 0),
    JSON.stringify(logicals.map((l) => l.figNames)),
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

  // A glyph that is BOTH filled and outlined: the pre-outlined strokeGeometry is a
  // second baked paint, so the extraction yields two distinct fills and the emitted
  // component must keep BOTH. Driving it mono (the old fills-only paint count) would
  // recolour the outline to the fill via currentColor and lose the outline entirely.
  const outlined: any = {
    guid: { sessionID: 1, localID: 1 },
    type: "VECTOR",
    visible: true,
    opacity: 1,
    size: { x: 24, y: 24 },
    fillGeometry: [{ commandsBlob: 0, windingRule: "NONZERO" }],
    fillPaints: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
    strokeGeometry: [{ commandsBlob: 0, windingRule: "NONZERO" }],
    strokePaints: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 0.2, g: 0.2, b: 0.2 } }],
    strokeWeight: 2,
  };
  const geoBoth = extractGeometry(
    { msg: { blobs: [blob] }, byKey: new Map([["1:1", outlined]]), children: new Map() } as any,
    "1:1",
  );
  eq("svg: filled+outlined glyph has two distinct paints", geoBoth.fills, ["#ffffff", "#333333"]);
  const webMulti = emitIconComponent("OutlinedIcon", geoBoth, { web: true, mono: false });
  check(
    "svg: filled+outlined icon bakes BOTH paints (no currentColor flattening)",
    /fill="#ffffff"/.test(webMulti) &&
      /fill="#333333"/.test(webMulti) &&
      !/currentColor/.test(webMulti),
    webMulti.slice(0, 400),
  );
}

// ── svg-lib: mask nodes are a clip region, never paint ──────────────────────
{
  // Figma's SVG importer wraps pasted artwork in a clip-path group: a mask node whose only
  // child is a full-bounds rectangle filled opaque black. Walking into it painted that
  // rectangle straight over the real artwork. Synthetic reproduction of that exact shape.
  const polyBlob = (pts: [number, number][]) => {
    const bytes: number[] = [];
    const f = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeFloatLE(v);
      bytes.push(b[0], b[1], b[2], b[3]);
    };
    pts.forEach(([x, y], i) => {
      bytes.push(i === 0 ? 1 : 2); // M, then L…
      f(x);
      f(y);
    });
    bytes.push(0); // Z
    return { bytes };
  };
  const W = 350,
    H = 148;
  const blobs = [
    polyBlob([
      [10, 10],
      [90, 10],
      [90, 90],
    ]), // 0: the real artwork
    polyBlob([
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ]), // 1: full-bounds clip rectangle
    polyBlob([
      [0, 0],
      [W / 2, 0],
      [W / 2, H],
      [0, H],
    ]), // 2: rect covering only half the frame
    polyBlob([
      [0, 0],
      [W, 0],
      [W / 2, H],
    ]), // 3: a triangular (non-rectangular) reveal
  ];
  const vector = (localID: number, blobIdx: number, color: any) => ({
    guid: { sessionID: 1, localID },
    type: "VECTOR",
    visible: true,
    opacity: 1,
    fillGeometry: [{ commandsBlob: blobIdx, windingRule: "NONZERO" }],
    fillPaints: [{ type: "SOLID", visible: true, opacity: 1, color }],
  });
  const cream = { r: 247 / 255, g: 242 / 255, b: 237 / 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  // root FRAME → [ artwork VECTOR, mask GROUP → clip VECTOR ]
  const mkIndex = (opts: { mask: boolean | undefined; clipBlob: number; withMask: boolean }) => {
    const root: any = {
      guid: { sessionID: 1, localID: 1 },
      type: "FRAME",
      visible: true,
      opacity: 1,
      size: { x: W, y: H },
    };
    const art = vector(2, 0, cream);
    const group: any = {
      guid: { sessionID: 1, localID: 3 },
      type: "GROUP",
      name: "Clip path group",
      visible: true,
      opacity: 1,
      mask: opts.mask,
    };
    const clip = vector(4, opts.clipBlob, black);
    const nodes: any[] = opts.withMask ? [root, art, group, clip] : [root, art];
    const byKey = new Map(nodes.map((n) => [key(n.guid), n]));
    const children = new Map<string, any[]>([["1:1", opts.withMask ? [art, group] : [art]]]);
    if (opts.withMask) children.set("1:3", [clip]);
    return { msg: { blobs }, byKey, children } as any;
  };
  // Warnings are the lib's only side effect — capture them so a run stays quiet and the
  // detect-and-warn path can be asserted directly.
  const warnsOf = (fn: () => void): string[] => {
    const orig = console.error;
    const seen: string[] = [];
    console.error = (...a: any[]) => void seen.push(a.join(" "));
    try {
      fn();
    } finally {
      console.error = orig;
    }
    return seen;
  };

  let masked!: ReturnType<typeof extractGeometry>;
  const maskWarns = warnsOf(() => {
    masked = extractGeometry(mkIndex({ mask: true, clipBlob: 1, withMask: true }), "1:1");
  });
  eq("svg mask: clip subtree is not painted", masked.paths.length, 1);
  eq("svg mask: no spurious black in fills", masked.fills, ["#f7f2ed"]);
  eq("svg mask: full-bounds rectangular mask is silent", maskWarns, []);

  // The guard must be exactly equivalent to the mask subtree not existing — byte-identical
  // paths, viewBox and dedup hash, so a mask can never perturb the surrounding artwork.
  const bare = extractGeometry(mkIndex({ mask: true, clipBlob: 1, withMask: false }), "1:1");
  eq("svg mask: skipping ≡ absent (paths)", masked.paths, bare.paths);
  eq("svg mask: skipping ≡ absent (viewBox)", masked.viewBox, bare.viewBox);
  eq("svg mask: skipping ≡ absent (geomHash)", masked.geomHash, bare.geomHash);

  // Regression guard: the guard keys on `mask === true` only. An ordinary black rectangle in
  // the same position is real artwork and must still be emitted, unchanged.
  for (const [label, mask] of [
    ["absent", undefined],
    ["false", false],
  ] as const) {
    const geo = extractGeometry(mkIndex({ mask, clipBlob: 1, withMask: true }), "1:1");
    eq(`svg mask: mask ${label} → art still painted (paths)`, geo.paths.length, 2);
    eq(`svg mask: mask ${label} → art still painted (fills)`, geo.fills, ["#f7f2ed", "#000000"]);
  }

  // Skipping without applying the clip is only lossless for a full-bounds rectangle. A reveal
  // that is smaller, or not a rectangle at all, is still skipped (we cannot emit a <clipPath>)
  // but must not do so silently — the art it masked comes out uncropped.
  for (const [label, clipBlob] of [
    ["half-width rect", 2],
    ["triangle", 3],
  ] as const) {
    let geo!: ReturnType<typeof extractGeometry>;
    const warns = warnsOf(() => {
      geo = extractGeometry(mkIndex({ mask: true, clipBlob, withMask: true }), "1:1");
    });
    eq(`svg mask: ${label} reveal still skipped`, geo.paths.length, 1);
    check(
      `svg mask: ${label} reveal warns on stderr`,
      warns.length === 1 && /not a full-bounds rectangle/.test(warns[0]),
      JSON.stringify(warns),
    );
  }
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

// ── codegen --images: raster refs resolve against the MODULE, not the page ───
// The emission lives in the CLI itself (nodeStyleBody + variantFile close over the parsed
// flags), so this drives the real binary over a SYNTHETIC IR + images dir and asserts on the
// emitted variant files. Covers both halves of the defect: the document-relative URL, and
// the `background` shorthand sitting next to the `backgroundImage` longhand — React patches
// only the keys whose values changed, so re-applying the shorthand on a variant change
// silently resets background-image to none.
{
  const codegenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli", "codegen.mts");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f2u-codegen-"));
  try {
    // Two rasters whose content hashes share a long prefix: the import identifier derived
    // from a hash-named file has to stay unique (and a valid identifier) even then.
    const hashA = "aaaaaaaaaaaa1111";
    const hashB = "aaaaaaaaaaaa2222";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // magic bytes only
    const imagesDir = path.join(tmp, "images");
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, hashA), png); // extension-less, as the .fig stores it
    fs.writeFileSync(path.join(imagesDir, hashB), png);

    const irDir = path.join(tmp, "ir");
    fs.mkdirSync(path.join(irDir, "components"), { recursive: true });
    fs.mkdirSync(path.join(irDir, "screens"), { recursive: true });
    const box = (w: number, h: number) => ({ x: 0, y: 0, w, h });
    // variant "photo": root carries a solid fill AND an image fill (the shorthand trap),
    // its child carries a second, distinct image fill (the identifier-collision case).
    const child = {
      id: "n_photo",
      path: "/photo",
      guid: "1:11",
      type: "frame",
      name: "Photo",
      box: box(100, 60),
      style: { fills: [{ type: "image", imageHash: hashB }] },
      children: [],
    };
    const photoVariant = {
      id: "n_a",
      path: "/a",
      guid: "1:10",
      type: "frame",
      name: "Tile",
      box: box(100, 100),
      style: {
        fills: [
          { type: "solid", hex: "#ff0000" },
          { type: "image", imageHash: hashA },
        ],
      },
      children: [child],
    };
    // variant "plain": a solid fill and nothing else — the regression guard.
    const plainVariant = {
      id: "n_b",
      path: "/b",
      guid: "1:20",
      type: "frame",
      name: "Tile",
      box: box(100, 100),
      style: { fills: [{ type: "solid", hex: "#00ff00" }] },
      children: [],
    };
    fs.writeFileSync(
      path.join(irDir, "screens", "s.json"),
      JSON.stringify({
        id: "n_root",
        path: "/",
        guid: "1:0",
        type: "frame",
        name: "Screen",
        box: box(400, 400),
        children: [photoVariant, plainVariant],
      }),
    );
    fs.writeFileSync(
      path.join(irDir, "manifest.json"),
      JSON.stringify({ artifacts: { screens: ["screens/s.json"] } }),
    );
    fs.writeFileSync(
      path.join(irDir, "components", "tile.json"),
      JSON.stringify({
        name: "Tile",
        guid: "1:1",
        axes: { State: ["photo", "plain"] },
        variants: [
          { guidKey: "1:10", props: { State: "photo" }, rawName: "State=photo", bindings: [] },
          { guidKey: "1:20", props: { State: "plain" }, rawName: "State=plain", bindings: [] },
        ],
      }),
    );

    const run = (out: string, extra: string[]) =>
      spawnSync(
        process.argv[0],
        [
          codegenPath,
          irDir,
          "Tile",
          "--framework",
          "web",
          "--out",
          out,
          "--images",
          imagesDir,
          ...extra,
        ],
        { encoding: "utf8" },
      );
    const read = (out: string, file: string) => {
      const p = path.join(out, "tile", file);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    };

    const outBundler = path.join(tmp, "out-bundler");
    const rb = run(outBundler, []);
    check("codegen --images: run exits 0", rb.status === 0, (rb.stderr ?? "").slice(-300));
    const photoFile = read(outBundler, "photo.tsx");
    const plainFile = read(outBundler, "plain.tsx");

    check(
      "codegen --images: image fill emits a static import, not a page-relative url",
      /^import asset_aaaaaaaaaaaa from '\.\/assets\/aaaaaaaaaaaa1111\.png';$/m.test(photoFile) &&
        !/url\('\.\/assets\//.test(photoFile),
      photoFile.slice(0, 400),
    );
    check(
      "codegen --images: backgroundImage reads the bundler-resolved url",
      photoFile.includes("backgroundImage: `url(${assetUrl(asset_aaaaaaaaaaaa)})`,"),
      photoFile.slice(0, 400),
    );
    check(
      "codegen --images: the url helper accepts a string OR a .src record",
      /typeof a === 'string' \? a : a\.src/.test(photoFile),
      photoFile.slice(0, 400),
    );
    {
      const idents = [...photoFile.matchAll(/^import (\S+) from '\.\/assets\/(\S+)';$/gm)].map(
        (m) => m[1],
      );
      eq("codegen --images: one import per distinct raster", idents.length, 2);
      check(
        "codegen --images: colliding hash prefixes get distinct valid identifiers",
        new Set(idents).size === idents.length &&
          idents.every((i) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(i)),
        idents.join(", "),
      );
    }
    check(
      "codegen: image + solid fill emits backgroundColor, never the background shorthand",
      /backgroundColor: '#ff0000',/.test(photoFile) && !/\bbackground:/.test(photoFile),
      photoFile.slice(0, 400),
    );
    check(
      "codegen: a solid-only fill still emits the web background shorthand",
      /\bbackground: '#00ff00',/.test(plainFile),
      plainFile.slice(0, 400),
    );

    const outCss = path.join(tmp, "out-css");
    const rc = run(outCss, ["--asset-base", "/static/img/"]);
    check("codegen --asset-base: run exits 0", rc.status === 0, (rc.stderr ?? "").slice(-300));
    const cssPhoto = read(outCss, "photo.tsx");
    check(
      "codegen --asset-base: literal url under the configured base, no import",
      cssPhoto.includes(`backgroundImage: "url('/static/img/aaaaaaaaaaaa1111.png')",`) &&
        !/from '\.\/assets\//.test(cssPhoto),
      cssPhoto.slice(0, 400),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── assetref-lib: published-library assetRef bindings → local guids ──────────
// A .fig that subscribes to its own published library addresses every binding by
// `{assetRef:{key,version}}`; every resolver in lib/ reads `.guid`. These build both
// shapes by hand — the live-fixture path can only ever exercise whichever one the
// decode at hand happens to use.
{
  const g = (localID: number) => ({ sessionID: 7, localID });
  const msg: any = {
    nodeChanges: [
      { guid: g(10), type: "VARIABLE", key: "KEY_COLOR", name: "a" },
      { guid: g(11), type: "VARIABLE_SET", key: "KEY_SET", name: "b" },
      { guid: g(12), type: "TEXT", key: "KEY_TYPE", name: "c" },
      {
        guid: g(20),
        type: "SYMBOL",
        // every binding site the format puts an alias at, in its assetRef shape
        fillPaints: [
          { colorVar: { value: { alias: { assetRef: { key: "KEY_COLOR", version: "v1" } } } } },
          { colorVar: { value: { alias: { assetRef: { key: "KEY_MISSING", version: "v1" } } } } },
        ],
        variableConsumptionMap: {
          entries: [
            { fields: [{ fieldName: 5, value: { alias: { assetRef: { key: "KEY_COLOR" } } } }] },
          ],
        },
        styleIdForText: { assetRef: { key: "KEY_TYPE" } },
        variableSetID: { assetRef: { key: "KEY_SET" } },
      },
      {
        guid: g(21),
        type: "SYMBOL",
        // already re-addressed (or authored guid-first): the existing guid must win
        styleIdForText: { guid: g(99), assetRef: { key: "KEY_TYPE" } },
      },
    ],
  };
  const rep = normalizeAssetRefs(msg);
  const sym = msg.nodeChanges[3];

  eq("assetref: keyed local assets mapped", rep.keyedAssets, 3);
  eq("assetref: rewrites counted", rep.rewrites, 4);
  // (a) a key that resolves locally gains a sibling guid …
  eq("assetref: fillPaints colorVar alias resolved", sym.fillPaints[0].colorVar.value.alias.guid, {
    sessionID: 7,
    localID: 10,
  });
  // … and the original assetRef survives (non-destructive re-addressing)
  eq(
    "assetref: assetRef kept alongside guid",
    sym.fillPaints[0].colorVar.value.alias.assetRef.key,
    "KEY_COLOR",
  );
  // (d) nested objects, arrays and map-shaped fields are all reached
  eq(
    "assetref: consumption-map entry resolved",
    sym.variableConsumptionMap.entries[0].fields[0].value.alias.guid,
    { sessionID: 7, localID: 10 },
  );
  eq("assetref: styleIdForText resolved", sym.styleIdForText.guid, { sessionID: 7, localID: 12 });
  eq("assetref: variableSetID resolved", sym.variableSetID.guid, { sessionID: 7, localID: 11 });
  eq(
    "assetref: field trail reported per site",
    rep.byField["SYMBOL/fillPaints[]/colorVar/value/alias"],
    1,
  );
  // (b) a key naming no local node is left alone and reported, never invented
  eq(
    "assetref: unresolvable key untouched",
    sym.fillPaints[1].colorVar.value.alias.guid,
    undefined,
  );
  eq("assetref: unresolvable key reported", rep.unresolved["KEY_MISSING"], 1);
  // (c) an existing guid is never overwritten
  eq("assetref: existing guid wins", msg.nodeChanges[4].styleIdForText.guid, {
    sessionID: 7,
    localID: 99,
  });
  // idempotent — a second pass has nothing left to do
  eq("assetref: re-run rewrites nothing", normalizeAssetRefs(msg).rewrites, 0);
}
{
  // (e) a guid-addressed export must come through byte-identical, even when its nodes do
  // publish keys (a library file binding its own assets locally).
  const g = (localID: number) => ({ sessionID: 3, localID });
  const msg: any = {
    nodeChanges: [
      { guid: g(1), type: "VARIABLE", key: "KEY_COLOR", name: "a" },
      {
        guid: g(2),
        type: "SYMBOL",
        fillPaints: [{ colorVar: { value: { alias: { guid: g(1) } } } }],
        styleIdForText: { guid: g(1) },
      },
    ],
  };
  const before = JSON.stringify(msg);
  const rep = normalizeAssetRefs(msg);
  eq("assetref: guid-addressed export unchanged", JSON.stringify(msg), before);
  eq("assetref: guid-addressed export has no rewrites", rep.rewrites, 0);
  eq("assetref: guid-addressed export has no unresolved", Object.keys(rep.unresolved).length, 0);
}
{
  // The rewrite is unconditional: it must happen for anything that loads a message, not
  // only for callers that remember to run the diagnostic CLI.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figselftest-"));
  const p = path.join(dir, "message.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      nodeChanges: [
        { guid: { sessionID: 1, localID: 1 }, type: "VARIABLE", key: "KEY_COLOR", name: "a" },
        {
          guid: { sessionID: 1, localID: 2 },
          type: "SYMBOL",
          fillPaints: [{ colorVar: { value: { alias: { assetRef: { key: "KEY_COLOR" } } } } }],
        },
      ],
    }),
  );
  const idx = load(p);
  eq("assetref: load() applies the rewrite", idx.assetRefs.rewrites, 1);
  eq(
    "assetref: load() exposes the resolved guid",
    idx.byKey.get("1:2").fillPaints[0].colorVar.value.alias.guid,
    { sessionID: 1, localID: 1 },
  );
  fs.rmSync(dir, { recursive: true, force: true });
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
