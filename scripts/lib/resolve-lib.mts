// Instance resolution: compose `master subtree + symbolOverrides` into a
// rendered tree. The load-bearing deterministic resolver the IR screen pass
// (Phase 7) reuses verbatim. NO top-level side effects — build-ir.mts imports it.
//
// Composition is pure: it follows the explicit symbolData.symbolOverrides[].
// guidPath.guids path with zero ambiguity (determinism contract). Placeholder
// *classification* is judgment and lives in describe-lib/reconcile-lib, not here.
import { load, key } from "./figma-index.mts";

export type ResolvedNode = {
  guid: string; // raw master key — NOT unique in a resolved tree (a master reused
  // N× yields N copies sharing guids). Use `path` for identity.
  path: string; // unique composite address = chain of instance guidKeys walked.
  type: string;
  name: string;
  // …the node's own raw fields are spread on too (size, transform, fillPaints,
  // fontName, textData, …) with overrides applied; describeNode reads them…
  children: ResolvedNode[];
  fromInstance?: string; // guidKey of the INSTANCE this subtree was composed for.
  hasTextOverride?: boolean; // textData came from an override.
  masterDefaultText?: string; // master's own characters (drives placeholder tag).
  overrideApplied?: Record<string, { from: unknown; to: unknown }>;
  unresolved?: string; // "remote master <componentKey>" | "cycle".
  unresolvedOverrides?: string[]; // override guidPaths that addressed no node in
  // this instance's subtree (surfaced, not dropped).
  [k: string]: unknown;
};

type Index = ReturnType<typeof load>;

const FIELD_KEYS = [
  "textData",
  "fillPaints",
  "strokePaints",
  "fontName",
  "fontSize",
  "size",
  "visible",
  "lineHeight",
  "letterSpacing",
  "textCase",
  "cornerRadius",
  "opacity",
  "strokeWeight",
  "effects",
  "textAlignHorizontal",
  "textAlignVertical",
  "textAutoResize",
  "leadingTrim",
] as const;

const DEPTH_CAP = 24;

// Build the resolved subtree for a single raw node `n`. `path` is the unique
// address of this node; `fromInstance` is set on instance-derived nodes.
// `visited` is the set of master guidKeys currently on the recursion stack
// (cycle guard); `depth` caps runaway nesting.
function buildNode(
  index: Index,
  n: any,
  path: string,
  fromInstance: string | undefined,
  visited: Set<string>,
  depth: number,
): ResolvedNode {
  const r: ResolvedNode = {
    ...n,
    guid: key(n.guid),
    path,
    type: n.type,
    name: n.name,
    children: [],
  };
  if (fromInstance) r.fromInstance = fromInstance;
  // Instance overrides address each master node by its `overrideKey` (a stable
  // cross-session id), NOT its session-rekeyed `guid`. Carry the normalized
  // overrideKey so applyOverride can match guidPath segments against it. Confirmed
  // against the decode: master TEXT 1140:12403 has overrideKey 14:5007, and the
  // instance override's guidPath is [14:5007], not [1140:12403].
  if (n.overrideKey) r._overrideKey = key(n.overrideKey);
  if (n.type === "TEXT") r.masterDefaultText = n.textData?.characters ?? "";

  if (n.symbolData?.symbolID) {
    // INSTANCE node: replace its (empty) subtree with the resolved master.
    resolveInstanceInto(index, n, r, path, visited, depth);
  } else {
    // Plain node: recurse over its raw children.
    for (const c of index.children.get(key(n.guid)) ?? []) {
      r.children.push(buildNode(index, c, `${path}/${key(c.guid)}`, fromInstance, visited, depth));
    }
  }
  return r;
}

// Resolve the INSTANCE node `inst` into the already-allocated ResolvedNode `r`
// (mutates r.children / r.unresolved). The instance's own transform/size stay on
// r (master root dropped); only the master's CHILDREN are composed in.
function resolveInstanceInto(
  index: Index,
  inst: any,
  r: ResolvedNode,
  path: string,
  visited: Set<string>,
  depth: number,
) {
  const masterKey = key(inst.symbolData.symbolID);
  const master = index.byKey.get(masterKey);
  if (!master) {
    r.unresolved = `remote master ${inst.componentKey ?? masterKey}`;
    return;
  }
  if (depth >= DEPTH_CAP || visited.has(masterKey)) {
    r.unresolved = "cycle";
    return;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(masterKey);
  const instKey = key(inst.guid);

  // The master ROOT is dropped (its children compose into r), so an override
  // guidPath whose head segment addresses the master root addresses THIS instance
  // node. The head may be the master root's overrideKey (e.g. path=[14:5006] for a
  // root `size` override → master root overrideKey 14:5006) or, when the root has
  // no overrideKey, its guid/symbolID (e.g. path=[179:5607]). Record both so
  // applyOverride can consume the head and resolve the rest as descendants of r.
  r._masterRootKey = master.overrideKey ? key(master.overrideKey) : key(master.guid);

  // If the master root frame carries layout/visual props the instance lacks,
  // adopt them (instances usually mirror these). Confirmed harmless: only fill
  // gaps, never clobber the instance's own values.
  for (const f of [
    "stackMode",
    "stackSpacing",
    "stackVerticalPadding",
    "stackHorizontalPadding",
    "stackPaddingBottom",
    "stackPaddingRight",
    "stackPrimaryAlignItems",
    "stackCounterAlignItems",
    "stackPrimarySizing",
    "stackCounterSizing",
    "stackWrap",
    "cornerRadius",
  ]) {
    if (r[f] === undefined && master[f] !== undefined) r[f] = master[f];
  }
  if (!(r.fillPaints as any[] | undefined)?.length && master.fillPaints?.length)
    r.fillPaints = master.fillPaints;

  // Compose master CHILDREN (drop master's own root transform — the instance's
  // transform is the on-screen placement). Each child keeps its master-relative
  // transform → one transform per ResolvedNode (Phase 7 abs-coords contract).
  for (const c of index.children.get(masterKey) ?? []) {
    r.children.push(buildNode(index, c, `${path}/${key(c.guid)}`, instKey, nextVisited, depth + 1));
  }

  // Apply this instance's overrides onto the freshly-composed subtree.
  for (const o of inst.symbolData.symbolOverrides ?? []) {
    applyOverride(r, o);
  }
}

// Find a node addressed by an override guidPath segment anywhere in `node`'s
// subtree (descendant search; excludes `node` itself). Each guidPath segment is a
// descendant address within the current (instance) subtree, not a direct-child
// step — confirmed against the decode.
//
// The segment is matched against the node's `overrideKey` FIRST (the stable
// cross-session id instance overrides actually target — see buildNode), falling
// back to the session-rekeyed `guid` for the minority of overrides authored
// against guids. Matching guid alone silently dropped ~88% of real text overrides.
function findDescendant(node: ResolvedNode, seg: string): ResolvedNode | undefined {
  for (const c of node.children ?? []) {
    if (c._overrideKey === seg || c.guid === seg) return c;
    const hit = findDescendant(c, seg);
    if (hit) return hit;
  }
  return undefined;
}

// Walk the override's guidPath through the resolved subtree and apply the
// override's fields to the addressed node. Each segment descends (any depth)
// within the current subtree, crossing nested-instance boundaries.
//
// If a segment can't be resolved (a genuinely stale reference — the master node
// it targeted no longer exists under either overrideKey or guid), the override is
// surfaced on the instance root's `unresolvedOverrides` rather than silently
// dropped, so the gap is visible (README "surface it instead so the gap is lost").
function applyOverride(r: ResolvedNode, o: any) {
  const guids: string[] = (o.guidPath?.guids ?? []).map((g: any) => key(g));
  if (!guids.length) return;
  let cur: ResolvedNode = r;
  // The head segment may address r itself (the master root, dropped into r); if
  // so, consume it and continue resolving the rest as descendants of r.
  let start = 0;
  if (guids[0] === r._masterRootKey || guids[0] === r._overrideKey || guids[0] === r.guid)
    start = 1;
  for (let i = start; i < guids.length; i++) {
    const next = findDescendant(cur, guids[i]);
    if (!next) {
      (r.unresolvedOverrides ??= []).push(guids.join("/"));
      return; // stale guidPath segment — recorded above, not silently dropped
    }
    cur = next;
  }
  const target = cur;
  const applied: Record<string, { from: unknown; to: unknown }> = target.overrideApplied ?? {};
  for (const f of FIELD_KEYS) {
    if (o[f] === undefined) continue;
    applied[f] = { from: (target as any)[f], to: o[f] };
    (target as any)[f] = o[f];
    if (f === "textData") {
      target.hasTextOverride = true;
      target.masterDefaultText = undefined; // overridden → not a master default
    }
  }
  if (Object.keys(applied).length) target.overrideApplied = applied;
}

// Resolve a single INSTANCE by guidKey: returns the composed subtree rooted at
// the instance node (its children are the resolved master children).
export function resolveInstance(index: Index, instanceGuidKey: string): ResolvedNode {
  const inst = index.byKey.get(instanceGuidKey);
  if (!inst) throw new Error("resolveInstance: node not found: " + instanceGuidKey);
  if (!inst.symbolData?.symbolID)
    throw new Error("resolveInstance: not an INSTANCE: " + instanceGuidKey);
  return buildNode(index, inst, instanceGuidKey, undefined, new Set(), 0);
}

// Resolve a whole screen/frame: deep-walk; wherever a node is an INSTANCE,
// substitute the resolved master subtree; non-instances recurse normally.
export function resolveScreen(index: Index, rootGuidKey: string): ResolvedNode {
  const root = index.byKey.get(rootGuidKey);
  if (!root) throw new Error("resolveScreen: node not found: " + rootGuidKey);
  return buildNode(index, root, rootGuidKey, undefined, new Set(), 0);
}
