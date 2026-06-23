// IR screen pass (Phase 7 / IR-PLAN Phase 2) — reconcile once, with provenance.
// Walks the RESOLVED tree (resolve-lib) and bakes the truth into clean fields PLUS
// provenance: {value, source, conflicts[]} on every reconciled field and a `guid`
// on every node. NO top-level side effects — build-ir.mts imports buildScreen().
//
// Determinism contract (README): DETECTION always runs and is exact (instance
// composition by explicit guidPath, conflict detection arithmetic, unit
// conversion, abs coords, and Figma's OWN render in `derivedTextData` — used as
// ground truth for font family/size/lineHeight when the node-level fontName cache
// is detectably stale, sizeSource="derived"). RESOLUTION is a labelled heuristic
// (geometry-16 over declared-28, placeholder classification) — it sets `source`/
// `*Source` and populates `conflicts[]`, and is NEVER presented as ground truth.
// Token slots
// (`color.{token,match}`, `font.{sizeToken,sizeMatch}`) stay null here; Phase 8's
// --theme fills them.
import * as crypto from "crypto";
import { colorStr, mul, nodeMat, type Mat } from "./lib.mts";
import {
  reconcileTextSize,
  deriveFontFromRender,
  letterSpacingToPx,
  lineHeightPx,
  classifyPlaceholderText,
  type Conflict,
} from "./reconcile-lib.mts";
import type { ResolvedNode } from "./resolve-lib.mts";
import type { IRTypography, TypeVars } from "./ir-lib.mts";

// --- IR node shape (matches phase-07 §5) -----------------------------------
export type IRTextField = {
  value: string;
  source: "override" | "master-default";
  placeholder: boolean;
  reason: string;
  // text transform & alignment (improvement 2-text) — PURE pass-throughs of the
  // resolved bytes, emitted ONLY when present/non-default so per-screen files stay
  // lean. resolve-lib FIELD_KEYS already carries textCase/textAlignHorizontal/
  // textAlignVertical through instance overrides, so they are correct on the
  // resolved node. fig→CSS mapping (see textCaseToCss / textAlignToCss):
  //   textCase UPPER→"uppercase", LOWER→"lowercase", TITLE→"capitalize",
  //     SMALL_CAPS→"uppercase" (CSS has no exact equivalent; font-variant TODO),
  //     ORIGINAL→omitted. Confirmed enum in this decode: TITLE, UPPER.
  //   textAlignHorizontal LEFT→omitted (CSS default), CENTER→"center",
  //     RIGHT→"right", JUSTIFIED→"justify". Confirmed enum: CENTER only.
  //   textAlignVertical TOP→omitted (default), CENTER→"center", BOTTOM→"bottom"
  //     (vertical alignment — no single CSS prop; consumers map via flex). Raw
  //     enum lower-cased. Confirmed enum: TOP, CENTER.
  //   leadingTrim (optional) raw enum lower-cased (e.g. CAP_HEIGHT→"cap_height").
  case?: string; // CSS text-transform value (uppercase|lowercase|capitalize)
  align?: string; // CSS text-align value (center|right|justify)
  alignVertical?: string; // vertical alignment (center|bottom), lower-cased raw
  leadingTrim?: string; // raw leadingTrim enum, lower-cased (optional)
};
export type IRFont = {
  family: string | null;
  appFamily: string | null;
  weight: string | null;
  size: number;
  // Where size/lineHeight came from, most-certain first: "style" = the applied text
  // style (styleIdForText → typography token, designer intent); "derived" = Figma's own
  // render (derivedTextData); "fontSize" = the node's declared cache, taken as-is;
  // "geometry" = the box-vs-lineHeight HEURISTIC (last resort, only when no certain
  // source covers the field).
  sizeSource: "fontSize" | "geometry" | "derived" | "style";
  sizeToken: string | null;
  sizeMatch: string | null;
  // The applied Figma text style (styleIdForText) — the typography DESIGN TOKEN this
  // node binds to. GROUND TRUTH from the bytes, the typography analogue of a color's
  // var/varGuid: a real implementation should reference this token instead of the
  // hardcoded family/size/weight/lineHeight/textCase. null when no shared style applies.
  styleName: string | null;
  styleGuid: string | null;
  // Per-property variable bindings carried from that style (family/size/lineHeight/…
  // each → its own Figma variable name) — so each property can bind to a variable, not
  // just the style as a whole. null when no shared style applies.
  vars: TypeVars | null;
  lineHeightPx: number | null;
  lineHeightSource: "fontSize" | "derived" | "style";
  letterSpacingPx: number;
  letterSpacingRaw: { value: number; units: string };
  conflicts: Conflict[];
};
// `var`/`varGuid`: the design-system token a fill is BOUND to via a Figma variable
// alias (paint.colorVar). This is GROUND TRUTH from the bytes (not value-matching):
// when set, `match` is "bound". `token`/`match` value-matching (Phase 8 --theme)
// stays for UNBOUND literals only. `hex` is always the resolved concrete value.
export type IRColor = {
  hex: string | null;
  token: string | null;
  match: string | null;
  var: string | null; // bound design-token name, or null for a literal fill
  varGuid: string | null; // the variable guidKey, or null
};

// Side-effect-free resolver: given a paint and a variable index (guidKey →
// tokenName), return the bound token if the paint carries a colorVar ALIAS that
// resolves in the index, else null. Confirmed field shape (node.mts):
//   paint.colorVar = { value:{ alias:{ guid:{sessionID,localID} } }, dataType:"ALIAS", resolvedDataType:"COLOR" }
export function colorVarToken(
  paint: any,
  varIndex: Map<string, string>
): { var: string; varGuid: string } | null {
  const alias = paint?.colorVar?.value?.alias;
  const g = alias?.guid;
  if (!g || g.sessionID === undefined || g.localID === undefined) return null;
  const varGuid = `${g.sessionID}:${g.localID}`;
  const name = varIndex.get(varGuid);
  if (name === undefined) return null;
  return { var: name, varGuid };
}
export type IRBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  absX: number;
  absY: number;
};

// --- full box styling + auto-layout (improvement B-style-layout / spec #2) ----
// Carries the COMPLETE box-styling and auto-layout picture so the IR alone
// suffices for a 1:1 implementation (parity with the raw dump / SKILL §4). Blocks
// are OMITTED when a node has none, so files stay lean. Bound fill/stroke colors
// carry their design token (var/varGuid) via Phase A's resolver — GROUND TRUTH.
export type IRFill = {
  type: "solid" | "gradient" | "image";
  hex?: string | null; // solid: resolved concrete value
  var?: string | null; // bound design-token name (solid), else absent/null
  varGuid?: string | null; // the variable guidKey, else absent/null
  stops?: { position: number; hex: string }[]; // gradient
  imageHash?: string; // image: hash bytes → hex (filename in images/, §7)
  opacity?: number; // paint opacity when < 1
};
export type IRStroke = {
  weight: number;
  align: string; // INSIDE | CENTER | OUTSIDE
  hex: string | null;
  var?: string | null;
  varGuid?: string | null;
  // optional stroke detail (improvement 3-borders) — PURE pass-throughs, emitted
  // only when present/non-default. fig→CSS map (see strokeDetailOf):
  //   strokeCap (BUTT/ROUND/SQUARE/…) → lower-cased; SVG/RN line-cap hint. Confirmed
  //     enum in this decode: ROUND.
  //   strokeJoin (MITER/BEVEL/ROUND) → lower-cased; MITER is the default → omitted.
  //     Confirmed enum: MITER, BEVEL, ROUND.
  //   dash (number[]) → dashPattern verbatim; non-empty → a dashed stroke (CSS
  //     border-style:dashed / SVG stroke-dasharray). Confirmed shape: number[] e.g. [10,5].
  cap?: string;
  join?: string;
  dash?: number[];
};
// Per-side border widths (improvement 3-borders): emitted ONLY when the raw node
// sets borderStrokeWeightsIndependent — then the four borderTop/Right/Bottom/Left
// Weight fields apply INSTEAD of the single strokeWeight, so bottom-only dividers
// etc. survive. Missing sides default to 0 (a side with no weight = no border on
// that edge). When NOT independent the IR keeps the single IRStroke.weight (no
// borderWidths block). fig→CSS: {top,right,bottom,left} → border-*-width.
export type IRBorderWidths = { top: number; right: number; bottom: number; left: number };
export type IREffect = {
  type: string; // DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | …
  hex: string | null;
  offsetX: number;
  offsetY: number;
  radius: number;
  spread?: number;
};
export type IRStyle = {
  fills?: IRFill[];
  cornerRadius?: number | { tl: number; tr: number; br: number; bl: number };
  strokes?: IRStroke[];
  borderWidths?: IRBorderWidths; // per-side widths (improvement 3-borders); see type doc
  effects?: IREffect[];
  opacity?: number;
};
// IRLayout carries the auto-layout CONTAINER picture. sizing & wrap (improvement
// 1-sizing / spec sizing) describe how the container sizes itself on each axis and
// whether it wraps — emitted only when the raw stackPrimarySizing/stackCounterSizing/
// stackWrap are present (non-default). fig→CSS sizing map:
//   stackPrimarySizing/stackCounterSizing "FIXED" → "fixed" (CSS: a real width/height),
//   "RESIZE_TO_FIT…"/"RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" → "hug" (CSS: width/height:auto,
//   i.e. content-driven). stackWrap "WRAP" → wrap:true (CSS flex-wrap:wrap).
export type IRLayout = {
  mode: "row" | "column";
  gap?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  justify?: string;
  align?: string;
  primarySizing?: "fixed" | "hug"; // main-axis self-sizing
  counterSizing?: "fixed" | "hug"; // cross-axis self-sizing
  wrap?: boolean; // stackWrap = WRAP → flex-wrap:wrap
};

// Per-node responsive picture (improvement 1-sizing / spec sizing): these apply to
// the node AS A FLEX CHILD / sized box (NOT the container — that's IRLayout). Each
// is a PURE pass-through of the bytes, emitted only when present/non-default so
// per-screen files stay lean. fig→CSS/RN map:
//   stackChildPrimaryGrow (number) → grow (CSS flex-grow; 1 → flex:1).
//   stackChildAlignSelf  (MIN/CENTER/MAX/STRETCH/…) → alignSelf (CSS align-self via
//     STACK_ALIGN: flex-start/center/flex-end/stretch).
//   stackPositioning "ABSOLUTE" → positioning:"absolute" (absolutely positioned
//     INSIDE an auto-layout parent — taken out of flow).
//   horizontalConstraint/verticalConstraint (MIN/MAX/CENTER/STRETCH/SCALE) → resize
//     constraints {h,v}, lower-cased, for non-auto (absolute) layouts.
//   minSize {value:{x,y}} → minW/minH (emit each only when > 0). maxSize is ABSENT
//     in this decode (TODO: wire maxW/maxH if a future export carries maxSize).
//   targetAspectRatio {value:{x,y}} → aspectRatio = x / y (CSS aspect-ratio).
export type IRConstraints = { h: string; v: string };

export type IRNode = {
  id: string;
  path: string;
  guid: string;
  type: string;
  name: string;
  text?: IRTextField;
  font?: IRFont;
  color?: IRColor;
  box: IRBox;
  style?: IRStyle;
  layout?: IRLayout;
  // --- per-node sizing/constraints (improvement 1-sizing) — see IRConstraints doc.
  grow?: number; // stackChildPrimaryGrow → flex-grow
  alignSelf?: string; // stackChildAlignSelf → CSS align-self
  positioning?: "absolute"; // stackPositioning ABSOLUTE inside an auto-layout parent
  constraints?: IRConstraints; // {h,v} resize constraints (lower-cased)
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  aspectRatio?: number; // targetAspectRatio x/y
  autoResize?: string | null;
  styleRuns?: number;
  unresolved?: string;
  children: IRNode[];
};

// Lower-cased figma type → IR type label (the schema uses `text`, not `TEXT`).
function irType(t: string): string {
  return (t ?? "").toLowerCase();
}

// Deterministic, path-derived short handle. Stable across re-builds and sibling
// insertion (never a bare positional counter). 10 hex chars of sha256(path).
export function idForPath(path: string): string {
  return "n_" + crypto.createHash("sha256").update(path).digest("hex").slice(0, 10);
}

// First visible solid fill (the node's own color paint). Mirrors describe-lib's
// paintStr SOLID branch so IR `color.hex` and the raw dump render identically.
function firstSolidFill(node: any): any | null {
  const fills: any[] = node.fillPaints ?? [];
  for (const p of fills) {
    if (p?.visible === false) continue;
    if (p?.type === "SOLID" && p.color) return p;
  }
  return null;
}

// Build the IRColor for a node from its first visible solid fill. `hex` stays the
// resolved concrete value (unchanged). When that fill is BOUND to a variable
// (paint.colorVar ALIAS resolving in `varIndex`), attach the design token directly:
// var/varGuid set and match="bound". A literal fill keeps var/varGuid null and
// match null (Phase 8 --theme value-matching fills token/match for literals).
function buildColor(node: any, varIndex: Map<string, string>): IRColor {
  const p = firstSolidFill(node);
  const hex = p ? colorStr(p.color) : null;
  const bound = p ? colorVarToken(p, varIndex) : null;
  return {
    hex,
    token: null,
    match: bound ? "bound" : null,
    var: bound ? bound.var : null,
    varGuid: bound ? bound.varGuid : null,
  };
}

// --- style + layout extraction (improvement B-style-layout / spec #2) --------
// All PURE functions of the raw node fields (confirmed against the decode with
// node.mts), mirroring describe-lib/render's SOLID/GRADIENT/IMAGE/effect handling
// so the IR and the raw dump agree. Numbers are emitted bare/rounded; hex is the
// lower-cased colorStr value. A block is OMITTED when the node has none of it.

// One fillPaint → IRFill (or null to drop a non-visible / unrecognized paint).
// SOLID carries hex + bound var (Phase A resolver); GRADIENT_* carries stops[];
// IMAGE carries imageHash. paint.opacity (< 1) is preserved.
function fillToIR(p: any, varIndex: Map<string, string>): IRFill | null {
  if (!p || p.visible === false) return null;
  const op = typeof p.opacity === "number" && p.opacity < 1 ? { opacity: p.opacity } : {};
  const t: string = p.type ?? "";
  if (t === "SOLID") {
    const bound = colorVarToken(p, varIndex);
    return {
      type: "solid",
      hex: p.color ? colorStr(p.color) : null,
      ...(bound ? { var: bound.var, varGuid: bound.varGuid } : {}),
      ...op,
    };
  }
  if (t.startsWith("GRADIENT")) {
    const stops = (p.stops ?? [])
      .filter((s: any) => s && s.color)
      .map((s: any) => ({ position: s.position ?? 0, hex: colorStr(s.color) }));
    return { type: "gradient", stops, ...op };
  }
  if (t === "IMAGE") {
    const h = p.image?.hash;
    const imageHash = Array.isArray(h) ? Buffer.from(h).toString("hex") : typeof h === "string" ? h : undefined;
    return { type: "image", ...(imageHash ? { imageHash } : {}), ...op };
  }
  return null;
}

// Per-corner radii → uniform number when all four agree, else the {tl,tr,br,bl}
// object. Falls back to the uniform `cornerRadius`. Returns undefined when none.
function cornerRadiusOf(n: any): IRStyle["cornerRadius"] {
  const tl = n.rectangleTopLeftCornerRadius;
  const tr = n.rectangleTopRightCornerRadius;
  const br = n.rectangleBottomRightCornerRadius;
  const bl = n.rectangleBottomLeftCornerRadius;
  if ([tl, tr, br, bl].every((v) => typeof v === "number")) {
    if (tl === tr && tr === br && br === bl) return tl || undefined;
    return { tl, tr, br, bl };
  }
  if (typeof n.cornerRadius === "number" && n.cornerRadius) return n.cornerRadius;
  return undefined;
}

// Per-side border widths (improvement 3-borders). Returns {top,right,bottom,left}
// ONLY when the raw node sets borderStrokeWeightsIndependent === true — then the
// four borderTop/Right/Bottom/LeftWeight fields apply INSTEAD of the single
// strokeWeight (a side with no weight defaults to 0 = no border that edge). When
// NOT independent, returns undefined so the IR keeps the single IRStroke.weight
// (no duplication). Confirmed shapes (node.mts): boolean flag + numeric per-side
// weights (absent side === 0).
function borderWidthsOf(n: any): IRBorderWidths | undefined {
  if (n.borderStrokeWeightsIndependent !== true) return undefined;
  const num = (v: any) => (typeof v === "number" ? v : 0);
  return {
    top: num(n.borderTopWeight),
    right: num(n.borderRightWeight),
    bottom: num(n.borderBottomWeight),
    left: num(n.borderLeftWeight),
  };
}

// Optional stroke detail (improvement 3-borders): cap/join/dash, each emitted only
// when present/non-default. strokeCap & strokeJoin lower-cased; MITER (the join
// default) is omitted; dashPattern passed through verbatim (non-empty → dashed).
// These live per-stroke (the raw fields are node-level, shared by every paint).
function strokeDetailOf(n: any): { cap?: string; join?: string; dash?: number[] } {
  const out: { cap?: string; join?: string; dash?: number[] } = {};
  if (typeof n.strokeCap === "string" && n.strokeCap && n.strokeCap !== "NONE")
    out.cap = n.strokeCap.toLowerCase();
  if (typeof n.strokeJoin === "string" && n.strokeJoin && n.strokeJoin !== "MITER")
    out.join = n.strokeJoin.toLowerCase();
  if (Array.isArray(n.dashPattern) && n.dashPattern.length) out.dash = n.dashPattern;
  return out;
}

// Build the IRStyle block for a node, or null when it carries no styling. fills =
// ALL visible fillPaints (solid/gradient/image — the complete picture; IRColor.hex
// stays the single-hex convenience). strokes carry weight/align/hex + bound var.
function buildStyle(n: any, varIndex: Map<string, string>): IRStyle | null {
  const s: IRStyle = {};

  const fills = (n.fillPaints ?? []).map((p: any) => fillToIR(p, varIndex)).filter(Boolean) as IRFill[];
  if (fills.length) s.fills = fills;

  const cr = cornerRadiusOf(n);
  if (cr !== undefined) s.cornerRadius = cr;

  const strokePaints: any[] = (n.strokePaints ?? []).filter((p: any) => p && p.visible !== false);
  if (strokePaints.length) {
    const weight = typeof n.strokeWeight === "number" ? n.strokeWeight : 1;
    const align = n.strokeAlign ?? "INSIDE";
    const detail = strokeDetailOf(n);
    s.strokes = strokePaints.map((p: any) => {
      const bound = p.type === "SOLID" ? colorVarToken(p, varIndex) : null;
      return {
        weight,
        align,
        hex: p.color ? colorStr(p.color) : null,
        ...(bound ? { var: bound.var, varGuid: bound.varGuid } : {}),
        ...detail,
      };
    });
    // per-side widths (improvement 3-borders): when independent, the four side
    // weights apply INSTEAD of the single weight. Emit a borderWidths block so a
    // bottom-only divider survives. NOT independent → keep the single weight only.
    const bw = borderWidthsOf(n);
    if (bw) s.borderWidths = bw;
  }

  const effects: any[] = (n.effects ?? []).filter((e: any) => e && e.visible !== false);
  if (effects.length) {
    s.effects = effects.map((e: any) => ({
      type: e.type ?? "",
      hex: e.color ? colorStr(e.color) : null,
      offsetX: e.offset?.x ?? 0,
      offsetY: e.offset?.y ?? 0,
      radius: e.radius ?? 0,
      ...(typeof e.spread === "number" ? { spread: e.spread } : {}),
    }));
  }

  if (typeof n.opacity === "number" && n.opacity < 1) s.opacity = n.opacity;

  return Object.keys(s).length ? s : null;
}

// fig stackPrimaryAlignItems / stackCounterAlignItems → CSS justify/align value.
const STACK_ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
  SPACE_EVENLY: "space-evenly",
  BASELINE: "baseline",
  STRETCH: "stretch",
};

// Build the IRLayout block ONLY when the node carries a real stackMode
// (HORIZONTAL/VERTICAL → row/column). NONE/absent → absolute positioning → no
// layout block. Paddings/gap omitted when 0; justify/align only when explicit.
function buildLayout(n: any): IRLayout | null {
  const sm = n.stackMode;
  if (sm !== "HORIZONTAL" && sm !== "VERTICAL") return null;
  const l: IRLayout = { mode: sm === "HORIZONTAL" ? "row" : "column" };
  if (n.stackSpacing) l.gap = n.stackSpacing;
  if (n.stackVerticalPadding) l.paddingTop = n.stackVerticalPadding;
  if (n.stackPaddingRight) l.paddingRight = n.stackPaddingRight;
  if (n.stackPaddingBottom) l.paddingBottom = n.stackPaddingBottom;
  if (n.stackHorizontalPadding) l.paddingLeft = n.stackHorizontalPadding;
  if (n.stackPrimaryAlignItems) l.justify = STACK_ALIGN[n.stackPrimaryAlignItems] ?? n.stackPrimaryAlignItems;
  if (n.stackCounterAlignItems) l.align = STACK_ALIGN[n.stackCounterAlignItems] ?? n.stackCounterAlignItems;
  // sizing & wrap (improvement 1-sizing): fixed vs hug self-sizing per axis, wrap.
  const ps = sizingOf(n.stackPrimarySizing);
  if (ps) l.primarySizing = ps;
  const cs = sizingOf(n.stackCounterSizing);
  if (cs) l.counterSizing = cs;
  if (n.stackWrap === "WRAP") l.wrap = true;
  return l;
}

// fig stack*Sizing enum → "fixed" | "hug" (or undefined for an unknown/absent
// value). FIXED → fixed (real px); any RESIZE_TO_FIT* (incl. the implicit-size
// variant) → hug (content-driven). Pure pass-through of the confirmed enum.
function sizingOf(v: any): "fixed" | "hug" | undefined {
  if (v === "FIXED") return "fixed";
  if (typeof v === "string" && v.startsWith("RESIZE_TO_FIT")) return "hug";
  return undefined;
}

// Normalize a raw resize-constraint enum (MIN/MAX/CENTER/STRETCH/SCALE) to a
// lower-cased CSS-friendly token. Pure pass-through; unknown values pass as-is.
function constraintOf(v: any): string | undefined {
  return typeof v === "string" && v ? v.toLowerCase() : undefined;
}

// Per-node sizing/constraints (improvement 1-sizing). Mutates `node` in place,
// attaching only the fields the raw node actually carries (lean files). All are
// pure pass-throughs of the bytes — they ALWAYS run (no heuristic). See
// IRConstraints doc for the fig→CSS/RN mapping.
function applySizing(node: IRNode, n: any) {
  if (typeof n.stackChildPrimaryGrow === "number" && n.stackChildPrimaryGrow)
    node.grow = n.stackChildPrimaryGrow;
  if (n.stackChildAlignSelf)
    node.alignSelf = STACK_ALIGN[n.stackChildAlignSelf] ?? n.stackChildAlignSelf;
  if (n.stackPositioning === "ABSOLUTE") node.positioning = "absolute";

  const h = constraintOf(n.horizontalConstraint);
  const v = constraintOf(n.verticalConstraint);
  if (h || v) node.constraints = { h: h ?? "min", v: v ?? "min" };

  const min = n.minSize?.value;
  if (min) {
    if (typeof min.x === "number" && min.x > 0) node.minW = min.x;
    if (typeof min.y === "number" && min.y > 0) node.minH = min.y;
  }
  // maxSize is ABSENT in this decode (confirmed: 0 occurrences). Wire maxW/maxH
  // here once a future export carries it (same {value:{x,y}} shape expected).
  const max = n.maxSize?.value;
  if (max) {
    if (typeof max.x === "number" && max.x > 0) node.maxW = max.x;
    if (typeof max.y === "number" && max.y > 0) node.maxH = max.y;
  }

  const ar = n.targetAspectRatio?.value;
  if (ar && typeof ar.x === "number" && typeof ar.y === "number" && ar.y)
    node.aspectRatio = Math.round((ar.x / ar.y) * 1000) / 1000;
}

// fig textCase enum → CSS text-transform value, or undefined when default
// (ORIGINAL/absent) or unknown. Confirmed enum in this decode: TITLE, UPPER.
// SMALL_CAPS maps to "uppercase" (CSS text-transform has no small-caps; a
// faithful render would need font-variant — TODO if a future export carries it).
function textCaseToCss(v: any): string | undefined {
  switch (v) {
    case "UPPER":
      return "uppercase";
    case "LOWER":
      return "lowercase";
    case "TITLE":
      return "capitalize";
    case "SMALL_CAPS":
      return "uppercase";
    default:
      return undefined; // ORIGINAL / absent / unknown → omit (CSS default)
  }
}

// fig textAlignHorizontal enum → CSS text-align value, or undefined for the LEFT
// default / absent. Confirmed enum in this decode: CENTER only.
function textAlignToCss(v: any): string | undefined {
  switch (v) {
    case "CENTER":
      return "center";
    case "RIGHT":
      return "right";
    case "JUSTIFIED":
      return "justify";
    default:
      return undefined; // LEFT / absent / unknown → omit (CSS default)
  }
}

// fig textAlignVertical enum → lower-cased vertical alignment token, or undefined
// for the TOP default / absent. No single CSS prop maps it (consumers center via
// flex); raw enum lower-cased. Confirmed enum in this decode: TOP, CENTER.
function textAlignVerticalToIR(v: any): string | undefined {
  if (typeof v !== "string" || !v || v === "TOP") return undefined;
  return v.toLowerCase();
}

// The guidKey ("sessionID:localID") of the text style a node applies via
// `styleIdForText`, or null when the node carries no shared text style. Used to look
// the style up in the typography token map (the CERTAIN designer-intent source).
function styleRefKey(n: ResolvedNode): string | null {
  const g = (n as any).styleIdForText?.guid;
  if (!g || g.sessionID === undefined || g.localID === undefined) return null;
  return `${g.sessionID}:${g.localID}`;
}

// Reconcile one resolved TEXT node into the IR `font`/`text`/`color` provenance
// objects. `appFamilyOf` maps a raw family → its decided appFamily slot (null
// until decided in Phase 8). `typeStyles` maps a text-style guidKey → its typography
// token (the applied-style source for font/lineHeight/textCase).
function reconcileText(
  n: ResolvedNode,
  appFamilyOf: (family: string | null) => string | null,
  varIndex: Map<string, string>,
  typeStyles: Map<string, IRTypography>
): { text: IRTextField; font: IRFont; color: IRColor; styleRuns: number } {
  const rec = reconcileTextSize(n as any); // geometry HEURISTIC — the true last resort
  const conflicts: Conflict[] = [];
  const nodeFamily = (n as any).fontName?.family ?? null;
  const nodeWeight = (n as any).fontName?.style ?? null;
  const nodeSize = typeof (n as any).fontSize === "number" ? (n as any).fontSize : null;
  const lsRaw = (n as any).letterSpacing ?? { value: 0, units: "PIXELS" };

  // Two CERTAIN sources from the bytes, both preferred over the geometry heuristic AND
  // over the node-level fontName/fontSize/lineHeight/textCase cache — which goes STALE
  // when a component variant re-styles a node (SingleLine header Title: cached
  // Lora/28/TITLE, but the applied text style + render are Geist Mono/16/UPPER):
  //   • style   = the applied text style (styleIdForText → typography token): designer
  //               INTENT — clean family/size/weight/lineHeight/textCase.
  //   • derived = derivedTextData: Figma's actual RENDER (effective values, so it honors
  //               a LOCAL override layered on top of a style).
  // Both defer to the node cache when an INSTANCE override set the font explicitly
  // (overrideApplied.fontName/Size) — then the override on the node is the truth.
  const fontOverridden =
    !!(n as any).overrideApplied?.fontName || !!(n as any).overrideApplied?.fontSize;
  const styleKey = styleRefKey(n);
  const style = !fontOverridden && styleKey ? typeStyles.get(styleKey) ?? null : null;
  const derived = fontOverridden ? null : deriveFontFromRender(n as any);

  // family / weight / size: RENDER (effective) → STYLE (intent) → cache → geometry.
  // `rec` (geometry) is only reached when neither certain source covers the node.
  const family = derived?.family ?? style?.family ?? nodeFamily;
  const weight = derived?.weight ?? style?.weight ?? nodeWeight;
  let size: number;
  let sizeSource: IRFont["sizeSource"];
  if (derived?.size != null) { size = derived.size; sizeSource = "derived"; }
  else if (style?.size != null) { size = style.size; sizeSource = "style"; }
  else { size = rec.size; sizeSource = rec.source; }

  // Is the node's cached text snapshot STALE? (font re-styled, cache not refreshed) —
  // then its cached lineHeight/textCase are unreliable too and must come from the style.
  const truthFamily = derived?.family ?? style?.family ?? null;
  const truthSize = derived?.size ?? style?.size ?? null;
  const stale =
    (truthFamily != null && nodeFamily != null && truthFamily !== nodeFamily) ||
    (truthSize != null && nodeSize != null && truthSize !== nodeSize);

  // line height: the STYLE value is the most accurate — the render baseline OVER-counts
  // font leading (16px Geist Mono → a 20.8 baseline for a 20px line box) and the cache
  // can be stale. A FRESH cache is trusted first (it honors a local line-height override).
  const cacheLh = lineHeightPx((n as any).lineHeight, size);
  let lhPx: number | null;
  let lineHeightSource: IRFont["lineHeightSource"];
  if (!stale && cacheLh != null) { lhPx = cacheLh; lineHeightSource = "fontSize"; }
  else if (style?.lineHeightPx != null) { lhPx = style.lineHeightPx; lineHeightSource = "style"; }
  else { lhPx = cacheLh ?? derived?.lineHeightPx ?? null; lineHeightSource = cacheLh != null ? "fontSize" : "derived"; }

  // geometry was a GUESS — surface its conflict ONLY when geometry actually won the size.
  if (sizeSource === "geometry") conflicts.push(...rec.conflicts);

  // styleOverrideTable runs: a non-empty table means node-level font may not match
  // N runs — add a conflict (does not change `size`, only flags).
  const styleRuns = (n as any).textData?.styleOverrideTable?.length ?? 0;
  if (styleRuns) {
    conflicts.push({
      field: "styleRuns",
      declared: styleRuns,
      chosen: styleRuns,
      boxY: (n as any).size?.y ?? 0,
      lhPx: lhPx ?? 0,
      reason: `node-level font may not match ${styleRuns} style runs`,
    });
  }

  const font: IRFont = {
    family,
    appFamily: appFamilyOf(family),
    weight,
    size,
    sizeSource,
    sizeToken: null,
    sizeMatch: null,
    styleName: style?.name ?? null,
    styleGuid: style?.guid ?? null,
    vars: style?.vars ?? null,
    lineHeightPx: lhPx,
    lineHeightSource,
    letterSpacingPx: letterSpacingToPx(lsRaw, size),
    letterSpacingRaw: {
      value: lsRaw.value ?? 0,
      units: lsRaw.units ?? "PIXELS",
    },
    conflicts,
  };

  const chars: string = (n as any).textData?.characters ?? "";
  const hasOverride = (n as any).hasTextOverride ?? false;
  const masterDefault = (n as any).masterDefaultText; // undefined when overridden
  const cls = classifyPlaceholderText(chars, hasOverride, masterDefault);
  const text: IRTextField = {
    value: chars,
    source: hasOverride ? "override" : "master-default",
    placeholder: cls.placeholder,
    reason: cls.reason,
  };
  // text transform & alignment (improvement 2-text): pass-throughs of the resolved
  // bytes, attached only when non-default/present (lean files). textCase is part of the
  // node's text-style snapshot, so a STALE cache → take the applied style's case (the
  // SingleLine header is UPPER per its Eyebrow style, not the cached TITLE); a fresh
  // cache is trusted (it honors a local case override).
  const rawCase = stale && style?.textCase != null ? style.textCase : (n as any).textCase;
  const tCase = textCaseToCss(rawCase);
  if (tCase) text.case = tCase;
  const tAlign = textAlignToCss((n as any).textAlignHorizontal);
  if (tAlign) text.align = tAlign;
  const tAlignV = textAlignVerticalToIR((n as any).textAlignVertical);
  if (tAlignV) text.alignVertical = tAlignV;
  const lt = (n as any).leadingTrim;
  if (typeof lt === "string" && lt && lt !== "NONE") text.leadingTrim = lt.toLowerCase();

  const color: IRColor = buildColor(n, varIndex);
  return { text, font, color, styleRuns };
}

// Recursively convert a resolved node into an IR node, accumulating the affine so
// box.absX/absY = the translation (m02,m12) of the product. `acc` is the affine
// from the page root down to (and INCLUDING) THIS node — for the screen root the
// caller seeds it with lib.absMat(root); each child composes its own transform.
// Walks the RESOLVED tree (instance children carry exactly one transform each —
// resolve-lib drops the master root), so the walk is uniform across instance
// boundaries (§6 step 3). Never call lib.absCoords on a composed child.
function toIR(
  n: ResolvedNode,
  acc: Mat,
  appFamilyOf: (family: string | null) => string | null,
  varIndex: Map<string, string>,
  typeStyles: Map<string, IRTypography>
): IRNode {
  const size = (n as any).size ?? { x: 0, y: 0 };
  const t = (n as any).transform;
  const box: IRBox = {
    x: t ? Math.round(t.m02) : 0,
    y: t ? Math.round(t.m12) : 0,
    w: Math.round(size.x),
    h: Math.round(size.y),
    absX: Math.round(acc[2]),
    absY: Math.round(acc[5]),
  };

  const node: IRNode = {
    id: idForPath(n.path),
    path: n.path,
    guid: n.guid,
    type: irType(n.type),
    name: n.name,
    box,
    children: [],
  };

  if ((n as any).type === "TEXT") {
    const { text, font, color, styleRuns } = reconcileText(n, appFamilyOf, varIndex, typeStyles);
    node.text = text;
    node.font = font;
    node.color = color;
    node.styleRuns = styleRuns;
    node.autoResize = (n as any).textAutoResize ?? null;
  } else {
    const color = buildColor(n, varIndex);
    if (color.hex) node.color = color;
  }

  // Full box-styling + auto-layout (B-style-layout / spec #2) on EVERY node type
  // (TEXT included — a text node can carry effects/opacity). Blocks are omitted
  // when absent so files stay lean.
  const style = buildStyle(n as any, varIndex);
  if (style) node.style = style;
  const layout = buildLayout(n as any);
  if (layout) node.layout = layout;

  // per-node sizing/constraints (improvement 1-sizing): grow/alignSelf/positioning/
  // constraints/min/max/aspectRatio — pure pass-throughs, attached when present.
  applySizing(node, n as any);

  // unresolved (remote/library master absent, or cycle): emit the node carrying
  // its string and STOP recursing here (§5 / §6 step 1) — never drop it.
  if (n.unresolved) {
    node.unresolved = n.unresolved;
    return node;
  }

  for (const c of n.children ?? []) {
    if ((c as any).visible === false) continue;
    const childAcc = mul(acc, nodeMat(c as any));
    node.children.push(toIR(c, childAcc, appFamilyOf, varIndex, typeStyles));
  }
  return node;
}

// Build the IR screen node from a RESOLVED screen root. `rootAbsMat` is the affine
// from the page root down to (and including) the screen root (lib.absMat(root)) —
// the screen frame is a direct raw node, so absMat is valid for that seed (§6
// step 3). `appFamily` maps raw family → decided appFamily slot (or null).
// `varIndex` maps a variable guidKey → its design-token name; build it ONCE in
// build-ir (from the resolved color variables) and pass it in — buildColor uses it
// to attach the bound token directly on every variable-bound fill (GROUND TRUTH).
export function buildScreen(
  resolvedRoot: ResolvedNode,
  rootAbsMat: Mat,
  appFamily: Record<string, string> = {},
  varIndex: Map<string, string> = new Map(),
  typeStyles: Map<string, IRTypography> = new Map()
): IRNode {
  const appFamilyOf = (family: string | null): string | null =>
    family != null && appFamily[family] ? appFamily[family] : null;
  return toIR(resolvedRoot, rootAbsMat, appFamilyOf, varIndex, typeStyles);
}

// Walk an IR tree, registering every node id → {guid, path} into `out`.
export function registerRawMap(node: IRNode, out: Record<string, { guid: string; path: string }>) {
  out[node.id] = { guid: node.guid, path: node.path };
  for (const c of node.children) registerRawMap(c, out);
}

// Structural provenance check (load-bearing, §7): every reconciled font/text/color
// object on every node carries its *Source/match key. Returns the list of
// violations ([] = clean). Phase 9's ir-validate shares this.
export function provenanceViolations(node: IRNode, acc: string[] = []): string[] {
  if (node.font) {
    if (node.font.sizeSource == null) acc.push(`${node.id}: font.sizeSource missing`);
    if (node.font.lineHeightSource == null) acc.push(`${node.id}: font.lineHeightSource missing`);
    if (!("sizeMatch" in node.font)) acc.push(`${node.id}: font.sizeMatch missing`);
    if (!Array.isArray(node.font.conflicts)) acc.push(`${node.id}: font.conflicts missing`);
  }
  if (node.text) {
    if (node.text.source == null) acc.push(`${node.id}: text.source missing`);
  }
  if (node.color) {
    if (!("match" in node.color)) acc.push(`${node.id}: color.match missing`);
    if (!("token" in node.color)) acc.push(`${node.id}: color.token missing`);
    if (!("var" in node.color)) acc.push(`${node.id}: color.var missing`);
    if (!("varGuid" in node.color)) acc.push(`${node.id}: color.varGuid missing`);
  }
  for (const c of node.children) provenanceViolations(c, acc);
  return acc;
}

// Collect a flat set of all text strings in an IR tree (for the §7 resolve-parity
// validation: IR resolved text ⊇ overrides text).
export function collectText(node: IRNode, acc: Set<string> = new Set()): Set<string> {
  if (node.text) acc.add(node.text.value);
  for (const c of node.children) collectText(c, acc);
  return acc;
}
