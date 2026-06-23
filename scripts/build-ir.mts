// build-ir.mts — the deterministic IR compiler (IR-PLAN Phases 0–1 / spec phase-06).
// Stands up a scoped, provenance-stamped IR: manifest + raw-map + fonts + tokens/*
// + components/*. NO screen resolution yet (Phase 7). Everything emitted here is a
// PURE FUNCTION OF THE BYTES — no heuristic picks. The only judgment slot is
// fonts.json's empty appFamily (pre-seeded only from an explicit --decisions map).
//
// Usage:
//   node build-ir.mts <message.json> --scope <pages|guids>
//        [--theme <path>] [--decisions <decisions.json>] [--out ir-<name>] [--force]
//
// IMPORTANT: imports ONLY *-lib.mts modules (never a CLI script) — those run work
// at import time. console.error = progress; console.log = the artifact summary.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { load, absMat } from "./lib.mts";
import { resolveVariables, loadTheme, type ThemeEntry } from "./tokens-lib.mts";
import {
  findComponentSets,
  parseVariantMatrix,
  proposePropApi,
  extractComponentProps,
  sameNodeGroups,
  extractVariantBindings,
} from "./components-lib.mts";
import { resolveScreen, type ResolvedNode } from "./resolve-lib.mts";
import { buildScreen, registerRawMap, provenanceViolations, type IRNode, type VarIndex } from "./screens-lib.mts";
import {
  fontMapOf,
  decisionKey,
  mapNodeTokens,
  applyFontMap,
  applyPlaceholders,
  aggregateScreenIntent,
  collectConflictItems,
  buildDefaultVariantMap,
  fontTokenCollisions,
  type Decisions,
  type IntentItem,
} from "./mapping-lib.mts";
import {
  uniqueSlug,
  splitTokens,
  assembleTypography,
  assembleEffects,
  collectFonts,
  scopedRawNodes,
  scopedScreenRoots,
  pageOf,
  type IRTypography,
} from "./ir-lib.mts";

const IR_SCHEMA_VERSION = 1;

const argv = process.argv.slice(2);
const msgPath = argv[0];
if (!msgPath || msgPath.startsWith("--"))
  throw new Error(
    "usage: build-ir.mts <message.json> --scope <pages|guids> [--theme <path>] [--decisions <decisions.json>] [--out ir-<name>] [--force]"
  );

// positionally-tolerant flag scan
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const hasFlag = (name: string) => argv.includes(name);

const scopeArg = flag("--scope");
if (!scopeArg) throw new Error("--scope is mandatory: --scope <comma-separated page names | guidKeys | 'all'>");
const themePath = flag("--theme"); // Phase 8: map IR color/font.size → code tokens by value
const decisionsPath = flag("--decisions");
const force = hasFlag("--force");

const name = path.basename(msgPath).replace(/^(msg-|message[-_]?)/, "").replace(/\.json$/, "") || "new";
const outDir = flag("--out") ?? `ir-${name}`;

// --- source hash + decisions identity (staleness contract) ------------------
const srcBytes = fs.readFileSync(msgPath);
const sourceHash = crypto.createHash("sha256").update(srcBytes).digest("hex");
let decisions: Decisions = {};
let decisionsHash = "";
if (decisionsPath && fs.existsSync(decisionsPath)) {
  const dBytes = fs.readFileSync(decisionsPath);
  decisionsHash = crypto.createHash("sha256").update(dBytes).digest("hex");
  try {
    decisions = JSON.parse(dBytes.toString("utf8"));
  } catch {
    throw new Error(`--decisions: ${decisionsPath} is not valid JSON`);
  }
}
// decisions: fontMap (alias appFamily seed), tokenConfirms/tokenRejects, placeholders.
const fontMap = fontMapOf(decisions);
const tokenConfirms: Record<string, string> = decisions.tokenConfirms ?? {};
const tokenRejects = new Set<string>(decisions.tokenRejects ?? []);
const placeholders = decisions.placeholders ?? {};

// --- re-run / overwrite guard ----------------------------------------------
const manifestPath = path.join(outDir, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const prev = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (prev.sourceHash === sourceHash && (prev.decisionsHash ?? "") === decisionsHash && !force) {
    console.error(`no-op: ${outDir} already built from this source + decisions (use --force to rebuild)`);
    console.log(JSON.stringify({ noop: true, out: outDir, sourceHash }, null, 2));
    process.exit(0);
  }
  if (prev.sourceHash !== sourceHash && !force)
    throw new Error(
      `refusing to overwrite ${outDir}: it was built from a DIFFERENT source (hash ${String(prev.sourceHash).slice(0, 12)}… ≠ ${sourceHash.slice(0, 12)}…). Pass --force or pick another --out.`
    );
}

// --- pass 1: index ----------------------------------------------------------
console.error("pass 1: index", msgPath);
const index = load(msgPath);

// --- scope resolution -------------------------------------------------------
// --scope is a comma list of page NAMES (default) or 'all'. (guidKey scoping is a
// superset hook for Phase 7's screen pass; pages cover this phase's contracts.)
const scopeRaw = scopeArg.split(",").map((s) => s.trim()).filter(Boolean);
const allPages = scopeRaw.length === 1 && scopeRaw[0].toLowerCase() === "all";
const scopePages = allPages ? null : new Set(scopeRaw.map((s) => s.toLowerCase()));
const scoped = scopedRawNodes(index, scopePages);
console.error(`scope: ${allPages ? "all pages" : scopeRaw.join(", ")} → ${scoped.length} raw nodes`);

// --- pass 2a: primitive variable tokens -------------------------------------
console.error("pass 2a: variable tokens (alias chains collapsed)");
// Variables parent to a VARIABLE_SET, not a page — they are the file's shared
// token layer. We emit every resolved variable set regardless of page scope (the
// scope governs pages' COMPONENT SETS and which RAW nodes fonts are collected over;
// per-mode variable values are file-global). guid-level variable-set scoping for a
// guids-scope is a Phase-7 refinement.
const resolvedVars = resolveVariables(index);
const { colors, spacing, radius } = splitTokens(resolvedVars);

// Variable-binding index (improvement A-variables / spec #3): variable guidKey →
// { name, value }, built ONCE from the resolved COLOR variables. `value` is the
// variable's RESOLVED concrete hex (single-mode in this decode → that mode's value;
// alias chains already collapsed by resolveVariables). buildScreen's shared
// resolver reads it to attach the design token AND substitute the resolved value
// for the (possibly stale) cached paint.color on every variable-bound fill/stroke
// (paint.colorVar ALIAS) as GROUND TRUTH — never re-resolved per node. SCOPED to
// COLOR bindings (fill/text colorVar); numeric bindings (cornerRadius/stackSpacing
// via variableConsumptionMap) are a clear TODO — that map's structure is ambiguous
// and would be a guess here.
const varIndex: VarIndex = new Map();
for (const t of resolvedVars)
  if (t.type === "COLOR") varIndex.set(t.guid, { name: t.name, value: Object.values(t.modes)[0] ?? null });
console.error(`  variable-binding index: ${varIndex.size} color variable(s)`);

// --- pass 2b: composite styles ---------------------------------------------
console.error("pass 2b: composite typography + effects");
const typography = assembleTypography(index);
const effects = assembleEffects(index);

// --- pass 3: fonts ----------------------------------------------------------
console.error("pass 3: fonts (raw fontName.family over scoped nodes + typography)");
const fonts = collectFonts(scoped, typography, fontMap);

// --- pass 4: components -----------------------------------------------------
console.error("pass 4: component sets + variant matrix + prop API");
const allSets = findComponentSets(index);
const sets = allPages
  ? allSets
  : allSets.filter((s) => {
      const node = index.byKey.get(s.guid);
      const pg = node ? pageOf(index, node) : null;
      return pg && scopePages!.has((pg.name ?? "").toLowerCase());
    });

// --- theme (Phase 8): load once for by-value token mapping in pass 5 --------
let theme: ThemeEntry[] = [];
if (themePath) {
  console.error(`pass 4b: theme ${themePath} (token mapping by value, within kind)`);
  theme = loadTheme(themePath);
  console.error(`  ${theme.length} theme entries`);
}

// --- emit -------------------------------------------------------------------
fs.mkdirSync(path.join(outDir, "tokens"), { recursive: true });
fs.mkdirSync(path.join(outDir, "components"), { recursive: true });

// ir node id → raw guidKey. Token/component entries are a bare guidKey string;
// screen nodes (Phase 7) carry {guid, path} (a resolved node's guid is non-unique,
// so `path` is the stable address — §5 identity rule).
const rawMap: Record<string, string | { guid: string; path: string }> = {};
const stamp = (irId: string, guidKey: string) => {
  rawMap[irId] = guidKey;
};

const writeJSON = (rel: string, data: any) =>
  fs.writeFileSync(path.join(outDir, rel), JSON.stringify(data, null, 2));

for (const t of [...colors, ...spacing, ...radius]) stamp(t.id, t.guid);
for (const t of typography) if (t.guid) stamp(t.id, t.guid);
for (const e of effects) stamp(e.id, e.guid);

writeJSON("tokens/colors.json", colors);
writeJSON("tokens/spacing.json", spacing);
writeJSON("tokens/radius.json", radius);
writeJSON("tokens/typography.json", typography);
writeJSON("tokens/effects.json", effects);
writeJSON("fonts.json", fonts);

const componentFiles: string[] = [];
const taken = new Set<string>();
for (const set of sets) {
  const slug = uniqueSlug(set.name, taken);
  const matrix = parseVariantMatrix(set);
  // Non-variant prop API (improvement A-props): text/boolean/instanceSwap defs on
  // the set frame, with their bindings into a representative master subtree, plus
  // same-node groupings so Phase-B codegen can collapse bool-visible+text pairs.
  const props = extractComponentProps(index, set.guid);
  // Per-variant bindings (improvement B-codegen): the multi-file codegen renders
  // EACH variant's own subtree, so each variant master must resolve the set props
  // onto ITS OWN node guids (props[].bindings only address the default master).
  // Keyed by variant guidKey; joined to props[] by defKey.
  const variantBindings = extractVariantBindings(
    index,
    set.guid,
    set.variants.map((v) => v.guid)
  );
  const rec = {
    id: `component:${set.guid}`,
    name: set.name,
    guid: set.guid,
    detectedBy: set.detectedBy,
    confidence: set.confidence,
    size: set.size ?? null,
    axes: matrix.axes,
    propApi: proposePropApi(matrix),
    props,
    propGroups: sameNodeGroups(props),
    variants: set.variants.map((v) => ({
      id: `variant:${v.guid}`,
      props: v.props,
      rawName: v.rawName,
      guidKey: v.guid,
      size: v.size ?? null,
      // bindings resolved against THIS variant's own subtree (improvement B-codegen);
      // [] when the variant exposes none of the set props. Joined to props[] by defKey.
      bindings: variantBindings[v.guid] ?? [],
      subtree: null as null, // TODO(phase-7): resolved variant subtree
    })),
  };
  stamp(rec.id, set.guid);
  for (const v of rec.variants) stamp(v.id, v.guidKey);
  writeJSON(`components/${slug}.json`, rec);
  componentFiles.push(`${slug}.json`);
}

// --- pass 5: resolved screens (Phase 7) -------------------------------------
// For each scoped screen root: resolveScreen (compose instances) → reconcile text
// (geometry-vs-font, units, placeholders) → abs coords over the RESOLVED tree →
// emit screens/<page>/<screen>.json with full provenance. Every node carries a
// path-derived `id`, its raw `guid`, and is registered in raw-map as {guid,path}.
console.error("pass 5: resolved screens (compose + reconcile + provenance)");
const appFamily: Record<string, string> = {};
for (const f of fonts) if (f.appFamily) appFamily[f.family] = f.appFamily;
// Applied-text-style index: style guidKey → its typography token. reconcileText reads
// it (via styleIdForText) as the CERTAIN designer-intent source for a node's
// font/lineHeight/textCase, ahead of the geometry heuristic and a possibly-stale cache.
const typeStyles = new Map<string, IRTypography>();
for (const t of typography) if (t.guid) typeStyles.set(t.guid, t);

const screenRoots = scopedScreenRoots(index, scopePages);
const screenFiles: string[] = [];
const screenSlugs = new Map<string, Set<string>>(); // per page-slug → taken screen slugs
let totalScreenNodes = 0;
let unresolvedCount = 0;
const allViolations: string[] = [];
// intent aggregation (pass 6): default-variant map once; items collected per screen.
const defaultVariant = buildDefaultVariantMap(index);
const intentItems: IntentItem[] = [];

for (const { page, root } of screenRoots) {
  const rootKey = root.guid ? `${root.guid.sessionID}:${root.guid.localID}` : null;
  if (!rootKey) continue;
  let irRoot: IRNode;
  let resolved: ResolvedNode;
  try {
    resolved = resolveScreen(index, rootKey);
    irRoot = buildScreen(resolved, absMat(index, rootKey), appFamily, varIndex, typeStyles);
  } catch (e) {
    console.error(`  ⚠ screen ${rootKey} (${root.name}): ${(e as Error).message} — skipped`);
    continue;
  }
  // §6a: map color/font.size → code tokens by value (no --theme → all null).
  if (theme.length) mapNodeTokens(irRoot, theme, tokenConfirms, tokenRejects);
  // §6c decisions overlay: fontMap → appFamily, placeholders → text.
  if (Object.keys(fontMap).length) applyFontMap(irRoot, fontMap);
  if (Object.keys(placeholders).length) applyPlaceholders(irRoot, placeholders);
  // §6b intent aggregation: predicates over the RESOLVED tree + the IR's conflicts.
  const screenLabel = `${root.name ?? root.type} [${rootKey}]`;
  intentItems.push(...aggregateScreenIntent(resolved, screenLabel, defaultVariant));
  intentItems.push(...collectConflictItems(irRoot, screenLabel));
  // register raw-map + provenance check + counts
  registerRawMap(irRoot, rawMap as Record<string, { guid: string; path: string }>);
  allViolations.push(...provenanceViolations(irRoot));
  const countNodes = (n: IRNode): number => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
  const countUnresolved = (n: IRNode): number =>
    (n.unresolved ? 1 : 0) + n.children.reduce((a, c) => a + countUnresolved(c), 0);
  totalScreenNodes += countNodes(irRoot);
  unresolvedCount += countUnresolved(irRoot);

  const pageSlug = uniqueSlug(page.name ?? page.type, new Set()); // page-level slug (no global collide)
  const taken = screenSlugs.get(pageSlug) ?? new Set<string>();
  screenSlugs.set(pageSlug, taken);
  const screenSlug = uniqueSlug(root.name ?? root.type, taken);
  fs.mkdirSync(path.join(outDir, "screens", pageSlug), { recursive: true });
  const rel = `screens/${pageSlug}/${screenSlug}.json`;
  writeJSON(rel, irRoot);
  screenFiles.push(rel);
}
console.error(
  `  ${screenFiles.length} screens, ${totalScreenNodes} nodes, ${unresolvedCount} unresolved leaves` +
    (allViolations.length ? `, ⚠ ${allViolations.length} provenance violations` : ", provenance clean")
);
if (allViolations.length)
  for (const v of allViolations.slice(0, 10)) console.error(`    ⚠ ${v}`);

// --- pass 6: aggregate intent.json + issues.json (Phase 8 §6b) --------------
// intent.json = the per-build designer-intent gap list (P2-5), aggregated across
// every scoped screen. issues.json = the automated ask-don't-ship list: build-time
// conflicts/warnings the human must resolve into decisions.json.
console.error("pass 6: aggregate intent.json + issues.json");

const intentByKind: Record<string, IntentItem[]> = {};
for (const it of intentItems) (intentByKind[it.kind] ??= []).push(it);
const intent = {
  scope: allPages ? "all" : scopeRaw,
  total: intentItems.length,
  counts: Object.fromEntries(Object.entries(intentByKind).map(([k, v]) => [k, v.length])),
  items: intentItems,
};
writeJSON("intent.json", intent);

// issues.json. Walk the emitted IR for unmapped fonts, match:none / unconfirmed
// nearest colors, styleRuns, missing provenance; plus token name-collisions.
type Issue = { kind: string; detail: string; guid?: string; path?: string; token?: string };
const issues: Issue[] = [];

// unmapped fonts: a collected family with empty appFamily and no fontMap entry.
for (const f of fonts)
  if (!f.appFamily && !fontMap[f.family])
    issues.push({ kind: "unmapped-font", detail: `font "${f.family}" has no appFamily and no decisions.fontMap entry (used ${f.count}×)`, token: f.family });

// token name-collisions (the praline-ramp trap): only meaningful with a theme.
if (theme.length) {
  for (const c of fontTokenCollisions(resolvedVars, theme))
    issues.push({
      kind: "token-name-collision",
      detail: `fig token "${c.figToken}" (${c.figValue}) shares leaf "${c.leaf}" with theme "${c.themeToken}" (${c.themeValue}) but the VALUE differs — by-value match must not silently bind them`,
      token: c.figToken,
    });
}

// walk every emitted screen IR for node-level issues (match:none colors, font
// match:none sizes, conflicts, styleRuns, missing provenance). Read from disk so
// the issues reflect exactly what was written (post-decisions).
const seenColorNone = new Set<string>();
const seenSizeNone = new Set<string>();
const walkIssues = (n: IRNode) => {
  // box-vs-font reconciliation conflicts
  for (const cf of n.font?.conflicts ?? [])
    issues.push({ kind: "reconcile-conflict", detail: `${n.name}: ${cf.field} ${cf.declared}→~${cf.chosen} (${cf.reason})`, guid: n.guid, path: n.path });
  if (n.styleRuns)
    issues.push({ kind: "style-runs", detail: `${n.name}: ${n.styleRuns} styleOverrideTable run(s) — node-level font may not match all runs`, guid: n.guid, path: n.path });
  // match:none / unconfirmed nearest colors (theme present only). "rejected"
  // (tokenRejects) suppresses the warning; "exact" is fine; "nearest" is surfaced.
  if (theme.length && n.color?.hex) {
    const m = n.color.match;
    if (m === "none" && !seenColorNone.has(n.color.hex)) {
      seenColorNone.add(n.color.hex);
      issues.push({ kind: "color-unmatched", detail: `color ${n.color.hex} matched no theme token (match:none)`, token: n.color.hex });
    } else if (typeof m === "string" && m.startsWith("nearest")) {
      issues.push({ kind: "color-nearest", detail: `color ${n.color.hex} only a ${m} theme match — confirm or reject in decisions.json`, guid: n.guid, path: n.path, token: n.color.hex });
    }
  }
  if (theme.length && n.font && typeof n.font.size === "number") {
    const m = n.font.sizeMatch;
    const k = String(n.font.size);
    if (m === "none" && !seenSizeNone.has(k)) {
      seenSizeNone.add(k);
      issues.push({ kind: "fontsize-unmatched", detail: `font size ${k}px matched no fontSize token (match:none)`, token: k });
    }
  }
  // missing provenance — must be EMPTY (a non-empty list is a build bug).
  for (const c of n.children) walkIssues(c);
};
for (const rel of screenFiles) walkIssues(JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf8")));
// provenance violations from pass 5 are build bugs — record them so issues.json
// surfaces them; the structural check (§9) asserts this list stays empty.
for (const v of allViolations) issues.push({ kind: "missing-provenance", detail: v });

const issuesByKind: Record<string, number> = {};
for (const is of issues) issuesByKind[is.kind] = (issuesByKind[is.kind] ?? 0) + 1;
writeJSON("issues.json", { total: issues.length, counts: issuesByKind, items: issues });
console.error(
  `  intent: ${intentItems.length} item(s); issues: ${issues.length} item(s)` +
    (allViolations.length ? ` (⚠ ${allViolations.length} missing-provenance — BUILD BUG)` : "")
);

writeJSON("raw-map.json", rawMap);

const manifest = {
  irSchemaVersion: IR_SCHEMA_VERSION,
  source: { path: path.resolve(msgPath), hash: sourceHash },
  sourceHash, // top-level mirror for the staleness re-read (Phase 9 diff-ir)
  decisionsHash,
  figFormatVersion: index.msg?.figFormatVersion ?? null,
  builtAt: new Date().toISOString(),
  scope: { kind: "pages", value: allPages ? "all" : scopeRaw },
  counts: {
    colors: colors.length,
    spacing: spacing.length,
    radius: radius.length,
    typography: typography.length,
    effects: effects.length,
    fonts: fonts.length,
    components: componentFiles.length,
    variants: sets.reduce((a, s) => a + s.variants.length, 0),
    screens: screenFiles.length,
    screenNodes: totalScreenNodes,
    unresolvedNodes: unresolvedCount,
    rawMapEntries: Object.keys(rawMap).length,
    intentItems: intentItems.length,
    issues: issues.length,
  },
  theme: themePath ? { path: path.resolve(themePath), entries: theme.length } : null,
  decisions: decisionsPath ? { path: path.resolve(decisionsPath), hash: decisionsHash } : null,
  artifacts: {
    tokens: ["colors.json", "spacing.json", "radius.json", "typography.json", "effects.json"],
    fonts: "fonts.json",
    components: componentFiles,
    rawMap: "raw-map.json",
    screens: screenFiles, // Phase 7: resolved screens pass (5)
    intent: "intent.json", // Phase 8: aggregate intent pass (6)
    issues: "issues.json", // Phase 8: ask-don't-ship list (6)
  },
};
writeJSON("manifest.json", manifest);

console.error(`wrote ${outDir}/  (${manifest.counts.components} components, ${fonts.length} fonts, ${colors.length}+${spacing.length}+${radius.length} primitive tokens)`);
console.log(JSON.stringify({ out: outDir, ...manifest.counts }, null, 2));
