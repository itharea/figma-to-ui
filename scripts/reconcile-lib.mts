// Pure text-reconciliation math: letterSpacing/lineHeight units, box-vs-font
// conflict detection, and placeholder-string classification. NO top-level side
// effects — imported by dump.mts now and build-ir.mts later.
//
// The thresholds below (1.15 / 0.85 / 15%) are heuristic *tolerances*. The
// detection of "this line-height cannot fit this box" is exact arithmetic; the
// *suggested* size on conflict is a low-confidence estimate. Phase 7 uses this
// split to set source/confidence correctly.

export type Conflict = {
  field: string;
  declared: number; // the node-level value we doubt (fontSize)
  chosen: number; // the geometry-derived suggestion
  boxY: number; // real box height (size.y)
  lhPx: number; // line-height px used for detection
  reason: string;
};

// Figma {value, units} + node fontSize → px that RN's letterSpacing wants.
// PERCENT → (value/100)*fontSize (em→px); PIXELS → value; missing/0 → 0.
export function letterSpacingToPx(ls: any, fontSize: number): number {
  if (!ls || !ls.value) return 0;
  if (ls.units === "PERCENT") return (ls.value / 100) * (fontSize ?? 0);
  return ls.value; // PIXELS (and anything explicit)
}

// Display string, never a bare number:
//   PERCENT → `${value}%→${px.toFixed(2)}px@${fontSize}`  e.g. "4%→0.64px@16"
//   PIXELS  → `${value}px`                                 e.g. "1px"
//   0/missing → "0"
export function letterSpacingStr(ls: any, fontSize: number): string {
  if (!ls || !ls.value) return "0";
  if (ls.units === "PERCENT")
    return `${ls.value}%→${letterSpacingToPx(ls, fontSize).toFixed(2)}px@${fontSize}`;
  return `${ls.value}px`;
}

// lineHeight px at this font size: PERCENT→value/100*fontSize, PIXELS→value,
// AUTO/"auto"/missing → null (caller treats null as "font default ~1.2×, unknown").
export function lineHeightPx(lh: any, fontSize: number): number | null {
  if (!lh || lh.units === "AUTO" || lh.value === undefined) return null;
  if (lh.units === "PERCENT") return (lh.value / 100) * (fontSize ?? 0);
  return lh.value; // PIXELS
}

// Box-vs-font reconciliation (the P0-1 core). DETECTION is deterministic; the
// suggested size is a labeled heuristic.
export function reconcileTextSize(
  node: any
): { size: number; source: "fontSize" | "geometry"; conflicts: Conflict[] } {
  const fontSize = node?.fontSize;
  const noConflict = { size: fontSize, source: "fontSize" as const, conflicts: [] as Conflict[] };
  if (node?.type !== "TEXT" || !fontSize || !node.size) return noConflict;
  const ar = node.textAutoResize;
  if (ar !== "HEIGHT" && ar !== "WIDTH_AND_HEIGHT") return noConflict;

  const boxY = node.size.y;
  const lhKnown = lineHeightPx(node.lineHeight, fontSize) != null;
  const lhPx = lineHeightPx(node.lineHeight, fontSize) ?? fontSize * 1.2; // ?? branch is a GUESS

  let conflict = false;
  if (ar === "WIDTH_AND_HEIGHT") {
    // single line: a line-height taller than the box (with slack) can't fit
    if (lhPx > boxY * 1.15) conflict = true;
  } else {
    // HEIGHT (may wrap): shorter than one line
    if (boxY < lhPx * 0.85) conflict = true;
    // integer-multiple test ONLY when lineHeight is real (never the 1.2× guess)
    else if (lhKnown) {
      const lines = boxY / lhPx;
      const nearest = Math.round(lines);
      if (nearest >= 1 && Math.abs(lines - nearest) > 0.15) conflict = true;
    }
  }
  if (!conflict) return noConflict;

  // suggested size: declared lh:fontSize ratio applied to the real box height
  let chosen = Math.round(boxY * (fontSize / lhPx));
  chosen = Math.max(8, Math.min(96, chosen));
  return {
    size: chosen,
    source: "geometry",
    conflicts: [
      {
        field: "fontSize",
        declared: fontSize,
        chosen,
        boxY,
        lhPx,
        reason: `box.y=${boxY} vs lh=${lhPx}`,
      },
    ],
  };
}

// Ground-truth font from Figma's OWN resolved render (`derivedTextData`). The
// node-level fontName/fontSize/lineHeight cache goes STALE when a component variant
// re-styles a text node: Figma leaves the inherited values on the node (e.g. the
// SingleLine header Title carries Lora/Bold/28) while the applied text style is what
// actually renders (Geist Mono/Regular/16). `derivedTextData` is that real layout —
// fontMetaData[].key is the rendered family/style, each glyph.fontSize is the
// rendered size, baselines[].lineHeight is the rendered line height. This is DETECTION
// (exact bytes), not a heuristic guess, so the caller may present it as truth.
// Returns null when the node carries no usable derived render (caller falls back to
// the cached fontName + the geometry heuristic above).
export type DerivedFont = {
  family: string | null;
  weight: string | null; // fontMetaData[].key.style ("Regular", "Bold", …)
  size: number | null; // dominant glyph fontSize
  lineHeightPx: number | null; // rendered baseline line height (float noise rounded)
  mixed: boolean; // >1 font run or >1 glyph size — the single family/size is a reduction
};

export function deriveFontFromRender(node: any): DerivedFont | null {
  const dtd = node?.derivedTextData;
  if (!dtd || typeof dtd !== "object") return null;
  const metas: any[] = Array.isArray(dtd.fontMetaData) ? dtd.fontMetaData : [];
  const glyphs: any[] = Array.isArray(dtd.glyphs) ? dtd.glyphs : [];
  if (!metas.length && !glyphs.length) return null;

  // family/weight: the first (dominant) font run's key.
  const key0 = metas[0]?.key ?? {};
  const family = typeof key0.family === "string" && key0.family ? key0.family : null;
  const weight = typeof key0.style === "string" && key0.style ? key0.style : null;

  // size: the MODE of glyph fontSizes so a stray glyph can't skew it.
  const counts = new Map<number, number>();
  for (const g of glyphs)
    if (typeof g?.fontSize === "number") counts.set(g.fontSize, (counts.get(g.fontSize) ?? 0) + 1);
  let size: number | null = null;
  let best = -1;
  for (const [sz, c] of counts) if (c > best) { best = c; size = sz; }

  // line height: the rendered baseline (kill binary-decode float noise → 2dp).
  const lhRaw = dtd.baselines?.[0]?.lineHeight;
  const lineHeightPx = typeof lhRaw === "number" ? Math.round(lhRaw * 100) / 100 : null;

  if (family == null && size == null) return null;
  return { family, weight, size, lineHeightPx, mixed: metas.length > 1 || counts.size > 1 };
}

// Placeholder string classifier (the P0-3 string half; override-presence half is
// wired in Phase 2). masterDefault may be undefined in Phase 1.
//   placeholder=true iff !hasTextOverride AND
//     ( /^(test|label|placeholder|title|body|description|lorem)/i matches text
//       OR text === masterDefault ).
export function classifyPlaceholderText(
  text: string,
  hasTextOverride: boolean,
  masterDefault?: string
): { placeholder: boolean; reason: string } {
  if (hasTextOverride) return { placeholder: false, reason: "has-override" };
  if (/^(test|label|placeholder|title|body|description|lorem)/i.test(text ?? ""))
    return { placeholder: true, reason: "matches-placeholder-pattern" };
  if (masterDefault !== undefined && text === masterDefault)
    return { placeholder: true, reason: "equals-master-default" };
  return { placeholder: false, reason: "looks-real" };
}

// SPACE_EVENLY-vs-SPACE_BETWEEN disambiguation (CODEGEN_BUGS #8: SPACE_EVENLY
// emitted where the layout means SPACE_BETWEEN). Figma's primaryAxisAlignItems
// reports SPACE_BETWEEN as "space-evenly" in some exports, but the two differ
// geometrically: SPACE_BETWEEN pins the first child to the content start and the
// last child to the content end (gaps only *between* children), while true
// SPACE_EVENLY adds equal gaps *outside* the ends too. This is exact geometry
// (no IO): if the first in-flow child starts at the padding edge and the last
// ends at the opposite padding edge (within tol px), the intent is space-between.
// Returns layout.justify unchanged in every other case.
export function disambiguateJustify(
  layout: { mode: "row" | "column"; justify?: string; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number },
  parentBox: { w?: number; h?: number } | undefined,
  children: { box?: { x?: number; y?: number; w?: number; h?: number }; positioning?: string; visible?: boolean }[],
  tol: number = 1.5
): string | undefined {
  if (layout.justify !== "space-evenly") return layout.justify;

  // in-flow only: visible and laid-out by the auto-layout (not absolute)
  const inFlow = children.filter((c) => c.visible !== false && c.positioning !== "absolute");
  if (inFlow.length < 2) return layout.justify;

  const row = layout.mode === "row";
  const contentStart = (row ? layout.paddingLeft : layout.paddingTop) ?? 0;
  const contentEnd = row
    ? (parentBox?.w ?? 0) - (layout.paddingRight ?? 0)
    : (parentBox?.h ?? 0) - (layout.paddingBottom ?? 0);

  const start = (c: { box?: { x?: number; y?: number } }) => (row ? c.box?.x : c.box?.y) ?? 0;
  const sorted = [...inFlow].sort((a, b) => start(a) - start(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const firstStart = row ? (first.box?.x ?? 0) : (first.box?.y ?? 0);
  const lastEnd = row
    ? (last.box?.x ?? 0) + (last.box?.w ?? 0)
    : (last.box?.y ?? 0) + (last.box?.h ?? 0);

  if (Math.abs(firstStart - contentStart) <= tol && Math.abs(lastEnd - contentEnd) <= tol)
    return "space-between";
  return layout.justify;
}
