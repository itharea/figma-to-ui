// Deterministic IR assembly helpers (IR-PLAN Phase 1). NO top-level side effects
// — build-ir.mts imports these at build time. Everything here is a pure function
// of the decoded bytes: slug derivation, token kind-split, composite typography/
// effect assembly, and font collection. Faithful defaults handle the rest (the Figma
// family for fonts, the literal hex for unmatched colours); no decisions overlay.
import { load, key, colorStr } from "./figma-index.mts";
import { letterSpacingToPx, lineHeightPx } from "./reconcile-lib.mts";
import type { Token } from "./tokens-lib.mts";

// --- token kind-split (pass 2a) --------------------------------------------
// COLOR → colors; FLOAT split by semantics (radius-named → radius, else spacing).
// Typography/line-height FLOATs are grouped into typography (pass 2b), not here,
// so they are excluded from spacing.
export type TokenKind = "color" | "spacing" | "radius" | "typography-float";
export function floatKind(name: string): "spacing" | "radius" | "typography-float" {
  const p = name.toLowerCase();
  if (/radius|corner|rounded/.test(p)) return "radius";
  if (/typography\/(size|spacing|line-height)|font|leading|lineheight|line-height/.test(p))
    return "typography-float";
  return "spacing";
}

export type IRToken = {
  id: string; // ir node id ("token:<guid>")
  name: string;
  set: string;
  // variableResolvedType (COLOR | FLOAT | STRING | BOOLEAN) — carried through so a
  // consumer (theme-gen) can choose hex vs bare-number vs quoted-string emission.
  type: string;
  modes: Record<string, string>;
  guid: string;
  defaultMode: string; // the token's collection default mode (see Token.defaultMode)
  aliasOf?: Record<string, string>;
  aliasTargets?: Record<string, string>; // mode name → direct alias target guidKey
};
const irToken = (t: Token): IRToken => ({
  id: `token:${t.guid}`,
  name: t.name,
  set: t.setName,
  type: t.type,
  modes: t.modes,
  guid: t.guid,
  defaultMode: t.defaultMode,
  ...(t.aliasOf ? { aliasOf: t.aliasOf } : {}),
  ...(t.aliasTargets ? { aliasTargets: t.aliasTargets } : {}),
});

// The COMPLETE variable catalog as IRTokens — every resolved variable regardless of
// type (COLOR/FLOAT/STRING/BOOLEAN), in source order. splitTokens() buckets a SUBSET
// by sizing semantics (and drops STRING); this keeps the whole set so theme-gen has a
// lossless source. Pure pass-through of resolveVariables' output.
export function toIRTokens(tokens: Token[]): IRToken[] {
  return tokens.map(irToken);
}

// Split resolved variables into the per-file token buckets. Alias chains are
// already collapsed by resolveVariables; we keep `aliasOf` as provenance only.
export function splitTokens(tokens: Token[]): {
  colors: IRToken[];
  spacing: IRToken[];
  radius: IRToken[];
  typographyFloats: IRToken[];
} {
  const colors: IRToken[] = [];
  const spacing: IRToken[] = [];
  const radius: IRToken[] = [];
  const typographyFloats: IRToken[] = [];
  for (const t of tokens) {
    if (t.type === "COLOR") colors.push(irToken(t));
    else if (t.type === "FLOAT") {
      const k = floatKind(t.name);
      if (k === "radius") radius.push(irToken(t));
      else if (k === "typography-float") typographyFloats.push(irToken(t));
      else spacing.push(irToken(t));
    }
    // STRING/BOOLEAN: not a sizing/color token bucket in this phase.
  }
  return { colors, spacing, radius, typographyFloats };
}

// --- composite typography (pass 2b) ----------------------------------------
// Typography is a STYLE (separate node: styleType==="TEXT") in this file, not a
// variableResolvedType. Prefer text-style nodes; fall back to grouped Typography
// FLOAT variables only when no text styles exist. letterSpacingPx@size is computed
// from THAT entry's own font size via reconcile-lib (never a bare unit-less number).
// Per-property variable bindings on a text style — each typography field references
// its own Figma variable (the screenshot's Font/Size/Line height/Letter spacing rows:
// Typography/family/Display, Typography/size/2xl, …). The typography analogue of a
// fill's colorVar; each entry is the bound variable's NAME, or null when unbound.
export type TypeVars = {
  family: string | null;
  weight: string | null;
  size: string | null;
  lineHeight: string | null;
  letterSpacing: string | null;
};
export type IRTypography = {
  id: string;
  name: string;
  family: string | null;
  size: number | null;
  weight: string | null;
  lineHeightPx: number | null;
  "letterSpacingPx@size": number;
  textCase: string | null; // raw fig textCase enum (UPPER/LOWER/TITLE/…) or null
  vars: TypeVars; // per-property variable bindings (design tokens), names or null
  source: "text-style" | "grouped-variables";
  guid?: string;
};

// Pull the variable-alias guidKey out of one variableConsumptionMap entry payload.
// Most fields nest it at variableData.value.alias.guid; FONT_STYLE wraps it in
// value.fontStyleValue.asString.value.alias.guid. Returns null when not an alias.
function consumptionAliasGuid(variableData: any): string | null {
  const v = variableData?.value;
  const alias = v?.alias ?? v?.fontStyleValue?.asString?.value?.alias;
  const g = alias?.guid;
  if (!g || g.sessionID === undefined || g.localID === undefined) return null;
  return `${g.sessionID}:${g.localID}`;
}

// fig variableField → our TypeVars key. (FONT_STYLE carries the weight axis.)
const TYPE_VAR_FIELD: Record<string, keyof TypeVars> = {
  FONT_FAMILY: "family",
  FONT_STYLE: "weight",
  FONT_SIZE: "size",
  LINE_HEIGHT: "lineHeight",
  LETTER_SPACING: "letterSpacing",
};

// The per-property variable bindings on a TEXT STYLE node, resolved to variable NAMES
// via `varNames` (variable guidKey → name). Reads node.variableConsumptionMap.entries.
function textVarBindings(styleNode: any, varNames: Map<string, string>): TypeVars {
  const out: TypeVars = {
    family: null,
    weight: null,
    size: null,
    lineHeight: null,
    letterSpacing: null,
  };
  const entries = styleNode?.variableConsumptionMap?.entries ?? [];
  for (const e of entries) {
    const field = TYPE_VAR_FIELD[e?.variableField];
    if (!field) continue;
    const gk = consumptionAliasGuid(e.variableData);
    if (gk && varNames.has(gk)) out[field] = varNames.get(gk)!;
  }
  return out;
}

export function assembleTypography(index: ReturnType<typeof load>): IRTypography[] {
  const { nodes } = index;
  // variable guidKey → name, to resolve each style's per-property variable bindings.
  const varNames = new Map<string, string>();
  for (const n of nodes)
    if (n.type === "VARIABLE" && n.guid) varNames.set(key(n.guid), n.name ?? "");
  const styles = nodes.filter((n) => n.styleType === "TEXT");
  if (styles.length) {
    return styles.map((n) => {
      const size = typeof n.fontSize === "number" ? n.fontSize : null;
      return {
        id: `type:${key(n.guid)}`,
        name: n.name ?? key(n.guid),
        family: n.fontName?.family ?? null,
        size,
        weight: n.fontName?.style ?? null,
        lineHeightPx: lineHeightPx(n.lineHeight, size ?? 0),
        "letterSpacingPx@size": letterSpacingToPx(n.letterSpacing, size ?? 0),
        textCase: typeof n.textCase === "string" ? n.textCase : null,
        vars: textVarBindings(n, varNames),
        source: "text-style",
        guid: key(n.guid),
      };
    });
  }
  // Fallback: group Typography/* FLOAT variables by their last-but-one path part
  // (size/line-height/spacing) keyed on the leaf (xs, m, l…). One entry per leaf.
  const floats = nodes.filter(
    (n) =>
      n.type === "VARIABLE" &&
      n.variableResolvedType === "FLOAT" &&
      /typography\//i.test(n.name ?? ""),
  );
  const byLeaf = new Map<string, { size?: number; lh?: number; ls?: number; guid: string }>();
  for (const n of floats) {
    const parts = (n.name as string).split("/");
    const leaf = parts[parts.length - 1];
    const kind = parts[parts.length - 2]?.toLowerCase();
    const v = Number(Object.values(firstModes(n))[0]);
    const e = byLeaf.get(leaf) ?? { guid: key(n.guid) };
    if (kind === "size") e.size = v;
    else if (kind === "line-height") e.lh = v;
    else if (kind === "spacing") e.ls = v;
    byLeaf.set(leaf, e);
  }
  return [...byLeaf.entries()].map(([leaf, e]) => ({
    id: `type:${e.guid}`,
    name: `Typography/${leaf}`,
    family: null,
    size: e.size ?? null,
    weight: null,
    lineHeightPx: e.lh ?? null,
    "letterSpacingPx@size":
      e.ls != null && e.size != null
        ? letterSpacingToPx({ value: e.ls, units: "PIXELS" }, e.size)
        : 0,
    textCase: null,
    vars: { family: null, weight: null, size: null, lineHeight: null, letterSpacing: null },
    source: "grouped-variables",
  }));
}

function firstModes(n: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of n.variableDataValues?.entries ?? []) {
    const v = e.variableData?.value;
    if (v?.floatValue !== undefined) out[String(e.modeID?.localID ?? "0")] = v.floatValue;
  }
  return out;
}

// --- composite effects (pass 2b) -------------------------------------------
// Effects are also a STYLE (styleType==="EFFECT"), not a variable. Each carries
// an `effects[]` array of shadow/blur descriptors.
export type IREffect = {
  id: string;
  name: string;
  effects: any[];
  source: "effect-style";
  guid: string;
};
export function assembleEffects(index: ReturnType<typeof load>): IREffect[] {
  return index.nodes
    .filter((n) => n.styleType === "EFFECT")
    .map((n) => ({
      id: `effect:${key(n.guid)}`,
      name: n.name ?? key(n.guid),
      effects: (n.effects ?? []).map((e: any) => ({
        ...e,
        color: e.color ? colorStr(e.color) : undefined,
      })),
      source: "effect-style",
      guid: key(n.guid),
    }));
}

// --- fonts (pass 3) ---------------------------------------------------------
// Distinct fontName.family over the RAW nodes in the scoped pages plus the
// typography tokens, with a usage list. Reads fontName directly — no instance
// resolution needed (family is on the raw node). appFamily is the app-side family;
// build-ir defaults it to the Figma family (the faithful default — swap during elevation).
export type IRFont = {
  family: string;
  appFamily: string; // defaults to the Figma family (build-ir)
  usedBy: string[]; // up to N sample usage labels (node names / token names)
  count: number;
};
export function collectFonts(
  scopedNodes: any[],
  typography: IRTypography[],
  appFamilyMap: Record<string, string> = {},
): IRFont[] {
  const fams = new Map<string, { count: number; usedBy: Set<string> }>();
  const bump = (family: string | undefined | null, label: string) => {
    if (!family) return;
    const e = fams.get(family) ?? { count: 0, usedBy: new Set<string>() };
    e.count++;
    if (e.usedBy.size < 8) e.usedBy.add(label);
    fams.set(family, e);
  };
  for (const n of scopedNodes) bump(n.fontName?.family, n.name ?? n.type);
  for (const t of typography) bump(t.family, t.name);
  return [...fams.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([family, e]) => ({
      family,
      appFamily: appFamilyMap[family] ?? "",
      usedBy: [...e.usedBy],
      count: e.count,
    }));
}

// --- scope (pages → component sets + variable sets) ------------------------
// Returns the CANVAS (page) ancestor of a node, or null.
export function pageOf(index: ReturnType<typeof load>, node: any): any | null {
  let cur = node;
  while (cur && cur.type !== "CANVAS")
    cur = cur.parentIndex ? index.byKey.get(key(cur.parentIndex.guid)) : null;
  return cur;
}

// Screen roots to resolve in the screen pass (Phase 7): each direct child of a
// scoped CANVAS page that is a container (FRAME/SECTION/INSTANCE) — the top-level
// "screen frames". Returns [{page, root}] preserving document order. scopePages:
// lower-cased page-name set, or null = all pages.
const SCREEN_ROOT_TYPES = new Set(["FRAME", "SECTION", "INSTANCE", "COMPONENT"]);
export function scopedScreenRoots(
  index: ReturnType<typeof load>,
  scopePages: Set<string> | null,
): { page: any; root: any }[] {
  const out: { page: any; root: any }[] = [];
  for (const n of index.nodes) {
    if (n.type !== "CANVAS") continue;
    if (scopePages && !scopePages.has((n.name ?? "").toLowerCase())) continue;
    for (const c of index.children.get(key(n.guid)) ?? []) {
      if (SCREEN_ROOT_TYPES.has(c.type)) out.push({ page: n, root: c });
    }
  }
  return out;
}

// Collect the raw nodes (and their subtree) that live on the scoped pages.
// scopePages: lower-cased page-name set, or null = all pages.
export function scopedRawNodes(
  index: ReturnType<typeof load>,
  scopePages: Set<string> | null,
): any[] {
  if (!scopePages) return index.nodes;
  return index.nodes.filter((n) => {
    const pg = pageOf(index, n);
    return pg && scopePages.has((pg.name ?? "").toLowerCase());
  });
}
