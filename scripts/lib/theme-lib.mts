// theme-lib.mts — pure emitter that turns the IR's complete variable catalog
// (tokens/variables.json = IRToken[]) into a typed theme. NO top-level side effects,
// NO fs/argv — theme-gen.mts does the IO. Everything here is a pure function of the
// catalog so re-runs are byte-identical (the repo's determinism contract).
//
// Two outputs, same data:
//   web → CSS custom properties (`:root { --color-praline-950: #2a1e1e; … }`), the ACTIVE
//         mode in `:root`, every other mode in `.mode-<slug>` after it.
//   rn  → a typed TS const tree keyed by mode name; per-mode IIFE declares each variable
//         as a `const` (concrete value or a reference to another variable's const, in
//         topological order) then returns the nested tree built from those consts.
//
// Figma's `/` separator IS the designer's hierarchy → it becomes the tree (`Color/
// praline/950` → `color.praline['950']`). ALIASES are emitted as CODE REFERENCES to the
// DIRECT target (CSS `var(--numbers-18)`, RN the target's const), never collapsed to a
// value — so the alias graph survives into the consuming code.
import { type IRToken } from "./ir-lib.mts";
import { slugify } from "./naming.mts";

export type ThemeVar = IRToken; // the variables.json element shape
export type Framework = "web" | "rn";
// A duplicate-named variable the use census proved dead and the emitter therefore left out.
export type DroppedVar = { name: string; guid: string; keptGuid: string };
export type ThemeResult = { code: string; warnings: string[]; dropped: DroppedVar[] };
// variable guidKey → how many times a non-VARIABLE node references it (see variableUseCensus).
export type UseCensus = ReadonlyMap<string, number>;

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

export type ModeMatch =
  { mode: string } | { mode: null; reason: "unknown" | "ambiguous"; candidates: string[] };

// Match a REQUESTED mode name against the catalog's real mode names. Figma mode names are
// free text and routinely contain spaces and slashes ("App / freetypeface"), so the string a
// caller types rarely survives a shell verbatim, and the name the generated CSS advertises is
// the SLUG ("mode-app-freetypeface"), not the mode. Three tiers, most literal first: exact →
// case-insensitive → slug-equal. Returning a discriminated miss (never a silent fallback) is
// the point: a requested mode that quietly does not root is the defect this guards.
export function resolveMode(modes: readonly string[], requested: string): ModeMatch {
  const tiers: ((m: string) => boolean)[] = [
    (m) => m === requested,
    (m) => m.toLowerCase() === requested.toLowerCase(),
    (m) => slugify(m) === slugify(requested),
  ];
  for (const match of tiers) {
    const hits = modes.filter(match);
    if (hits.length === 1) return { mode: hits[0] };
    if (hits.length > 1) return { mode: null, reason: "ambiguous", candidates: hits };
  }
  return { mode: null, reason: "unknown", candidates: [...modes] };
}

// Emission order: the ROOTED mode first, every other mode after it. `:root` and `.mode-x` have
// the SAME CSS specificity (0,1,0), so when a consumer opts in by putting the class on <html>
// both rules match and only source order decides — the class must come later or the opt-in is
// dead. (RN output is order-insensitive; it shares this for a consistent, diffable shape.)
export function orderedModes(modes: readonly string[], primary: string): string[] {
  return modes.includes(primary) ? [primary, ...modes.filter((m) => m !== primary)] : [...modes];
}

// --- live-use census (which of two same-named variables is the real one) ------------

// Count, per variable guidKey, how many times a NON-VARIABLE node references it. Every
// binding shape Figma uses — a paint's `colorVar`, a text style's `variableConsumptionMap`,
// FONT_STYLE's extra `fontStyleValue.asString` wrapper, a component property default —
// bottoms out in the same `{ alias: { guid: {sessionID, localID} } }` payload, so we walk
// generically for `alias.guid` rather than enumerating field names that vary by fig version.
// VARIABLE / VARIABLE_SET nodes are excluded on purpose: a variable aliasing another is the
// token graph talking to itself, not evidence that anything in the DESIGN consumes it.
//
// Why this exists: a renumbered scale can leave superseded variables in the file under the
// SAME names as their replacements (observed on one library export: six duplicated typography
// names, every stale one with exactly 0 references and its live twin with 1–14). Reference
// count is the only signal in the bytes that separates them.
export function variableUseCensus(nodes: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (g: any): void => {
    if (!g || g.sessionID === undefined || g.localID === undefined) return;
    const k = `${g.sessionID}:${g.localID}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  // depth cap: JSON from a decode is acyclic, but a bounded walk can never hang on a
  // pathological payload. 24 clears the deepest known binding nesting several times over.
  const walk = (v: any, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 24) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      if (k === "alias" && val && typeof val === "object") bump((val as any).guid ?? val);
      else walk(val, depth + 1);
    }
  };
  for (const n of nodes) {
    const node = n as any;
    if (!node || typeof node !== "object") continue;
    if (node.type === "VARIABLE" || node.type === "VARIABLE_SET") continue;
    walk(node, 0);
  }
  return counts;
}

// Rank two candidates for one name. MOST-REFERENCED wins — that is the whole point of the
// census. The tie-break must not be array order (the defect: whichever the catalog happened
// to list first took the clean name), so it is the guid itself, HIGHEST first: a guid is
// `sessionID:localID` and Figma hands out rising ids, so the larger guid is the variable
// created LATER — the one that supersedes an identically-named predecessor. Non-numeric
// guids fall back to a descending string compare, which is still order-independent.
function rankForName(a: ThemeVar, b: ThemeVar, uses?: UseCensus): number {
  const ua = uses?.get(a.guid) ?? 0;
  const ub = uses?.get(b.guid) ?? 0;
  if (ua !== ub) return ub - ua;
  const na = a.guid.split(":").map(Number);
  const nb = b.guid.split(":").map(Number);
  if (na.every(Number.isFinite) && nb.every(Number.isFinite) && na.length === nb.length) {
    for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) return nb[i] - na[i];
    return 0;
  }
  return a.guid < b.guid ? 1 : a.guid > b.guid ? -1 : 0;
}

// Drop the duplicates the census proves dead. A variable is dropped only when ALL hold:
// another variable carries the same Figma name, that twin IS referenced, this one is
// referenced ZERO times, and no variable in the catalog aliases it (an alias target is live
// by definition even with no direct design use). Everything else is kept and merely suffixed,
// so an ambiguous case degrades to today's behaviour rather than losing data. Without a
// census (`uses` absent) nothing is ever dropped.
export function dedupeByCensus(
  vars: ThemeVar[],
  uses?: UseCensus,
): { kept: ThemeVar[]; dropped: DroppedVar[] } {
  if (!uses) return { kept: vars, dropped: [] };
  const aliasTargets = new Set<string>();
  for (const v of vars) for (const t of Object.values(v.aliasTargets ?? {})) aliasTargets.add(t);
  const byName = new Map<string, ThemeVar[]>();
  for (const v of vars) {
    const group = byName.get(v.name);
    if (group) group.push(v);
    else byName.set(v.name, [v]);
  }
  const dropped = new Map<string, DroppedVar>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => rankForName(a, b, uses));
    const winner = ranked[0];
    if ((uses.get(winner.guid) ?? 0) === 0) continue; // nothing proven live → keep them all
    for (const v of ranked.slice(1)) {
      if ((uses.get(v.guid) ?? 0) > 0) continue;
      if (aliasTargets.has(v.guid)) continue;
      dropped.set(v.guid, { name: v.name, guid: v.guid, keptGuid: winner.guid });
    }
  }
  return { kept: vars.filter((v) => !dropped.has(v.guid)), dropped: [...dropped.values()] };
}

// --- unique-name assignment (collision-proof) --------------------------------------

// Assign one munged name per variable guid. Same-base variables are ranked by rankForName —
// the live one takes the clean name, the rest get a deterministic suffix (CSS "-2", RN "_2")
// and a warning. Grouping first is what makes this order-independent: previously the FIRST
// variable in catalog order won the clean name, so a dead duplicate could shadow its live
// twin. guid → name, so a reference resolves to the same name the declaration used.
function assignNames(
  vars: ThemeVar[],
  baseOf: (v: ThemeVar) => string,
  sep: string,
  uses?: UseCensus,
): { nameByGuid: Map<string, string>; warnings: string[] } {
  const nameByGuid = new Map<string, string>();
  const taken = new Set<string>();
  const warnings: string[] = [];
  const groups = new Map<string, ThemeVar[]>();
  const seen = new Set<string>();
  for (const v of vars) {
    if (seen.has(v.guid)) continue;
    seen.add(v.guid);
    const base = baseOf(v);
    const group = groups.get(base);
    if (group) group.push(v);
    else groups.set(base, [v]);
  }
  const useStr = (v: ThemeVar) => (uses ? `${uses.get(v.guid) ?? 0} use(s)` : `no census`);
  for (const [base, group] of groups) {
    const ranked = group.length > 1 ? [...group].sort((a, b) => rankForName(a, b, uses)) : group;
    for (const v of ranked) {
      let name = base;
      let i = 2;
      while (taken.has(name)) name = `${base}${sep}${i++}`;
      if (name !== base)
        warnings.push(
          `name collision: "${v.name}" ${v.guid} (${useStr(v)}) → "${name}"; ` +
            `"${nameByGuid.get(ranked[0].guid) ?? base}" went to ${ranked[0].guid} ` +
            `(${useStr(ranked[0])})`,
        );
      taken.add(name);
      nameByGuid.set(v.guid, name);
    }
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

function emitWeb(
  vars: ThemeVar[],
  modes: string[],
  primary: string,
  uses?: UseCensus,
): Omit<ThemeResult, "dropped"> {
  const warnings: string[] = [];
  const { nameByGuid, warnings: nameWarn } = assignNames(
    vars,
    (v) => cssVarName(v.name),
    "-",
    uses,
  );
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

function emitRn(
  vars: ThemeVar[],
  modes: string[],
  primary: string,
  uses?: UseCensus,
): Omit<ThemeResult, "dropped"> {
  const warnings: string[] = [];
  const { nameByGuid, warnings: nameWarn } = assignNames(
    vars,
    (v) => constIdent(v.name),
    "_",
    uses,
  );
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
//
// `activeMode` is THE style decision: the requested mode is what gets rooted (`:root` /
// `defaultMode`), with every other mode emitted after it as a switchable `.mode-<slug>`
// class — building "at" a mode has to mean the values a consumer reads by default. Omit it
// and the catalog's primary (most variables' collection default) roots, unchanged. A
// requested mode that matches nothing is reported, never silently swapped for the default.
//
// `uses` is the live-use census (see variableUseCensus); pass it and duplicate names resolve
// by reference count instead of catalog order, with proven-dead duplicates returned in
// `dropped` for the caller to report. Omit it and nothing is dropped.
export function emitTheme(
  vars: ThemeVar[],
  opts: { framework: Framework; activeMode?: string; uses?: UseCensus },
): ThemeResult {
  const modes = unionModes(vars);
  if (modes.length === 0)
    return {
      code: opts.framework === "web" ? ":root {}\n" : "export const theme = {} as const;\n",
      warnings: ["no variables — emitted an empty theme"],
      dropped: [],
    };
  const warnings: string[] = [];
  let primary = primaryMode(vars);
  if (opts.activeMode) {
    const match = resolveMode(modes, opts.activeMode);
    if (match.mode !== null) primary = match.mode;
    else
      warnings.push(
        `requested mode "${opts.activeMode}" is ${match.reason} among [${match.candidates.join(", ")}] — rooted "${primary}" instead`,
      );
  }
  const { kept, dropped } = dedupeByCensus(vars, opts.uses);
  const ordered = orderedModes(modes, primary);
  const res =
    opts.framework === "web"
      ? emitWeb(kept, ordered, primary, opts.uses)
      : emitRn(kept, ordered, primary, opts.uses);
  return { code: res.code, warnings: [...warnings, ...res.warnings], dropped };
}
