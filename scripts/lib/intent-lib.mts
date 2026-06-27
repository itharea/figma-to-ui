// Deterministic intent predicates UNIQUE to the designer-intent report — the two
// checks that are NOT already in reconcile-lib (placeholder/reconciliation) or
// components-lib (default-variant): the placeholder denylist / repeated-string
// scan, and the mono-color icon-fill scan. NO top-level side effects — shared
// verbatim by intent.mts (Phase 5) and build-ir.mts's intent.json pass (Phase 8).
import { colorStr } from "./figma-index.mts";

// Strings that are almost always stand-ins, not real copy. Anchored, case-
// insensitive. Kept distinct from reconcile-lib's classifyPlaceholderText pattern
// (which gates on override-presence + master-default equality); this is a blunter
// "this literal string smells like a placeholder regardless of provenance" list.
export const placeholderDenylist: RegExp[] = [
  /^test\b/i,
  /^lorem\b/i,
  /^title( text)?$/i,
  /^body( text)?$/i,
  /^label$/i,
  /^placeholder$/i,
  /^heading$/i,
  /^subtitle$/i,
  /^description$/i,
  /^text$/i,
  /^button$/i,
  /^name$/i,
  /^your text here$/i,
];

export function isDenylistedText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return placeholderDenylist.some((re) => re.test(t));
}

// Count how many times each (trimmed, non-empty) string appears. Callers flag
// strings with count > 1 as "repeated" (same literal copy reused across the
// screen — often an un-edited placeholder propagated by duplication).
export function repeatedStrings(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of texts) {
    const t = (raw ?? "").trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

// A node whose every visible SOLID fill is pure white or pure black — the
// hallmark of an icon meant to be recolored by the consumer (recolor-in-consumer,
// determinism contract / README intent-lib row). Requires at least one such fill;
// a node with no SOLID fill is not a mono-color icon.
export function isMonoColorIconFill(node: any): boolean {
  const solids = (node?.fillPaints ?? []).filter(
    (p: any) => p.visible !== false && p.type === "SOLID",
  );
  if (!solids.length) return false;
  return solids.every((p: any) => {
    const hex = colorStr(p.color).toLowerCase();
    return hex === "#ffffff" || hex === "#000000";
  });
}
