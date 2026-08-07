// layout-lib.mts — pure geometry + sizing helpers for codegen's layout decisions.
// No side effects, no CLI: safe to import from selftest.mts (codegen.mts runs its CLI
// at import time and therefore cannot be imported). See SKILL.md / REFERENCE.md.

import { key } from "./figma-index.mts";
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
//
// This function is also the NORMATIVE statement of the mapping for the two agent prompts,
// which restate it in prose because they write code by hand rather than calling in:
// `agents/assemble-screen.md` (deriving it from the screen IR) and `agents/elevate.md`
// (preserving what codegen already emitted). They drifted apart once already — an assemble
// agent freezing every axis to `box` undid this per-axis logic one layer up — so if the
// mapping changes here, change both prompts in the same commit.
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

// === geometric default-verifier: the omit-when-default assumption, checked per file ===
//
// `stackPrimarySizing` is written only when it holds a NON-default value, so an absent
// field is a real value and the reader has to supply the default. Getting that default
// backwards is invisible: a frame frozen at exactly its content height renders
// pixel-identically to a hugging one, and only diverges once the content changes.
//
// So instead of trusting a fixed expectation, check the assumption against the bytes of
// whatever file is at hand: a frame that really hugs along its stack direction MUST
// measure `sum(children) + gaps + padding` on that axis, because that is what hugging
// means. Every frame whose primary sizing is absent is an independent test of
// "absent ⇒ hug"; the frames that state `RESIZE_TO_FIT` outright are the control group
// that tests the ARITHMETIC rather than the default, so the two are reported separately —
// controls passing while absent-frames fail is precisely the signature of a wrong default.
//
// (On the 56-component library export these defaults were first characterised against,
// all 285 independently-testable absent-primary frames agreed.)
//
// Preconditions are conservative — every frame that cannot be computed EXACTLY is skipped
// with a reason rather than guessed at, because one false violation would make the whole
// check ignorable:
//   • ≥ `minChildren` in-flow children (hidden and `stackPositioning: ABSOLUTE` children
//     take no space, so they are not part of the sum)
//   • not wrapping (a WRAP stack's primary axis is a row-packing problem, not a sum)
//   • not SPACE_BETWEEN / SPACE_EVENLY (the flow gap is then distributed, not `stackSpacing`)
//   • the frame and every in-flow child carry a `size`
export type StackDefaultCheck = {
  guid: string;
  name: string;
  mode: "row" | "column";
  // "absent" = the frame under test (the default supplied the value);
  // "hug" = an explicitly RESIZE_TO_FIT frame (the control for the arithmetic itself).
  declared: "absent" | "hug";
  actual: number; // the frame's measured primary axis
  expected: number; // sum(children) + gaps + padding
  delta: number; // actual − expected (0 = agrees)
  children: number; // in-flow children counted
  content: number; // sum of the children's primary extents
  gap: number;
  padStart: number;
  padEnd: number;
};
export type StackDefaultReport = {
  autoLayoutFrames: number; // every frame with a real stackMode
  checked: StackDefaultCheck[]; // frames that met the preconditions (agreeing + violating)
  violations: StackDefaultCheck[]; // the subset that did NOT agree
  skipped: Record<string, number>; // reason → count, so "untestable" never reads as "passed"
  tolerance: number;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const hasSize = (n: any): boolean => !!n?.size && finite(n.size.x) && finite(n.size.y);

// Run the check over a decoded message index (figma-index.load, or anything exposing the
// same `nodes` + `children` maps). Pure: reads only from `index`, reports rather than
// throws, and an export with nothing testable comes back with `checked: []` — which is a
// different answer from "everything agreed", and callers must be able to tell them apart.
export function verifyStackDefaults(
  index: { nodes: any[]; children: Map<string, any[]> },
  opts: { tolerance?: number; minChildren?: number } = {},
): StackDefaultReport {
  const tolerance = opts.tolerance ?? 0.5; // px; decoded sizes carry float32 noise
  const minChildren = opts.minChildren ?? 2;
  const checked: StackDefaultCheck[] = [];
  const violations: StackDefaultCheck[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  let autoLayoutFrames = 0;

  for (const n of index.nodes ?? []) {
    const sm = n?.stackMode;
    if (sm !== "HORIZONTAL" && sm !== "VERTICAL") continue;
    autoLayoutFrames++;

    const raw = n.stackPrimarySizing;
    let declared: StackDefaultCheck["declared"];
    if (raw === undefined || raw === null) declared = "absent";
    else if (typeof raw === "string" && raw.startsWith("RESIZE_TO_FIT")) declared = "hug";
    else {
      skip("declared-fixed"); // FIXED (or an unknown enum) predicts nothing geometric
      continue;
    }
    if (n.stackWrap === "WRAP") {
      skip("wrapping");
      continue;
    }
    if (
      n.stackPrimaryAlignItems === "SPACE_BETWEEN" ||
      n.stackPrimaryAlignItems === "SPACE_EVENLY"
    ) {
      skip("distributed-justify");
      continue;
    }
    if (!hasSize(n)) {
      skip("frame-without-size");
      continue;
    }
    const kids = (index.children.get(key(n.guid)) ?? []).filter(
      (c: any) => c?.visible !== false && c?.stackPositioning !== "ABSOLUTE",
    );
    if (kids.length < minChildren) {
      skip("few-in-flow-children");
      continue;
    }
    if (!kids.every(hasSize)) {
      skip("child-without-size");
      continue;
    }

    const row = sm === "HORIZONTAL";
    const padStart = finite(row ? n.stackHorizontalPadding : n.stackVerticalPadding)
      ? row
        ? n.stackHorizontalPadding
        : n.stackVerticalPadding
      : 0;
    const padEnd = finite(row ? n.stackPaddingRight : n.stackPaddingBottom)
      ? row
        ? n.stackPaddingRight
        : n.stackPaddingBottom
      : 0;
    const gap = finite(n.stackSpacing) ? n.stackSpacing : 0;
    const content = kids.reduce((a: number, c: any) => a + (row ? c.size.x : c.size.y), 0);
    const expected = content + gap * (kids.length - 1) + padStart + padEnd;
    const actual = row ? n.size.x : n.size.y;
    const entry: StackDefaultCheck = {
      guid: key(n.guid),
      name: typeof n.name === "string" ? n.name : (n.type ?? ""),
      mode: row ? "row" : "column",
      declared,
      actual: round4(actual),
      expected: round4(expected),
      delta: round4(actual - expected),
      children: kids.length,
      content: round4(content),
      gap,
      padStart,
      padEnd,
    };
    checked.push(entry);
    if (Math.abs(actual - expected) > tolerance) violations.push(entry);
  }

  return { autoLayoutFrames, checked, violations, skipped, tolerance };
}
