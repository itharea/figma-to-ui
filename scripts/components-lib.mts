// Component-set discovery & variant-API derivation (no import-time side effects).
// Reused by components.mts (Phase 3) and IR build pass 4 (Phase 6).
//
// Detection prefers the STRUCTURAL signal (a frame whose visible direct children
// are all SYMBOLs named `prop=value[, prop2=value2]` sharing one axis set) over
// the #9747ff dashed-stroke editor hint, which is only a labeled fallback (the
// purple stroke is a render hint, not a format guarantee — determinism contract).
import { load, key, colorStr } from "./lib.mts";

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
const VARIANT_NAME = /^(\w[\w ]*=[^,]+)(,\s*\w[\w ]*=[^,]+)*$/;

function parseProps(rawName: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const pair of rawName.split(",")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    props[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return props;
}

const axisSetOf = (props: Record<string, string>) =>
  Object.keys(props).sort().join("|");

function variantsOf(
  set: { guid: string },
  children: Map<string, any[]>
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
    (p: any) => p.visible !== false && colorStr(p.color) === PURPLE
  );
  return purple && Array.isArray(n.dashPattern) && n.dashPattern.length > 0;
}

// Find component sets. `useStrokeHint` (default true) toggles the weaker fallback;
// pass false to prove the structural signal stands alone (Phase 3 acceptance).
export function findComponentSets(
  index: ReturnType<typeof load>,
  useStrokeHint = true
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
      const syms = kids.filter(
        (c) => c.type === "SYMBOL" && c.name && VARIANT_NAME.test(c.name)
      );
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
      (axes[axis] ??= []);
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

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w-]/g, "")
    .toLowerCase();
}

const mapValue = (v: string) => VALUE_SYNONYMS[v] ?? kebab(v);
const union = (values: string[]) =>
  values.map((v) => `'${mapValue(v)}'`).join(" | ");

// Derive a TS prop type. Single-axis → the prop is ALWAYS named `variant`
// (regardless of the axis's own name). Multi-axis → one prop per axis.
export function proposePropApi(
  matrix: ReturnType<typeof parseVariantMatrix>
): string {
  const axisNames = Object.keys(matrix.axes);
  if (axisNames.length === 0) return "";
  if (axisNames.length === 1) {
    return `variant: ${union(matrix.axes[axisNames[0]])}`;
  }
  return axisNames
    .map((axis) => `${kebab(axis)}: ${union(matrix.axes[axis])}`)
    .join("; ");
}
