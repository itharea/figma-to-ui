// Instance resolution: compose `master subtree + symbolOverrides` into a
// rendered tree. The load-bearing deterministic resolver the IR screen pass
// (Phase 7) reuses verbatim. NO top-level side effects — build-ir.mts imports it.
//
// Composition is pure: it follows the explicit symbolData.symbolOverrides[].
// guidPath.guids path with zero ambiguity (determinism contract), plus the equally
// explicit component-property wiring (componentPropDefs / componentPropAssignments /
// componentPropRefs). Placeholder *classification* is judgment and lives in
// describe-lib/reconcile-lib, not here.
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
  // The list above covers what a hand-authored override usually touches; the rest
  // below are fields real exports override that it dropped. Every one was observed
  // in a live symbolOverrides payload (on a 56-component library export: fillPaints
  // 2038, size 243, styleIdForFill 104, targetAspectRatio 93, stackPositioning 37,
  // parameterConsumptionMap 22, variableConsumptionMap 21, stackPrimarySizing 10,
  // overriddenSymbolID 8, styleIdForText 5, styleIdForStrokeFill 1). Leaving a field
  // out does not fail loudly — it silently renders the MASTER's value for an
  // instance the designer had changed, which is why this went unnoticed.
  //
  // Shared paint / text styles (styleIdFor*) re-point a node at a different style;
  // the *ConsumptionMap pair re-binds its design variables (colour, spacing, radius,
  // typography) — both change the resolved value, so both must ride along.
  "styleIdForFill",
  "styleIdForStrokeFill",
  "styleIdForText",
  "variableConsumptionMap",
  "parameterConsumptionMap",
  // Auto-layout: an instance may re-size, re-pad, re-space or lift a child out of
  // the flow (stackPositioning=ABSOLUTE) without touching the master. Names match
  // how screens-lib reads them (layoutOf / childLayoutOf).
  "stackPrimarySizing",
  "stackCounterSizing",
  "stackPositioning",
  "stackMode",
  "stackSpacing",
  "stackCounterSpacing",
  "stackHorizontalPadding",
  "stackVerticalPadding",
  "stackPaddingRight",
  "stackPaddingBottom",
  "stackPrimaryAlignItems",
  "stackCounterAlignItems",
  "stackChildPrimaryGrow",
  "stackChildAlignSelf",
  "stackWrap",
  "targetAspectRatio",
  // Per-corner radii + per-side borders (frames with independent corners/sides carry
  // these INSTEAD of the scalar cornerRadius/strokeWeight already listed above). Both
  // families are gated on their independence flag by the readers — cornerRadiusOf on
  // rectangleCornerRadiiIndependent, borderWidthsOf on borderStrokeWeightsIndependent
  // — so the flags must travel with the weights, or an override that switches a node
  // to (or away from) independent sides is read against the wrong branch.
  "rectangleTopLeftCornerRadius",
  "rectangleTopRightCornerRadius",
  "rectangleBottomLeftCornerRadius",
  "rectangleBottomRightCornerRadius",
  "rectangleCornerRadiiIndependent",
  "borderTopWeight",
  "borderBottomWeight",
  "borderLeftWeight",
  "borderRightWeight",
  "borderStrokeWeightsIndependent",
  // Instance swap (icon substitution). Applied as a plain field here; the
  // recomposeSwapped post-pass below rebuilds the subtree from the swapped master.
  "overriddenSymbolID",
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

  // Component PROPERTIES — Figma's modern override mechanism, entirely distinct from
  // symbolOverrides. The master declares `componentPropDefs` (TEXT / BOOL /
  // INSTANCE_SWAP / VARIANT) with a default; nodes inside it opt in via
  // `componentPropRefs: [{defID, componentPropNodeField}]`; the instance supplies
  // values via `componentPropAssignments`. None of this was read before, so
  // prop-driven copy fell back to the master default and prop-driven show/hide never
  // applied — the "text overrides are missing" symptom.
  //
  // Defaults first, then this instance's assignments (assignments win). Note that for
  // a master that belongs to a component SET, its own componentPropDefs entries are
  // stubs `{id, parentPropDefId}` — the human name/type/default live on the SET
  // frame's def, in a different id namespace (see components-lib's NAMESPACE JOIN
  // note). So this seeding loop yields null for set members and the assignments below
  // are the only value source, which is correct: an unassigned prop leaves the master
  // node's own field untouched, and that field already holds the default.
  const propValues = new Map<string, any>();
  for (const d of master.componentPropDefs ?? []) {
    if (d?.id) propValues.set(key(d.id), d.varValue?.value ?? d.initialValue ?? null);
  }
  for (const a of inst.componentPropAssignments ?? []) {
    if (a?.defID) propValues.set(key(a.defID), a.varValue?.value ?? a.value ?? null);
  }
  if (propValues.size) applyComponentProps(r, propValues);

  // Apply this instance's overrides onto the freshly-composed subtree. Deliberately
  // AFTER the props pass: an explicit symbolOverride is the designer's last word and
  // must win over the value a property supplied for the same node/field.
  for (const o of inst.symbolData.symbolOverrides ?? []) {
    applyOverride(r, o);
  }

  // An instance swap (from a prop or an override) re-points a nested INSTANCE at a
  // different master AFTER its subtree was already composed from the old one.
  // Re-compose those subtrees so the rendered children come from the master actually
  // in use.
  recomposeSwapped(index, r, nextVisited, depth + 1);
}

// Read each component-prop value into the concrete node field it drives:
// TEXT_DATA → textData, VISIBLE → visible, OVERRIDDEN_SYMBOL_ID → instance swap.
// `propValues` is keyed by def guidKey; a node opts in through its componentPropRefs.
// Walks the whole composed subtree because a ref can sit at any depth inside the
// master, including inside a nested instance that forwards the prop.
function applyComponentProps(r: ResolvedNode, propValues: Map<string, any>) {
  (function walk(n: ResolvedNode) {
    for (const ref of (n as any).componentPropRefs ?? []) {
      if (!ref?.defID) continue;
      const v = propValues.get(key(ref.defID));
      if (v === undefined || v === null) continue;
      switch (ref.componentPropNodeField) {
        case "TEXT_DATA": {
          // The value arrives as textDataValue (the varValue shape) or textValue (the
          // initialValue shape); both carry `characters`. Only apply when it really
          // has a string, so a malformed/empty payload leaves the master default.
          const td = v.textDataValue ?? v.textValue ?? v;
          if (td && typeof td.characters === "string") {
            const prev = (n as any).textData;
            // Preserve the master's rich-text metadata (styleOverrideTable / lines)
            // and swap only what the prop carries, so prop-driven copy keeps its
            // per-run styling instead of collapsing to a bare string.
            (n as any).textData = { ...(prev ?? {}), ...td };
            n.hasTextOverride = true;
            n.masterDefaultText = undefined; // supplied by a prop → not a master default
            ((n.overrideApplied ??= {}) as any).textData = {
              from: prev,
              to: (n as any).textData,
            };
          }
          break;
        }
        case "VISIBLE": {
          const b = v.boolValue;
          if (typeof b === "boolean") {
            ((n.overrideApplied ??= {}) as any).visible = { from: (n as any).visible, to: b };
            (n as any).visible = b;
          }
          break;
        }
        case "OVERRIDDEN_SYMBOL_ID": {
          // Trap: the two value shapes nest the guid DIFFERENTLY. varValue carries
          // `{symbolIdValue: {guid: {sessionID, localID}}}` while initialValue carries
          // `{guidValue: {sessionID, localID}}`. Reading `v.symbolIdValue` therefore
          // yields `{guid}`, not the guid, and key() on it produces
          // `unresolved: "remote master undefined:undefined"`. Unwrap the extra level.
          const sid = v.symbolIdValue?.guid ?? v.guidValue ?? v.alias?.guid ?? v.guid;
          if (sid?.sessionID !== undefined) (n as any).overriddenSymbolID = sid;
          break;
        }
      }
    }
    for (const c of n.children ?? []) walk(c);
  })(r);
}

// Post-pass: any node whose `overriddenSymbolID` (from a prop or an override) names a
// different master than the one its children were composed from gets its subtree
// rebuilt from the swapped master, so the rendered children come from the icon/component
// actually in use rather than the one the master happened to place.
function recomposeSwapped(
  index: Index,
  r: ResolvedNode,
  visited: Set<string>,
  depth: number,
): void {
  (function walk(n: ResolvedNode) {
    const swap = (n as any).overriddenSymbolID;
    const current = (n as any).symbolData?.symbolID;
    if (swap && current && key(swap) !== key(current)) {
      // Point the node itself at the swapped master BEFORE recomposing, so the swap is
      // IDEMPOTENT. resolveInstanceInto reads the master back off symbolData.symbolID,
      // so a node still advertising its ORIGINAL symbolID would (a) recompose from the
      // master it was supposed to be swapped away from and (b) still match this branch
      // afterwards — and since resolveInstanceInto ends by calling this pass again,
      // that repeats with a wider `visited` set each time until the cycle guard trips
      // and emits unresolved: "cycle". This pass also re-runs at every enclosing
      // instance as the recursion unwinds; rewriting symbolID first makes every later
      // run see swap === current and fall through to the children.
      (n as any).symbolData = { ...(n as any).symbolData, symbolID: swap };
      n.children = [];
      delete (n as any).unresolved; // stale verdict from the pre-swap composition
      resolveInstanceInto(index, n as any, n, n.path, visited, depth);
      return; // resolveInstanceInto already recomposes swaps inside the new subtree
    }
    for (const c of n.children ?? []) walk(c);
  })(r);
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
