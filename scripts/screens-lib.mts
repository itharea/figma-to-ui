// IR screen pass (Phase 7 / IR-PLAN Phase 2) — reconcile once, with provenance.
// Walks the RESOLVED tree (resolve-lib) and bakes the truth into clean fields PLUS
// provenance: {value, source, conflicts[]} on every reconciled field and a `guid`
// on every node. NO top-level side effects — build-ir.mts imports buildScreen().
//
// Determinism contract (README): DETECTION always runs and is exact (instance
// composition by explicit guidPath, conflict detection arithmetic, unit
// conversion, abs coords). RESOLUTION is a labelled heuristic (geometry-16 over
// declared-28, placeholder classification) — it sets `source`/`*Source` and
// populates `conflicts[]`, and is NEVER presented as ground truth. Token slots
// (`color.{token,match}`, `font.{sizeToken,sizeMatch}`) stay null here; Phase 8's
// --theme fills them.
import * as crypto from "crypto";
import { colorStr, mul, nodeMat, type Mat } from "./lib.mts";
import {
  reconcileTextSize,
  letterSpacingToPx,
  lineHeightPx,
  classifyPlaceholderText,
  type Conflict,
} from "./reconcile-lib.mts";
import type { ResolvedNode } from "./resolve-lib.mts";

// --- IR node shape (matches phase-07 §5) -----------------------------------
export type IRTextField = {
  value: string;
  source: "override" | "master-default";
  placeholder: boolean;
  reason: string;
};
export type IRFont = {
  family: string | null;
  appFamily: string | null;
  weight: string | null;
  size: number;
  sizeSource: "fontSize" | "geometry";
  sizeToken: string | null;
  sizeMatch: string | null;
  lineHeightPx: number | null;
  lineHeightSource: "fontSize";
  letterSpacingPx: number;
  letterSpacingRaw: { value: number; units: string };
  conflicts: Conflict[];
};
export type IRColor = { hex: string | null; token: string | null; match: string | null };
export type IRBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  absX: number;
  absY: number;
};
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

// First visible solid fill → hex (the node's own color). Mirrors describe-lib's
// paintStr SOLID branch so IR `color.hex` and the raw dump render identically.
function solidHex(node: any): string | null {
  const fills: any[] = node.fillPaints ?? [];
  for (const p of fills) {
    if (p?.visible === false) continue;
    if (p?.type === "SOLID" && p.color) return colorStr(p.color);
  }
  return null;
}

// Reconcile one resolved TEXT node into the IR `font`/`text`/`color` provenance
// objects. `appFamilyOf` maps a raw family → its decided appFamily slot (null
// until decided in Phase 8).
function reconcileText(
  n: ResolvedNode,
  appFamilyOf: (family: string | null) => string | null
): { text: IRTextField; font: IRFont; color: IRColor; styleRuns: number } {
  const rec = reconcileTextSize(n as any); // {size, source, conflicts[]} — verbatim
  const conflicts: Conflict[] = [...rec.conflicts];
  const family = (n as any).fontName?.family ?? null;
  const declaredSize = typeof (n as any).fontSize === "number" ? (n as any).fontSize : rec.size;
  // lineHeightPx is the DECLARED line height converted at the reconciled size; it
  // is NOT geometry-reconciled (an open size conflict marks it stale — §5 rules).
  const lhPx = lineHeightPx((n as any).lineHeight, rec.size);
  const lsRaw = (n as any).letterSpacing ?? { value: 0, units: "PIXELS" };

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
    weight: (n as any).fontName?.style ?? null,
    size: rec.size,
    sizeSource: rec.source,
    sizeToken: null,
    sizeMatch: null,
    lineHeightPx: lhPx,
    lineHeightSource: "fontSize",
    letterSpacingPx: letterSpacingToPx(lsRaw, rec.size),
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

  const color: IRColor = { hex: solidHex(n), token: null, match: null };
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
  appFamilyOf: (family: string | null) => string | null
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
    const { text, font, color, styleRuns } = reconcileText(n, appFamilyOf);
    node.text = text;
    node.font = font;
    node.color = color;
    node.styleRuns = styleRuns;
    node.autoResize = (n as any).textAutoResize ?? null;
  } else {
    const hex = solidHex(n);
    if (hex) node.color = { hex, token: null, match: null };
  }

  // unresolved (remote/library master absent, or cycle): emit the node carrying
  // its string and STOP recursing here (§5 / §6 step 1) — never drop it.
  if (n.unresolved) {
    node.unresolved = n.unresolved;
    return node;
  }

  for (const c of n.children ?? []) {
    if ((c as any).visible === false) continue;
    const childAcc = mul(acc, nodeMat(c as any));
    node.children.push(toIR(c, childAcc, appFamilyOf));
  }
  return node;
}

// Build the IR screen node from a RESOLVED screen root. `rootAbsMat` is the affine
// from the page root down to (and including) the screen root (lib.absMat(root)) —
// the screen frame is a direct raw node, so absMat is valid for that seed (§6
// step 3). `appFamily` maps raw family → decided appFamily slot (or null).
export function buildScreen(
  resolvedRoot: ResolvedNode,
  rootAbsMat: Mat,
  appFamily: Record<string, string> = {}
): IRNode {
  const appFamilyOf = (family: string | null): string | null =>
    family != null && appFamily[family] ? appFamily[family] : null;
  return toIR(resolvedRoot, rootAbsMat, appFamilyOf);
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
