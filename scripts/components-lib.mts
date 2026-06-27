// Component-set discovery & variant-API derivation (no import-time side effects).
// Reused by components.mts (Phase 3) and IR build pass 4 (Phase 6).
//
// Detection prefers the STRUCTURAL signal (a frame whose visible direct children
// are all SYMBOLs named `prop=value[, prop2=value2]` sharing one axis set) over
// the #9747ff dashed-stroke editor hint, which is only a labeled fallback (the
// purple stroke is a render hint, not a format guarantee — determinism contract).
import { load, key, colorStr } from "./lib.mts";
import { kebab, camel } from "./naming.mts";

export type ComponentSet = {
  guid: string;
  name: string;
  size?: { x: number; y: number };
  detectedBy: "structural" | "stroke-hint";
  confidence: "high" | "medium";
  variants: {
    guid: string;
    rawName: string;
    props: Record<string, string>;
    size?: { x: number; y: number };
  }[];
};

// One or more `prop=value` pairs, comma-separated. Value runs to the next comma.
// Axis keys may contain hyphens (e.g. `item-count=more`) — allow `-` in the key.
const VARIANT_NAME = /^(\w[\w -]*=[^,]+)(,\s*\w[\w -]*=[^,]+)*$/;

function parseProps(rawName: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const pair of rawName.split(",")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    props[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return props;
}

const axisSetOf = (props: Record<string, string>) => Object.keys(props).sort().join("|");

function variantsOf(
  set: { guid: string },
  children: Map<string, any[]>,
): ComponentSet["variants"] | null {
  const kids = (children.get(set.guid) ?? []).filter((c) => c.visible !== false);
  const syms = kids.filter((c) => c.type === "SYMBOL");
  // Every visible direct child must be a SYMBOL with a matching variant name.
  if (syms.length < 2 || syms.length !== kids.length) return null;
  if (!syms.every((c) => c.name && VARIANT_NAME.test(c.name))) return null;
  const variants = syms.map((c) => ({
    guid: key(c.guid),
    rawName: c.name as string,
    props: parseProps(c.name),
    size: c.size ? { x: c.size.x, y: c.size.y } : undefined,
  }));
  const axis0 = axisSetOf(variants[0].props);
  if (!variants.every((v) => axisSetOf(v.props) === axis0)) return null;
  return variants;
}

const PURPLE = "#9747ff";
function hasStrokeHint(n: any): boolean {
  const purple = (n.strokePaints ?? []).some(
    (p: any) => p.visible !== false && colorStr(p.color) === PURPLE,
  );
  return purple && Array.isArray(n.dashPattern) && n.dashPattern.length > 0;
}

// Find component sets. `useStrokeHint` (default true) toggles the weaker fallback;
// pass false to prove the structural signal stands alone (Phase 3 acceptance).
export function findComponentSets(
  index: ReturnType<typeof load>,
  useStrokeHint = true,
): ComponentSet[] {
  const { nodes, children } = index;
  const sets: ComponentSet[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const guid = key(n.guid);
    const variants = variantsOf({ guid }, children);
    if (variants) {
      seen.add(guid);
      sets.push({
        guid,
        name: n.name ?? n.type,
        size: n.size ? { x: n.size.x, y: n.size.y } : undefined,
        detectedBy: "structural",
        confidence: "high",
        variants,
      });
    }
  }
  if (useStrokeHint) {
    for (const n of nodes) {
      const guid = key(n.guid);
      if (seen.has(guid) || !hasStrokeHint(n)) continue;
      // Fallback: list whatever variant-looking SYMBOL children exist (may be lone).
      const kids = (children.get(guid) ?? []).filter((c) => c.visible !== false);
      const syms = kids.filter((c) => c.type === "SYMBOL" && c.name && VARIANT_NAME.test(c.name));
      sets.push({
        guid,
        name: n.name ?? n.type,
        size: n.size ? { x: n.size.x, y: n.size.y } : undefined,
        detectedBy: "stroke-hint",
        confidence: "medium",
        variants: syms.map((c) => ({
          guid: key(c.guid),
          rawName: c.name as string,
          props: parseProps(c.name),
          size: c.size ? { x: c.size.x, y: c.size.y } : undefined,
        })),
      });
    }
  }
  return sets;
}

// Parse the variant matrix from a set's variants.
export function parseVariantMatrix(set: ComponentSet): {
  axes: Record<string, string[]>;
  variants: ComponentSet["variants"];
} {
  const axes: Record<string, string[]> = {};
  for (const v of set.variants) {
    for (const [axis, value] of Object.entries(v.props)) {
      axes[axis] ??= [];
      if (!axes[axis].includes(value)) axes[axis].push(value);
    }
  }
  return { axes, variants: set.variants };
}

// Known value synonyms; unknown values fall back to kebab-case.
const VALUE_SYNONYMS: Record<string, string> = {
  L: "large",
  M: "medium",
  S: "small",
  SingleLine: "single-line",
  ModalHeader: "modal",
};

// Map one axis VALUE to its prop-union literal (synonym, else kebab-case). Exported
// so codegen can compute the SAME per-variant prop value the union type uses.
export const mapValue = (v: string) => VALUE_SYNONYMS[v] ?? kebab(v);
const union = (values: string[]) => values.map((v) => `'${mapValue(v)}'`).join(" | ");

// Derive a TS prop type. Single-axis → the prop is ALWAYS named `variant`
// (regardless of the axis's own name). Multi-axis → one prop per axis.
export function proposePropApi(matrix: ReturnType<typeof parseVariantMatrix>): string {
  const axisNames = Object.keys(matrix.axes);
  if (axisNames.length === 0) return "";
  if (axisNames.length === 1) {
    return `variant: ${union(matrix.axes[axisNames[0]])}`;
  }
  return axisNames.map((axis) => `${kebab(axis)}: ${union(matrix.axes[axis])}`).join("; ");
}

// --- non-variant component property API (improvement A-props) ----------------
// The variant matrix above models the SYMBOL-name axes ("Version=Default"). A
// component set ALSO carries non-variant props on its frame `componentPropDefs`:
// text / boolean / instance-swap props that bind to specific child node fields.
// This is a pure function of the bytes (facts only: names/kinds/bindings/defaults
// + same-node grouping). The idiomatic collapse (bool-visible + text → one prop)
// is a Phase-B codegen transform driven by these facts.
//
// NAMESPACE JOIN (confirmed against the decode): the SET frame's
// componentPropDefs carry the human `name`+`type`+`varValue` but their `id` is a
// DIFFERENT namespace from the per-master defs and the child `componentPropRefs`.
// Each MASTER def is a stub `{ id, parentPropDefId }` whose `parentPropDefId`
// points at the SET def id. A child ref's `defID` matches a MASTER def id; follow
// that master def's `parentPropDefId` up to the SET def to recover the prop. So
// the bridge is master.def.id == ref.defID  →  master.def.parentPropDefId == set.def.id
// — never match ref.defID against a set.def.id directly (different namespace).

export type ComponentProp = {
  name: string; // normalized camelCase
  rawName: string; // raw def name (e.g. "Başlık")
  kind: "text" | "boolean" | "instanceSwap";
  // defKey = the SET-def id key (sessionID:localID). The STABLE identity of a prop:
  // `name` can collide (two props both camelCase to "action"), so codegen joins a
  // variant's bindings (extractVariantBindings) back to props by defKey, never name.
  defKey: string;
  default: string | boolean | null; // from set def varValue/value (null = TODO for codegen)
  bindings: { node: string; field: "characters" | "visible" | "symbolId" }[];
};

const PROP_KIND: Record<string, ComponentProp["kind"] | undefined> = {
  TEXT: "text",
  BOOL: "boolean",
  INSTANCE_SWAP: "instanceSwap",
};

const NODE_FIELD: Record<string, ComponentProp["bindings"][number]["field"] | undefined> = {
  TEXT_DATA: "characters",
  VISIBLE: "visible",
  OVERRIDDEN_SYMBOL_ID: "symbolId",
};

// Pull the set-def default out of its varValue/value (else initialValue), per kind.
// Returns null when the value is absent/unexpected so codegen can leave a TODO.
function defaultOf(def: any, kind: ComponentProp["kind"]): string | boolean | null {
  const v = def?.varValue?.value ?? def?.initialValue ?? null;
  if (v == null) return null;
  if (kind === "text") {
    const chars = v.textDataValue?.characters ?? v.textValue?.characters;
    return typeof chars === "string" ? chars : null;
  }
  if (kind === "boolean") {
    const b = v.boolValue;
    return typeof b === "boolean" ? b : null;
  }
  // instanceSwap: the swapped master guid (sessionID:localID), else null.
  const g = v.symbolIdValue?.guid ?? v.guidValue;
  return g && g.sessionID != null && g.localID != null ? key(g) : null;
}

// Build the non-variant prop list for a set, resolving bindings by walking a
// representative (default) master subtree. `set.guid` is the set frame guidKey;
// `index` gives node + child access. Returns [] when the set frame carries no
// non-variant componentPropDefs. NO side effects.
export function extractComponentProps(
  index: ReturnType<typeof load>,
  setGuid: string,
): ComponentProp[] {
  const { byKey, children } = index;
  const setNode = byKey.get(setGuid);
  if (!setNode) return [];
  const defs: any[] = setNode.componentPropDefs ?? [];
  // set def id (key) → {name, kind, default} for every NON-VARIANT def.
  const props = new Map<string, ComponentProp>();
  for (const d of defs) {
    const kind = PROP_KIND[d.type];
    if (!kind) continue; // skip VARIANT (modeled by the matrix) + unknowns
    const rawName = typeof d.name === "string" ? d.name : key(d.id);
    props.set(key(d.id), {
      name: camel(rawName),
      rawName,
      kind,
      defKey: key(d.id),
      default: defaultOf(d, kind),
      bindings: [],
    });
  }
  if (!props.size) return [];

  // Pick a representative master: the variant SYMBOL whose master-def stubs are
  // present (any default master works — bindings are the same across variants).
  // Prefer the structurally-first SYMBOL child of the set frame.
  const masters = (children.get(setGuid) ?? []).filter((c) => c.type === "SYMBOL");
  const master = masters[0];
  if (!master) return [...props.values()];

  // master def id (key) → set def id (key), via parentPropDefId.
  const masterToSet = new Map<string, string>();
  for (const md of master.componentPropDefs ?? [])
    if (md.parentPropDefId) masterToSet.set(key(md.id), key(md.parentPropDefId));

  // Walk the master subtree; every componentPropRef binds (node, field) to a set
  // prop (via master→set). Determinism: depth-first in child position order.
  const seen = new Set<string>(); // dedupe (setProp, node, field)
  const walk = (k: string) => {
    const n = byKey.get(k);
    if (!n) return;
    for (const r of n.componentPropRefs ?? []) {
      const setId = masterToSet.get(key(r.defID));
      const prop = setId ? props.get(setId) : undefined;
      const field = NODE_FIELD[r.componentPropNodeField];
      if (!prop || !field) continue;
      const sig = `${setId}|${k}|${field}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      prop.bindings.push({ node: k, field });
    }
    for (const c of children.get(k) ?? []) walk(key(c.guid));
  };
  walk(key(master.guid));

  return [...props.values()];
}

// Same-node groupings: which props bind the SAME child node (so codegen can
// collapse e.g. a bool-visible + text pair into one optional prop in Phase B).
// Returns groups of >1 prop name sharing a node, keyed by that node guidKey.
// Pure/derived from extractComponentProps output — no decode access.
export function sameNodeGroups(props: ComponentProp[]): { node: string; props: string[] }[] {
  const byNode = new Map<string, Set<string>>();
  for (const p of props)
    for (const b of p.bindings) {
      (byNode.get(b.node) ?? byNode.set(b.node, new Set()).get(b.node)!).add(p.name);
    }
  const groups: { node: string; props: string[] }[] = [];
  for (const [node, names] of byNode) if (names.size > 1) groups.push({ node, props: [...names] });
  return groups;
}

// Per-variant binding resolution (improvement B-codegen). extractComponentProps
// resolves bindings against ONE representative master, so its binding node guids
// only address the DEFAULT variant's subtree. To render EACH variant's OWN subtree
// (codegen multi-file), every variant master must resolve the SAME set props onto
// ITS OWN node guids — a variant may also expose a DIFFERENT subset of props (e.g.
// the modal variant only has a title). This walks every variant master the same
// def-namespace way (master def id == ref.defID → master.parentPropDefId == set def
// id; NEVER id-match across namespaces) and returns, per variant guidKey, the
// bindings keyed by the STABLE set-def key (defKey) so codegen joins to props[]
// without the name-collision hazard. PURE — facts only (names/kinds/fields), no
// collapse. Variants absent from the result (or with [] bindings) simply expose no
// bound prop in their subtree.
export type VariantBinding = {
  defKey: string; // set-def id key — join to ComponentProp.defKey
  rawName: string; // raw set-def name (for codegen comments / TODOs)
  kind: ComponentProp["kind"];
  node: string; // the VARIANT's own node guidKey carrying the ref
  field: ComponentProp["bindings"][number]["field"];
};
export function extractVariantBindings(
  index: ReturnType<typeof load>,
  setGuid: string,
  variantGuidKeys: string[],
): Record<string, VariantBinding[]> {
  const { byKey, children } = index;
  const setNode = byKey.get(setGuid);
  const out: Record<string, VariantBinding[]> = {};
  if (!setNode) return out;
  // set def id (key) → {rawName, kind} for every NON-VARIANT def.
  const setProps = new Map<string, { rawName: string; kind: ComponentProp["kind"] }>();
  for (const d of setNode.componentPropDefs ?? []) {
    const kind = PROP_KIND[d.type];
    if (!kind) continue;
    setProps.set(key(d.id), { rawName: typeof d.name === "string" ? d.name : key(d.id), kind });
  }
  if (!setProps.size) return out;

  for (const vg of variantGuidKeys) {
    const master = byKey.get(vg);
    if (!master) continue;
    // this variant master's def id (key) → set def id (key), via parentPropDefId.
    const masterToSet = new Map<string, string>();
    for (const md of master.componentPropDefs ?? [])
      if (md.parentPropDefId) masterToSet.set(key(md.id), key(md.parentPropDefId));
    const bindings: VariantBinding[] = [];
    const seen = new Set<string>(); // dedupe (setProp, node, field)
    const walk = (k: string) => {
      const n = byKey.get(k);
      if (!n) return;
      for (const r of n.componentPropRefs ?? []) {
        const setId = masterToSet.get(key(r.defID));
        const sp = setId ? setProps.get(setId) : undefined;
        const field = NODE_FIELD[r.componentPropNodeField];
        if (!setId || !sp || !field) continue;
        const sig = `${setId}|${k}|${field}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        bindings.push({ defKey: setId, rawName: sp.rawName, kind: sp.kind, node: k, field });
      }
      for (const c of children.get(k) ?? []) walk(key(c.guid));
    };
    walk(vg);
    out[vg] = bindings;
  }
  return out;
}

// === LOGICAL PROP MODEL — the idiomatic collapse (a pure transform over ComponentProp[]) ===
// Lives here (not in codegen.mts) so it's unit-testable in isolation with synthetic
// ComponentProp fixtures — no decode, no IR artifact dependency.
export type Logical =
  | {
      name: string;
      tsType: "string";
      role: "text";
      figNames: string[];
      defText: string | null;
      defKey: string;
    }
  | {
      name: string;
      tsType: "boolean";
      role: "bool";
      figNames: string[];
      defKey: string;
      defBool: boolean | null;
    }
  | {
      name: string;
      tsType: "React.ReactNode";
      role: "slot";
      figNames: string[];
      defKey: string;
      defSym: string | null;
    };

// Derive the logical prop model for ANY component catalog record (anything with a `props`
// array of ComponentProp). The COLLAPSE happens here: on a node carrying a BOOL-visible prop
// AND a TEXT-characters prop whose bool default is NOT true, emit one optional string; both
// defKeys point at that single logical prop. Standalone props become text / show<Bool> / slot.
// Returns the logical list plus a defKey → logical map. Called for the generated `comp` AND,
// on the nested-component reference path, for a REFERENCED component (to map an instance's
// overrides onto that component's props).
export function deriveLogicals(c: { props?: ComponentProp[] } | any): {
  logicals: Logical[];
  logicalByDefKey: Map<string, Logical>;
} {
  const cprops: any[] = c.props ?? [];
  // Group props by the default-master node they bind (so a bool-visible + text pair on
  // the SAME node collapses to one). A prop with no binding still gets its own slot.
  const propsByNode = new Map<string, any[]>(); // node guid → props binding it
  for (const p of cprops) {
    if (!p.bindings?.length) continue;
    for (const b of p.bindings)
      (propsByNode.get(b.node) ?? propsByNode.set(b.node, []).get(b.node)!).push(p);
  }
  const logicals: Logical[] = [];
  const logicalByDefKey = new Map<string, Logical>();
  const usedNames = new Set<string>();
  // de-dupe an emitted prop name deterministically (collision → name2, name3, …).
  const uniqueName = (base: string): string => {
    let n = base || "prop";
    let i = 2;
    while (usedNames.has(n)) n = `${base}${i++}`;
    usedNames.add(n);
    return n;
  };
  const seenDefKeys = new Set<string>();
  // Deterministic order: walk props[] in file order; the first prop of a collapsed pair
  // drives placement (its node's other prop is folded in).
  for (const p of cprops) {
    if (seenDefKeys.has(p.defKey)) continue;
    // find a collapse partner on the same node (bool-visible ⊕ text-characters).
    const node = p.bindings?.find(
      (b: any) => b.field === "visible" || b.field === "characters",
    )?.node;
    const onNode = node ? (propsByNode.get(node) ?? []) : [];
    const textP = onNode.find((q) => q.kind === "text");
    const boolP = onNode.find((q) => q.kind === "boolean");
    // COLLAPSE a text+bool pair into one optional string ONLY when the bool's master
    // default is NOT true — i.e. the node is HIDDEN by default, so "pass a string to
    // show it, omit to hide" matches the master. When the bool defaults to `true` the
    // node is VISIBLE by default with default text, so collapsing-and-gating-on-`!= null`
    // would wrongly hide it at zero props (finding #3). Keep them as TWO props instead:
    // a `show<Bool>` defaulted to its IR value + a text prop with a master-default
    // fallback, so the zero-prop render reproduces the Figma master 1:1.
    if (textP && boolP && boolP.default !== true) {
      // COLLAPSE → one optional string. Name from the TEXT prop. Both defKeys map here.
      const name = uniqueName(textP.name);
      const lg: Logical = {
        name,
        tsType: "string",
        role: "text",
        defKey: textP.defKey,
        figNames: [textP.rawName, boolP.rawName],
        defText: typeof textP.default === "string" ? textP.default : null,
      };
      logicals.push(lg);
      logicalByDefKey.set(textP.defKey, lg);
      logicalByDefKey.set(boolP.defKey, lg);
      seenDefKeys.add(textP.defKey);
      seenDefKeys.add(boolP.defKey);
      continue;
    }
    seenDefKeys.add(p.defKey);
    if (p.kind === "text") {
      const lg: Logical = {
        name: uniqueName(p.name),
        tsType: "string",
        role: "text",
        defKey: p.defKey,
        figNames: [p.rawName],
        defText: typeof p.default === "string" ? p.default : null,
      };
      logicals.push(lg);
      logicalByDefKey.set(p.defKey, lg);
    } else if (p.kind === "boolean") {
      // a standalone BOOL binds a node's `visible` → name it show<Name> (idiomatic for a
      // visibility toggle, and it frees the bare name for a content/text prop so a
      // collapsed `Action`+`actionText` pair becomes `action`, not `action2`). Skip the
      // prefix when the prop is already show/is/has-prefixed.
      const showName = /^(show|is|has)[A-Z]/.test(p.name)
        ? p.name
        : "show" + p.name.charAt(0).toUpperCase() + p.name.slice(1);
      // carry the IR visibility default so codegen can default the prop in the destructure
      // (`show<X> = true`) → a master-visible node renders at zero props (finding #3).
      const lg: Logical = {
        name: uniqueName(showName),
        tsType: "boolean",
        role: "bool",
        defKey: p.defKey,
        figNames: [p.rawName],
        defBool: typeof p.default === "boolean" ? p.default : null,
      };
      logicals.push(lg);
      logicalByDefKey.set(p.defKey, lg);
    } else {
      // carry the instance-swap default SYMBOL guid so the slot is never emitted with no
      // default AND no TODO (finding #2) — the render flags it (best-effort named).
      const lg: Logical = {
        name: uniqueName(p.name),
        tsType: "React.ReactNode",
        role: "slot",
        defKey: p.defKey,
        figNames: [p.rawName],
        defSym: typeof p.default === "string" ? p.default : null,
      };
      logicals.push(lg);
      logicalByDefKey.set(p.defKey, lg);
    }
  }
  return { logicals, logicalByDefKey };
}
