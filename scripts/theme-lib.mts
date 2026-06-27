// theme-lib.mts — pure emitter that turns the IR's complete variable catalog
// (tokens/variables.json = IRToken[]) into a typed theme. NO top-level side effects,
// NO fs/argv — theme-gen.mts does the IO. Everything here is a pure function of the
// catalog so re-runs are byte-identical (the repo's determinism contract).
//
// Two outputs, same data:
//   web → CSS custom properties (`:root { --color-praline-950: #2a1e1e; … }`), default
//         mode in `:root`, future named modes in `.mode-<slug>`.
//   rn  → a typed TS const tree keyed by mode name; per-mode IIFE declares each variable
//         as a `const` (concrete value or a reference to another variable's const, in
//         topological order) then returns the nested tree built from those consts.
//
// Figma's `/` separator IS the designer's hierarchy → it becomes the tree (`Color/
// praline/950` → `color.praline['950']`). ALIASES are emitted as CODE REFERENCES to the
// DIRECT target (CSS `var(--numbers-18)`, RN the target's const), never collapsed to a
// value — so the alias graph survives into the consuming code.
import { slugify, type IRToken } from "./ir-lib.mts";

export type ThemeVar = IRToken; // the variables.json element shape
export type Framework = "web" | "rn";
export type ThemeResult = { code: string; warnings: string[] };

// --- name munging (ONE rule each; reused by codegen so the two never drift) --------

// "Color/praline/950" → "--color-praline-950"; "Numbers/1,5" → "--numbers-1-5".
// slugify lowercases and collapses every non-alphanumeric run (`/`, `,`, space) to "-".
export function cssVarName(name: string): string {
  return "--" + slugify(name);
}

// "Color/praline/950" → ["color","praline","950"]; "Numbers/1,5" → ["numbers","1,5"].
// Split on "/" ONLY (the documented hierarchy separator) — a comma stays inside a leaf
// ("1,5" is the value 1.5, not two levels). Lowercase ONLY the first segment (the
// category: Color→color, Numbers→numbers) so deeper segments round-trip (Display, 2xl, 950).
export function treePath(name: string): string[] {
  const parts = name
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length) parts[0] = parts[0].toLowerCase();
  return parts;
}

// A TS object/member key: bare identifier when legal, else single-quoted.
const tsKey = (k: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k.replace(/'/g, "\\'")}'`;

// "Color/praline/950" → "color.praline['950']" — a member-access expression codegen can
// drop into generated components (theme[defaultMode].color.praline['950']).
export function tsAccessor(name: string): string {
  const segs = treePath(name);
  return segs
    .map((s, i) =>
      /^[A-Za-z_$][\w$]*$/.test(s) ? (i === 0 ? s : `.${s}`) : `['${s.replace(/'/g, "\\'")}']`,
    )
    .join("");
}

// A valid TS identifier for an RN per-mode const ("Color/praline/950" → "color_praline_950";
// "Numbers/18" → keeps case → "Numbers_18", prefixed "_" only if it would start with a digit).
export function constIdent(name: string): string {
  let s = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s || "_v";
}

// --- literals by type --------------------------------------------------------------

const FLOAT_RE = /^-?\d+(\.\d+)?$/;

// TS literal: COLOR/STRING single-quoted, FLOAT bare number (guarded), BOOLEAN bare.
export function literalFor(type: string, value: string | null): { code: string; warning?: string } {
  const v = value ?? "";
  switch (type) {
    case "COLOR":
      return { code: `'${v}'` };
    case "FLOAT":
      return FLOAT_RE.test(v)
        ? { code: v }
        : { code: `'${v}'`, warning: `FLOAT value "${v}" is not numeric — emitted as a string` };
    case "BOOLEAN":
      return { code: v === "true" ? "true" : "false" };
    case "STRING":
    default:
      return { code: `'${v.replace(/'/g, "\\'")}'` };
  }
}

// CSS value: COLOR bare hex, FLOAT bare (unit-less — consumer adds px), STRING raw (quoted
// only when it contains whitespace, e.g. a font family), BOOLEAN as a literal word.
export function cssLiteral(type: string, value: string | null): { code: string; warning?: string } {
  const v = value ?? "";
  switch (type) {
    case "FLOAT":
      return FLOAT_RE.test(v)
        ? { code: v }
        : { code: v, warning: `FLOAT value "${v}" is not numeric` };
    case "STRING":
      return { code: /\s/.test(v) ? `'${v.replace(/'/g, "\\'")}'` : v };
    case "COLOR":
    case "BOOLEAN":
    default:
      return { code: v };
  }
}

// --- mode resolution ---------------------------------------------------------------

// The mode KEY a variable actually carries for a requested mode: the mode itself if
// present, else the variable's collection default, else its first mode. Keeps value AND
// alias-target read from the SAME key so a fallback never mixes a value from one mode with
// an alias from another.
function modeKeyOf(v: ThemeVar, mode: string): string | null {
  if (v.modes[mode] !== undefined) return mode;
  if (v.defaultMode && v.modes[v.defaultMode] !== undefined) return v.defaultMode;
  const first = Object.keys(v.modes)[0];
  return first ?? null;
}

// Union of mode names across all collections (two collections both named "Mode 1" FUSE
// into one block — correct here and required for cross-collection alias refs).
export function unionModes(vars: ThemeVar[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of vars)
    for (const m of Object.keys(v.modes)) if (!seen.has(m)) (seen.add(m), out.push(m));
  return out;
}

// The single canonical mode (most variables' defaultMode) — exported as `defaultMode`
// so codegen can index `theme[defaultMode]` without hard-coding a Figma mode name.
export function primaryMode(vars: ThemeVar[]): string {
  const freq = new Map<string, number>();
  for (const v of vars)
    if (v.defaultMode) freq.set(v.defaultMode, (freq.get(v.defaultMode) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ?? unionModes(vars)[0] ?? "default";
}

// --- unique-name assignment (collision-proof) --------------------------------------

// Assign one munged name per variable guid; on a base collision append a deterministic
// suffix (CSS "-2", RN "_2") and warn. guid → name so a reference resolves to the same name.
function assignNames(
  vars: ThemeVar[],
  baseOf: (v: ThemeVar) => string,
  sep: string,
): { nameByGuid: Map<string, string>; warnings: string[] } {
  const nameByGuid = new Map<string, string>();
  const taken = new Set<string>();
  const warnings: string[] = [];
  for (const v of vars) {
    if (nameByGuid.has(v.guid)) continue;
    const base = baseOf(v);
    let name = base;
    let i = 2;
    while (taken.has(name)) name = `${base}${sep}${i++}`;
    if (name !== base)
      warnings.push(`name collision: "${v.name}" → "${name}" (base "${base}" already taken)`);
    taken.add(name);
    nameByGuid.set(v.guid, name);
  }
  return { nameByGuid, warnings };
}

// --- topological order (RN consts: a target must be declared before its referrer) ---

// Order so each variable's direct alias target (this mode) precedes it. Single-hop here;
// generalises to multi-hop. A cycle (impossible in a real .fig) → leftover appended in
// source order + hadCycle, never hangs.
export function topoOrder(
  vars: ThemeVar[],
  mode: string,
): { ordered: ThemeVar[]; hadCycle: boolean } {
  const present = new Set(vars.map((v) => v.guid));
  const depOf = (v: ThemeVar): string | null => {
    const k = modeKeyOf(v, mode);
    const t = k ? v.aliasTargets?.[k] : undefined;
    return t && present.has(t) ? t : null;
  };
  const emitted = new Set<string>();
  const ordered: ThemeVar[] = [];
  let progress = true;
  while (ordered.length < vars.length && progress) {
    progress = false;
    for (const v of vars) {
      if (emitted.has(v.guid)) continue;
      const d = depOf(v);
      if (d === null || emitted.has(d)) {
        ordered.push(v);
        emitted.add(v.guid);
        progress = true;
      }
    }
  }
  const hadCycle = ordered.length < vars.length;
  if (hadCycle) for (const v of vars) if (!emitted.has(v.guid)) ordered.push(v);
  return { ordered, hadCycle };
}

// --- nested tree builder + TS serializer -------------------------------------------

type TreeNode = { children: Map<string, TreeNode>; leaf?: string };
type Leaf = { path: string[]; expr: string; name: string };

function buildTree(leaves: Leaf[]): { root: TreeNode; warnings: string[] } {
  const root: TreeNode = { children: new Map() };
  const warnings: string[] = [];
  for (const { path: p, expr, name } of leaves) {
    let cur = root;
    for (let i = 0; i < p.length - 1; i++) {
      const seg = p[i];
      let next = cur.children.get(seg);
      if (!next) {
        next = { children: new Map() };
        cur.children.set(seg, next);
      }
      if (next.leaf !== undefined) {
        warnings.push(
          `tree conflict: "${name}" nests under "${seg}" which also holds a value — value dropped`,
        );
        delete next.leaf;
      }
      cur = next;
    }
    const last = p[p.length - 1];
    const existing = cur.children.get(last);
    if (existing && existing.children.size > 0) {
      warnings.push(
        `tree conflict: "${name}" is a value but "${last}" already has children — value dropped`,
      );
    } else {
      cur.children.set(last, { children: new Map(), leaf: expr });
    }
  }
  return { root, warnings };
}

function emitTreeTS(node: TreeNode, indent: number): string {
  if (node.children.size === 0) return "{}";
  const pad = "  ".repeat(indent);
  const padIn = "  ".repeat(indent + 1);
  const lines: string[] = [];
  for (const [k, child] of node.children) {
    const key = tsKey(k);
    if (child.leaf !== undefined && child.children.size === 0)
      lines.push(`${padIn}${key}: ${child.leaf},`);
    else lines.push(`${padIn}${key}: ${emitTreeTS(child, indent + 1)},`);
  }
  return `{\n${lines.join("\n")}\n${pad}}`;
}

// --- the two framework emitters ----------------------------------------------------

function modeBlockSelector(mode: string, primary: string): string {
  return mode === primary ? ":root" : `.mode-${slugify(mode)}`;
}

function emitWeb(vars: ThemeVar[], modes: string[], primary: string): ThemeResult {
  const warnings: string[] = [];
  const { nameByGuid, warnings: nameWarn } = assignNames(vars, (v) => cssVarName(v.name), "-");
  warnings.push(...nameWarn);
  const blocks: string[] = [];
  for (const mode of modes) {
    const lines: string[] = [];
    for (const v of vars) {
      const k = modeKeyOf(v, mode);
      const target = k ? v.aliasTargets?.[k] : undefined;
      const self = nameByGuid.get(v.guid)!;
      let expr: string;
      let comment = "";
      if (target && nameByGuid.has(target)) {
        expr = `var(${nameByGuid.get(target)})`;
        const tname = vars.find((x) => x.guid === target)?.name;
        comment = tname ? `  /* alias → ${tname} */` : "";
      } else {
        if (target)
          warnings.push(
            `dangling alias: "${v.name}" → ${target} (target not in catalog) — used value`,
          );
        const lit = cssLiteral(v.type, k ? v.modes[k] : null);
        if (lit.warning) warnings.push(`${v.name}: ${lit.warning}`);
        expr = lit.code;
        if (target) comment = `  /* TODO: alias target ${target} missing */`;
      }
      lines.push(`  ${self}: ${expr};${comment}`);
    }
    blocks.push(`${modeBlockSelector(mode, primary)} {\n${lines.join("\n")}\n}`);
  }
  const header =
    "/* AUTO-GENERATED by theme-gen.mts — Figma variables → CSS custom properties.\n" +
    "   Numeric tokens are unit-less; a px context must wrap them: calc(var(--x) * 1px). */\n\n";
  return { code: header + blocks.join("\n\n") + "\n", warnings };
}

function emitRn(vars: ThemeVar[], modes: string[], primary: string): ThemeResult {
  const warnings: string[] = [];
  const { nameByGuid, warnings: nameWarn } = assignNames(vars, (v) => constIdent(v.name), "_");
  warnings.push(...nameWarn);
  const guidToName = new Map(vars.map((v) => [v.guid, v.name] as const));
  const modeEntries: string[] = [];
  for (const mode of modes) {
    const { ordered, hadCycle } = topoOrder(vars, mode);
    if (hadCycle)
      warnings.push(`alias cycle detected in mode "${mode}" — emitted remaining in source order`);
    const decls: string[] = [];
    for (const v of ordered) {
      const k = modeKeyOf(v, mode);
      const target = k ? v.aliasTargets?.[k] : undefined;
      const ident = nameByGuid.get(v.guid)!;
      if (target && nameByGuid.has(target)) {
        decls.push(
          `    const ${ident} = ${nameByGuid.get(target)}; // alias → ${guidToName.get(target)}`,
        );
      } else {
        if (target)
          warnings.push(
            `dangling alias: "${v.name}" → ${target} (target not in catalog) — used value`,
          );
        const lit = literalFor(v.type, k ? v.modes[k] : null);
        if (lit.warning) warnings.push(`${v.name}: ${lit.warning}`);
        decls.push(
          `    const ${ident} = ${lit.code};${target ? ` // TODO: alias target ${target} missing` : ""}`,
        );
      }
    }
    // tree leaves in SOURCE order (stable shape); each leaf references its own const.
    const leaves: Leaf[] = vars.map((v) => ({
      path: treePath(v.name),
      expr: nameByGuid.get(v.guid)!,
      name: v.name,
    }));
    const { root, warnings: treeWarn } = buildTree(leaves);
    warnings.push(...treeWarn);
    const tree = emitTreeTS(root, 2);
    modeEntries.push(
      `  ${tsKey(mode)}: (() => {\n${decls.join("\n")}\n    return ${tree};\n  })(),`,
    );
  }
  const code =
    "// AUTO-GENERATED by theme-gen.mts — Figma variables → typed theme.\n" +
    "// Top-level keys are Figma mode names; aliases reference the target variable's const.\n\n" +
    `export const defaultMode = ${tsKey(primary)} as const;\n\n` +
    `export const theme = {\n${modeEntries.join("\n")}\n} as const;\n\n` +
    "export type TokenMode = keyof typeof theme;\n" +
    "export type Theme = typeof theme;\n";
  return { code, warnings };
}

// Emit a theme for ONE framework. theme-gen calls this once per requested framework.
export function emitTheme(
  vars: ThemeVar[],
  opts: { framework: Framework; activeMode?: string },
): ThemeResult {
  const modes = unionModes(vars);
  // The active mode (the single style decision) becomes :root / defaultMode; if it isn't a
  // real mode, fall back to the catalog's primary. All modes are still emitted (switchable).
  const primary =
    opts.activeMode && modes.includes(opts.activeMode) ? opts.activeMode : primaryMode(vars);
  if (modes.length === 0)
    return {
      code: opts.framework === "web" ? ":root {}\n" : "export const theme = {} as const;\n",
      warnings: ["no variables — emitted an empty theme"],
    };
  return opts.framework === "web" ? emitWeb(vars, modes, primary) : emitRn(vars, modes, primary);
}
