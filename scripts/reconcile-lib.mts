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
