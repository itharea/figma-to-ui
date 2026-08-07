// layout-lib.mts — pure geometry + sizing helpers for codegen's layout decisions.
// No side effects, no CLI: safe to import from selftest.mts (codegen.mts runs its CLI
// at import time and therefore cannot be imported). See SKILL.md / REFERENCE.md.

import type { IRNode } from "./screens-lib.mts";

export type Box = { x: number; y: number; w: number; h: number };

// Strict bbox intersection: touching edges (==) do NOT count.
export function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Intersection AREA of two bboxes (0 when disjoint or edge-touching).
export function overlapArea(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}

// A peek-carousel / authored stack: some NON-ADJACENT child pair
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

// A node's own sizing MODE per CSS axis — the input to codegen's width/height lines.
//
// Figma states sizing per axis RELATIVE TO THE STACK DIRECTION: `primarySizing` is the
// stack's own direction (row → horizontal, column → vertical) and `counterSizing` the
// cross one, so both have to be mapped back to width/height before they mean anything
// in CSS. Three outcomes:
//   • fill  — the node is a flex CHILD told to fill. `flexGrow` / `align-self` already
//             size it, so a number here would PIN it. The axis is omitted entirely.
//   • hug   — content-driven.
//   • fixed — the measured value.
// A node with no auto-layout has no sizing modes and keeps its measured box, except on
// an axis its parent fills. TEXT nodes carry the same intent in `autoResize`:
// HEIGHT = fixed width + hug height, WIDTH_AND_HEIGHT = hug both, NONE/TRUNCATE = both
// fixed.
type SizingMode = "fixed" | "hug" | "fill";

function sizingModes(n: IRNode): { w: SizingMode; h: SizingMode } {
  const l = n.layout;
  let w: SizingMode = "fixed";
  let h: SizingMode = "fixed";

  if (l?.mode === "row" || l?.mode === "column") {
    const primary: SizingMode = l.primarySizing ?? "fixed";
    const counter: SizingMode = l.counterSizing ?? "fixed";
    w = l.mode === "row" ? primary : counter;
    h = l.mode === "row" ? counter : primary;
  } else if (n.type === "text") {
    if (n.autoResize === "WIDTH_AND_HEIGHT") {
      w = "hug";
      h = "hug";
    } else if (n.autoResize === "HEIGHT") {
      h = "hug";
    }
  }

  // Being filled by the PARENT outranks the node's own mode: `grow` fills along the
  // parent's PRIMARY axis, `alignSelf:'stretch'` across its COUNTER one. Which CSS axis
  // each is depends on the PARENT's direction, which a child only knows because toIR
  // stamps it on as `parentMode`. Absent ⇒ the parent is not auto-layout, so nothing
  // fills and the node's own mode stands.
  if (n.grow) {
    if (n.parentMode === "row") w = "fill";
    else if (n.parentMode === "column") h = "fill";
  }
  if (n.alignSelf === "stretch") {
    if (n.parentMode === "row") h = "fill";
    else if (n.parentMode === "column") w = "fill";
  }
  return { w, h };
}

// The `width:`/`height:` style lines for a node, driven by sizingModes() rather than by
// the frozen measured bbox. Freezing turns every hug into a magic number (a longer label
// then clips) and every fill into a pin (the child stops tracking its parent).
//
// hug is spelled `fit-content`, NOT `auto`: on a block-level box `width: auto` means
// FILL, which is wrong in exactly the case that matters. A zero measurement emits
// nothing, as before — a 0-px box is a decode artefact, not a design intent.
export function sizingLines(n: IRNode): string[] {
  const box = n.box;
  if (!box) return [];
  const mode = sizingModes(n);
  const out: string[] = [];
  const emit = (css: "width" | "height", m: SizingMode, px: number | undefined) => {
    if (m === "fill") return; // flexGrow / alignSelf sizes it
    if (m === "hug") out.push(`${css}: 'fit-content', // hug`);
    else if (px) out.push(`${css}: ${px},`);
  };
  emit("width", mode.w, box.w);
  emit("height", mode.h, box.h);
  return out;
}
