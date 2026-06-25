// layout-lib.mts — pure geometry helpers for codegen's positioning decisions.
// No side effects, no CLI: safe to import from selftest.mts (codegen.mts runs its CLI
// at import time and therefore cannot be imported). See SKILL.md / REFERENCE.md.

export type Box = { x: number; y: number; w: number; h: number };

// Strict bbox intersection (improvement 9): touching edges (==) do NOT count.
export function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Intersection AREA of two bboxes (0 when disjoint or edge-touching).
export function overlapArea(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}

// A peek-carousel / authored stack (improvement 11): some NON-ADJACENT child pair
// overlaps by more than `frac` of the smaller box's area. Sequential flex flow — even
// with negative gap — can only make CONSECUTIVE (source-order-adjacent) children touch;
// it can NEVER make non-adjacent children overlap. So a significant non-adjacent overlap
// is authored stacking, not a frozen-bbox snapshot, and the container must position its
// children absolutely even when it is auto-layout and no child is explicitly stack-absolute.
// `boxes` MUST be in source (child-array) order so adjacency = consecutive index.
export function hasSignificantNonAdjacentOverlap(boxes: Box[], frac = 0.25): boolean {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 2; j < boxes.length; j++) {
      // j starts at i+2 → skip the adjacent pair (i, i+1): negative-gap flex is allowed.
      const a = boxes[i];
      const b = boxes[j];
      const smaller = Math.min(a.w * a.h, b.w * b.h);
      if (smaller > 0 && overlapArea(a, b) / smaller > frac) return true;
    }
  return false;
}
