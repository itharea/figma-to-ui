// codegen.mts — multi-file component SCAFFOLD from the IR (improvement B-codegen).
//
// Replaces the old single-default-container output with a real component FOLDER:
//   <out>/<slug>/index.tsx       — the meta component: Props (variant union + the
//                                   COLLAPSED non-variant props) + a dispatcher that
//                                   forwards props to the right per-variant component.
//   <out>/<slug>/types.ts        — the shared Props type (type-only import, so index
//                                   and the variant files never form a runtime cycle).
//   <out>/<slug>/<variant>.tsx   — ONE file per variant, each rendering THAT variant's
//                                   OWN resolved subtree as a JSX tree (rn: View/Text/
//                                   Image + StyleSheet; web: div/span + style objects)
//                                   with the reconciled per-node style/layout/font/text
//                                   (cornerRadius, strokes incl. per-side borderWidths,
//                                   effects, opacity, flex layout, fontSize/lineHeight/
//                                   letterSpacing, text case/align). Bound nodes consume
//                                   props (the ELEGANT COLLAPSE, see PROP MODEL below).
//
// PROP MODEL (idiomatic collapse, driven by Phase A bindings — facts only):
//   • TEXT prop  bound to a node's `characters` → a string prop; the Text uses the
//     prop, falling back to the reconciled default text.
//   • BOOL prop  bound to a node's `visible`    → the node renders conditionally.
//   • COLLAPSE: when a BOOL-visible prop AND a TEXT prop bind the SAME node, emit ONE
//     optional `name?: string` (present → render with that text, absent → omit). This
//     wins over a separate {show, text} pair.
//   • INSTANCE_SWAP prop → a `React.ReactNode` slot prop, rendered where the bound
//     instance node sits.
//   camelCase names (from Phase A `props[].name`); name collisions are de-duped
//   deterministically; each prop keeps a comment with its original Figma name.
//
// A SCAFFOLD, not finished code. Leaves a clearly-marked `// TODO` on every
// placeholder:true text, unmapped font, open reconciliation conflict, or match:none —
// NEVER bakes an unconfirmed value silently. TODOs are attributed to the variant.
//
// Usage: node codegen.mts <ir-dir> <set-name> [--out <dir>] [--framework rn|web]
//   NOTE: --out is now an output DIRECTORY (was a single file). The folder
//   <out>/<slug>/ is written and a written-files summary is printed to stderr.
import * as fs from "fs";
import * as path from "path";
import type { IRNode } from "./screens-lib.mts";
import { mapValue } from "./components-lib.mts";

const argv = process.argv.slice(2);
const dir = argv[0];
const setName = argv[1];
if (!dir || !setName || setName.startsWith("--"))
  throw new Error("usage: codegen.mts <ir-dir> <set-name> [--out <dir>] [--framework rn|web]");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const outDir = flag("--out");
const framework = (flag("--framework") ?? "rn").toLowerCase();
if (framework !== "rn" && framework !== "web")
  throw new Error(`--framework must be rn|web (got "${framework}")`);
const web = framework === "web";

const readJSON = (rel: string): any => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};

// --- locate the component file: components/<slug>.json, slug-tolerant ---------
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const compDir = path.join(dir, "components");
if (!fs.existsSync(compDir)) throw new Error(`${dir}: no components/ — not an IR (or no component sets)`);
const wantSlug = slugify(setName);
let compFile: string | null = null;
let comp: any = null;
for (const f of fs.readdirSync(compDir)) {
  if (!f.endsWith(".json")) continue;
  const c = JSON.parse(fs.readFileSync(path.join(compDir, f), "utf8"));
  if (f.replace(/\.json$/, "") === wantSlug || slugify(c.name ?? "") === wantSlug) {
    compFile = f;
    comp = c;
    break;
  }
}
if (!comp) {
  const avail = fs.readdirSync(compDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  throw new Error(`no component set "${setName}" in ${dir}/components/. Available: ${avail.slice(0, 40).join(", ")}${avail.length > 40 ? " …" : ""}`);
}

// --- axes / default variant ---------------------------------------------------
const axes: Record<string, string[]> = comp.axes ?? {};
const axisNames = Object.keys(axes);
const variants: any[] = comp.variants ?? [];
const isDefaultVariant = (v: any) =>
  axisNames.every((a) => (axes[a]?.[0] !== undefined ? v.props[a] === axes[a][0] : true));
const defaultVariant = variants.find(isDefaultVariant) ?? variants[0];

// The prop-union literal a variant selects on. Single-axis → the value; multi-axis →
// every axis value composed with "/". SAME mapValue the union type uses (parity).
function variantPropKey(v: any): string {
  if (!axisNames.length) return "default";
  return axisNames.map((a) => mapValue(String(v.props[a] ?? ""))).join("/");
}

// --- locate a variant's RESOLVED subtree in the screens IR --------------------
const manifest = readJSON("manifest.json") ?? {};
function findNodeByGuid(guid: string): IRNode | null {
  for (const rel of manifest.artifacts?.screens ?? []) {
    const root = readJSON(rel);
    let hit: IRNode | null = null;
    (function w(n: any) {
      if (!n || hit) return;
      if (n.guid === guid) { hit = n; return; }
      for (const c of n.children ?? []) w(c);
    })(root);
    if (hit) return hit;
  }
  return null;
}

// === PROP MODEL — the idiomatic collapse (a codegen transform over Phase A facts) ===
type Logical =
  | { name: string; tsType: "string"; role: "text"; figNames: string[]; defText: string | null; defKey: string }
  | { name: string; tsType: "boolean"; role: "bool"; figNames: string[]; defKey: string }
  | { name: string; tsType: "React.ReactNode"; role: "slot"; figNames: string[]; defKey: string };

const props: any[] = comp.props ?? [];
const propGroups: { node: string; props: string[] }[] = comp.propGroups ?? [];
// defKey → Phase A prop record (the stable identity; `name` can collide).
const propByDefKey = new Map<string, any>();
for (const p of props) propByDefKey.set(p.defKey, p);

// Group props by the default-master node they bind (so a bool-visible + text pair on
// the SAME node collapses to one). A prop with no binding still gets its own slot.
const propsByNode = new Map<string, any[]>(); // node guid → props binding it
const unbound: any[] = [];
for (const p of props) {
  if (!p.bindings?.length) { unbound.push(p); continue; }
  for (const b of p.bindings) (propsByNode.get(b.node) ?? propsByNode.set(b.node, []).get(b.node)!).push(p);
}

// Build the logical prop list + a defKey → logical map. The COLLAPSE happens here:
// on a node carrying a BOOL-visible prop AND a TEXT-characters prop, emit one optional
// string; both defKeys point at that single logical prop.
const logicals: Logical[] = [];
const logicalByDefKey = new Map<string, Logical>();
const usedNames = new Set<string>();
// de-dupe an emitted prop name deterministically (collision → name2, name3, …).
function uniqueName(base: string): string {
  let n = base || "prop";
  let i = 2;
  while (usedNames.has(n)) n = `${base}${i++}`;
  usedNames.add(n);
  return n;
}
const seenDefKeys = new Set<string>();

// Deterministic order: walk props[] in file order; the first prop of a collapsed pair
// drives placement (its node's other prop is folded in).
for (const p of props) {
  if (seenDefKeys.has(p.defKey)) continue;
  // find a collapse partner on the same node (bool-visible ⊕ text-characters).
  const node = p.bindings?.find((b: any) => b.field === "visible" || b.field === "characters")?.node;
  const onNode = node ? (propsByNode.get(node) ?? []) : [];
  const textP = onNode.find((q) => q.kind === "text");
  const boolP = onNode.find((q) => q.kind === "boolean");
  if (textP && boolP) {
    // COLLAPSE → one optional string. Name from the TEXT prop. Both defKeys map here.
    const name = uniqueName(textP.name);
    const lg: Logical = {
      name, tsType: "string", role: "text", defKey: textP.defKey,
      figNames: [textP.rawName, boolP.rawName], defText: typeof textP.default === "string" ? textP.default : null,
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
    const lg: Logical = { name: uniqueName(p.name), tsType: "string", role: "text", defKey: p.defKey, figNames: [p.rawName], defText: typeof p.default === "string" ? p.default : null };
    logicals.push(lg); logicalByDefKey.set(p.defKey, lg);
  } else if (p.kind === "boolean") {
    const lg: Logical = { name: uniqueName(p.name), tsType: "boolean", role: "bool", defKey: p.defKey, figNames: [p.rawName] };
    logicals.push(lg); logicalByDefKey.set(p.defKey, lg);
  } else {
    const lg: Logical = { name: uniqueName(p.name), tsType: "React.ReactNode", role: "slot", defKey: p.defKey, figNames: [p.rawName] };
    logicals.push(lg); logicalByDefKey.set(p.defKey, lg);
  }
}

// --- identifiers --------------------------------------------------------------
const Comp = (comp.name ?? setName).replace(/[^A-Za-z0-9]+/g, " ").replace(/(?:^|\s)(\w)/g, (_: string, c: string) => c.toUpperCase()).replace(/\s/g, "") || "Component";
const slug = slugify(comp.name ?? setName) || "component";
function variantComponentName(v: any): string {
  const k = variantPropKey(v);
  const camel = k.replace(/[^A-Za-z0-9]+/g, " ").replace(/(?:^|\s)(\w)/g, (_: string, c: string) => c.toUpperCase()).replace(/\s/g, "");
  return `${Comp}${camel || "Default"}`;
}
const variantFileSlug = (v: any) => slugify(variantPropKey(v)) || "default";

// the prop expression the dispatcher keys on (single-axis → `variant`; multi-axis →
// composed). Falls back to 'default' when no axes.
const defaultKey = defaultVariant ? variantPropKey(defaultVariant) : "default";
const propKeyExpr =
  axisNames.length === 0 ? `'${defaultKey}'`
  : axisNames.length === 1 ? "variant"
  : axisNames.map((a) => kebabProp(a)).join(" + '/' + ");
function kebabProp(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").replace(/[^\w-]/g, "").toLowerCase();
}

// === per-node JSX rendering (a variant's resolved subtree → a JSX tree) =========
const allTodos: string[] = [];
const ind = (s: string, n: number) => s.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

// safe style-key (one StyleSheet entry / style object per node, by IR id).
const styleKey = (n: IRNode) => `n_${(n.id || n.guid || "x").replace(/[^A-Za-z0-9]+/g, "_")}`;

// color expression with token provenance; pushes a TODO on match:none/nearest.
function colorRef(
  c: { hex: string | null; var?: string | null; token?: string | null; match?: string | null } | undefined,
  label: string, todos: string[]
): string {
  if (!c || !c.hex) return "'transparent'";
  if (c.var) return `'${c.hex}' /* token ${c.var} */`;
  if (c.token) return c.token;
  if (c.match === "none" || (typeof c.match === "string" && c.match.startsWith("nearest"))) {
    todos.push(`${label} color ${c.hex} is "${c.match}" against the theme — adjudicate in decisions.json before shipping the literal`);
    return `'${c.hex}' /* TODO: ${c.match} — adjudicate token */`;
  }
  return `'${c.hex}'`;
}

// One node's style object body (container/box fields). web|rn share most fields.
function nodeStyleBody(n: IRNode, push: (m: string) => void): string {
  const lines: string[] = [];
  const s = n.style;
  // size: emit when fixed (a hug/grow child sizes itself; still record for fidelity).
  if (n.box) { if (n.box.w) lines.push(`width: ${n.box.w},`); if (n.box.h) lines.push(`height: ${n.box.h},`); }
  // background = first solid fill (bound var wins as a token comment).
  const fill = s?.fills?.find((f) => f.type === "solid" && f.hex);
  if (fill) {
    const ref = colorRef({ hex: fill.hex ?? null, var: (fill as any).var ?? null, match: (fill as any).var ? "bound" : null }, `${n.name} background`, push);
    lines.push(`${web ? "background" : "backgroundColor"}: ${ref},`);
  }
  if (s?.cornerRadius !== undefined) {
    if (typeof s.cornerRadius === "number") lines.push(`borderRadius: ${s.cornerRadius},`);
    else {
      lines.push(`borderTopLeftRadius: ${s.cornerRadius.tl},`);
      lines.push(`borderTopRightRadius: ${s.cornerRadius.tr},`);
      lines.push(`borderBottomRightRadius: ${s.cornerRadius.br},`);
      lines.push(`borderBottomLeftRadius: ${s.cornerRadius.bl},`);
    }
  }
  // strokes + per-side widths (improvement 3-borders).
  if (s?.strokes?.length) {
    const st = s.strokes[0];
    const cref = st.var ? `'${st.hex}' /* token ${st.var} */` : `'${st.hex ?? "transparent"}'`;
    if (s.borderWidths) {
      const bw = s.borderWidths;
      if (bw.top) lines.push(`borderTopWidth: ${bw.top},`);
      if (bw.right) lines.push(`borderRightWidth: ${bw.right},`);
      if (bw.bottom) lines.push(`borderBottomWidth: ${bw.bottom},`);
      if (bw.left) lines.push(`borderLeftWidth: ${bw.left},`);
      lines.push(`borderColor: ${cref}, // align ${st.align}`);
    } else {
      lines.push(`borderWidth: ${st.weight},`);
      lines.push(`borderColor: ${cref}, // align ${st.align}`);
    }
    if (st.dash?.length) lines.push(web ? `// dashed stroke: ${JSON.stringify(st.dash)} (CSS border-style:dashed)` : `// dashed stroke: ${JSON.stringify(st.dash)} (RN borderStyle:'dashed')`);
  }
  if (s?.opacity !== undefined) lines.push(`opacity: ${s.opacity},`);
  if (s?.effects?.length) {
    const e = s.effects[0];
    if (web) lines.push(`boxShadow: '${e.offsetX}px ${e.offsetY}px ${e.radius}px ${e.spread ?? 0}px ${e.hex ?? "#000"}', // ${e.type}${s.effects.length > 1 ? ` (+${s.effects.length - 1} more — see master)` : ""}`);
    else {
      lines.push(`shadowColor: '${e.hex ?? "#000"}', // ${e.type}`);
      lines.push(`shadowOffset: { width: ${e.offsetX}, height: ${e.offsetY} },`);
      lines.push(`shadowRadius: ${e.radius},`);
      if (s.effects.length > 1) lines.push(`// +${s.effects.length - 1} more effect(s) — see master`);
    }
  }
  // auto-layout container.
  const l = n.layout;
  if (l) {
    lines.push(`display: 'flex',`);
    lines.push(`flexDirection: '${l.mode}',`);
    if (l.gap !== undefined) lines.push(`gap: ${l.gap},`);
    if (l.justify) lines.push(`justifyContent: '${l.justify}',`);
    if (l.align) lines.push(`alignItems: '${l.align}',`);
    if (l.paddingTop !== undefined) lines.push(`paddingTop: ${l.paddingTop},`);
    if (l.paddingRight !== undefined) lines.push(`paddingRight: ${l.paddingRight},`);
    if (l.paddingBottom !== undefined) lines.push(`paddingBottom: ${l.paddingBottom},`);
    if (l.paddingLeft !== undefined) lines.push(`paddingLeft: ${l.paddingLeft},`);
    if (l.wrap) lines.push(`flexWrap: 'wrap',`);
  }
  // node as a flex child.
  if (n.grow) lines.push(`flexGrow: ${n.grow},`);
  if (n.alignSelf) lines.push(`alignSelf: '${n.alignSelf}',`);
  if (n.minW) lines.push(`minWidth: ${n.minW},`);
  if (n.minH) lines.push(`minHeight: ${n.minH},`);
  if (n.aspectRatio) lines.push(`aspectRatio: ${n.aspectRatio},`);
  return lines.join("\n");
}

// One TEXT node's typography style body, pushing TODOs for unmapped font / conflicts.
function textStyleBody(n: IRNode, push: (m: string) => void): string {
  const lines: string[] = [];
  const f = n.font;
  if (f) {
    if (f.size != null) lines.push(`fontSize: ${f.size},${f.sizeToken ? ` // token ${f.sizeToken}` : ""}`);
    if (f.lineHeightPx != null) lines.push(`lineHeight: ${f.lineHeightPx},`);
    if (f.letterSpacingPx) lines.push(`letterSpacing: ${f.letterSpacingPx},`);
    if (f.appFamily) lines.push(`fontFamily: '${f.appFamily}',`);
    else { lines.push(`// TODO: fontFamily — "${f.family}" unmapped (decisions.fontMap)`); push(`font "${f.family}" has no appFamily — set decisions.fontMap["${f.family}"]`); }
    for (const cf of f.conflicts ?? []) push(`font ${cf.field} ${cf.declared}→~${cf.chosen} reconciliation conflict (box.y=${cf.boxY} vs lh=${cf.lhPx}) — confirm size`);
  }
  const cref = colorRef(n.color as any, `${n.name} text`, push);
  lines.push(`color: ${cref},`);
  if (n.text?.case) lines.push(`textTransform: '${n.text.case}',`);
  if (n.text?.align) lines.push(`textAlign: '${n.text.align}',`);
  return lines.join("\n");
}

// --- the per-variant render: walk the subtree, emit JSX + collect style entries.
type VariantRender = {
  v: any;
  propKey: string;
  compName: string;
  fileSlug: string;
  jsx: string; // the JSX tree (indented for inside the return)
  styles: { key: string; body: string }[];
  usedProps: Set<string>; // logical prop names this variant references
  todos: string[];
};

function renderVariant(v: any): VariantRender {
  const propKey = variantPropKey(v);
  const todos: string[] = [];
  const push = (m: string) => todos.push(`[${propKey}] ${m}`);
  const styles: { key: string; body: string }[] = [];
  const usedProps = new Set<string>();

  // node guid → logical prop, via THIS variant's bindings (defKey-joined). A node may
  // carry a text binding, a visibility binding, an instance-swap binding, or several.
  const bindingsOf = new Map<string, { text?: Logical; bool?: Logical; slot?: Logical }>();
  for (const b of (v.bindings ?? []) as any[]) {
    const lg = logicalByDefKey.get(b.defKey);
    if (!lg) continue;
    const slot = bindingsOf.get(b.node) ?? {};
    if (b.field === "characters" && lg.role === "text") slot.text = lg;
    else if (b.field === "visible") slot.bool = lg; // may be a collapsed text logical
    else if (b.field === "symbolId" && lg.role === "slot") slot.slot = lg;
    bindingsOf.set(b.node, slot);
  }

  const subtree = findNodeByGuid(v.guidKey);
  if (!subtree) {
    push(`variant subtree not found by guid ${v.guidKey} — emitting an empty shell`);
    return { v, propKey, compName: variantComponentName(v), fileSlug: variantFileSlug(v), jsx: web ? "<div />" : "<View />", styles, usedProps, todos };
  }

  const Box = web ? "div" : "View";
  const Txt = web ? "span" : "Text";

  function emit(n: IRNode, depth: number): string {
    const pad = "  ".repeat(depth);
    const sk = styleKey(n);
    const binds = bindingsOf.get(n.guid);
    const styleAttr = web ? `style={styles.${sk}}` : `style={styles.${sk}}`;

    // TEXT node → <Text>/<span>. Bound text → prop (fallback to default), else literal.
    if (n.type === "text") {
      styles.push({ key: sk, body: textStyleBody(n, push) });
      const raw = n.text?.value ?? "";
      if (n.text?.placeholder) push(`text ${JSON.stringify(raw)} on "${n.name}" is a placeholder (${n.text.reason}) — confirm real copy`);
      let content: string;
      const textLg = binds?.text;
      if (textLg) {
        usedProps.add(textLg.name);
        const fb = textLg.defText ?? raw;
        content = `{${textLg.name} ?? ${JSON.stringify(fb)}}`;
      } else {
        content = `{${JSON.stringify(raw)}}`;
      }
      // NOTE: the placeholder TODO is recorded via push() (variant TODO block +
      // REVIEW) — NOT as an inline JSX comment, which is invalid at the head of a
      // `{cond && ( … )}` wrapper. We keep the JSX itself syntactically clean.
      const el = `${pad}<${Txt} ${styleAttr}>${content}</${Txt}>`;
      return wrapConditional(el, binds, depth, n);
    }

    // INSTANCE_SWAP slot node → render the ReactNode prop where the instance sits.
    if (binds?.slot) {
      usedProps.add(binds.slot.name);
      styles.push({ key: sk, body: nodeStyleBody(n, push) });
      const el = `${pad}<${Box} ${styleAttr}>{${binds.slot.name}}</${Box}>`;
      return wrapConditional(el, binds, depth, n);
    }

    // container / leaf box. Recurse into children.
    styles.push({ key: sk, body: nodeStyleBody(n, push) });
    const kids = (n.children ?? []).filter((c) => (c as any).visible !== false);
    let inner = kids.map((c) => emit(c, depth + 1)).join("\n");
    // a leaf box that has neither children nor binding: still emit (geometry/style).
    if (n.type === "instance" && !kids.length) {
      // an instance with no resolved children → leave a TODO (icon master placeholder).
      push(`instance "${n.name}" (${n.guid}) has no resolved children — confirm the icon master`);
      inner = `${"  ".repeat(depth + 1)}{/* TODO: instance "${n.name}" — confirm icon master (${n.guid}) */}`;
    }
    const el = inner
      ? `${pad}<${Box} ${styleAttr}>\n${inner}\n${pad}</${Box}>`
      : `${pad}<${Box} ${styleAttr} />`;
    return wrapConditional(el, binds, depth, n);
  }

  // a BOOL-visible binding (incl. a collapsed text logical) makes the node conditional.
  function wrapConditional(el: string, binds: { text?: Logical; bool?: Logical; slot?: Logical } | undefined, depth: number, n: IRNode): string {
    const cond = binds?.bool;
    if (!cond) return el;
    usedProps.add(cond.name);
    const pad = "  ".repeat(depth);
    // collapsed text logical → render when the string is provided (present → show).
    const test = cond.role === "text" ? `${cond.name} != null` : cond.name === undefined ? "true" : cond.name;
    const body = el.replace(new RegExp(`^${pad}`), "");
    return `${pad}{${test} && (\n${ind(body, 2).replace(/^/, pad)}\n${pad})}`;
  }

  const jsx = emit(subtree, 0);
  return { v, propKey, compName: variantComponentName(v), fileSlug: variantFileSlug(v), jsx, styles, usedProps, todos };
}

const rendered = variants.map(renderVariant);
for (const r of rendered) allTodos.push(...r.todos);

// === FILE EMISSION ============================================================
const reactNodeUsed = logicals.some((l) => l.role === "slot");

// Props type body (shared by index + types.ts). Variant union first, then the
// collapsed non-variant props (all optional). Each prop keeps its Figma name.
function propsTypeBody(): string {
  const lines: string[] = [];
  if (comp.propApi) lines.push(`  ${comp.propApi};`);
  for (const l of logicals) {
    const fig = l.figNames.join(" + ");
    lines.push(`  /** Figma: ${fig} */`);
    lines.push(`  ${l.name}?: ${l.tsType};`);
  }
  return lines.join("\n");
}

function typesFile(): string {
  return `// AUTO-GENERATED — shared Props type for the "${comp.name}" component folder.
// Type-only module so index.tsx and the per-variant files never form a runtime cycle.
import type * as React from 'react';

export type ${Comp}Props = {
${propsTypeBody()}
};
`;
}

// the destructure of logical props (all optional) for a variant component signature.
function destructure(used: Set<string>): string {
  const names = logicals.filter((l) => used.has(l.name)).map((l) => l.name);
  return names.length ? `{ ${names.join(", ")} }` : "_props";
}

function variantFile(r: VariantRender): string {
  const imports = web
    ? `import * as React from 'react';`
    : `import * as React from 'react';\nimport { View, Text, StyleSheet } from 'react-native';`;
  const stylesDecl = web
    ? `const styles: Record<string, React.CSSProperties> = {\n${r.styles.map((s) => `  ${s.key}: {\n${ind(s.body, 4)}\n  },`).join("\n")}\n};`
    : `const styles = StyleSheet.create({\n${r.styles.map((s) => `  ${s.key}: {\n${ind(s.body, 4)}\n  },`).join("\n")}\n});`;
  const todoBlock = r.todos.length
    ? "\n// === TODO (this variant — unconfirmed values) ===\n" + r.todos.map((t) => `// TODO: ${t}`).join("\n") + "\n"
    : "\n// (no open TODOs for this variant)\n";
  return `// AUTO-GENERATED SCAFFOLD — "${comp.name}" variant "${r.propKey}" (${r.v.rawName}). NOT finished code.
// Renders this variant's OWN resolved subtree (guid ${r.v.guidKey}) with reconciled
// per-node style/layout/font/text; bound nodes consume props. Review every // TODO.
${imports}
import type { ${Comp}Props } from './types';

export function ${r.compName}(${destructure(r.usedProps)}: ${Comp}Props) {
  return (
${ind(r.jsx, 4)}
  );
}

${stylesDecl}
${todoBlock}`;
}

function indexFile(): string {
  const reactImport = web ? `import * as React from 'react';` : `import * as React from 'react';`;
  const variantImports = rendered.map((r) => `import { ${r.compName} } from './${r.fileSlug}';`).join("\n");
  // dispatcher: map variant prop key → variant component. Default is the fallback.
  const cases = rendered.map((r) => `    case '${r.propKey}': return <${r.compName} {...props} />;`).join("\n");
  const defaultR = rendered.find((r) => r.v.guidKey === defaultVariant?.guidKey) ?? rendered[0];
  const destructured = axisNames.length === 0 ? "" : axisNames.length === 1 ? "variant" : axisNames.map(kebabProp).join(", ");
  const reviewBlock = allTodos.length
    ? "\n// === REVIEW (all open TODOs, attributed to the variant) ===\n" + allTodos.map((t) => `// TODO: ${t}`).join("\n") + "\n"
    : "\n// (no open TODOs — all variant values were confirmed)\n";
  return `// AUTO-GENERATED SCAFFOLD from IR ${path.basename(dir)}/components/${compFile} — NOT finished code.
// The "${comp.name}" component: a meta dispatcher over ${rendered.length} variant(s)
// [${rendered.map((r) => r.propKey).join(", ")}], one file each. Framework: ${web ? "web/react" : "react-native"}.
// Props = the variant union + the COLLAPSED non-variant props (idiomatic). Review TODOs.
${reactImport}
import type { ${Comp}Props } from './types';
${variantImports}

export type { ${Comp}Props };

export function ${Comp}(props: ${Comp}Props) {${destructured ? `\n  const { ${destructured} } = props;` : ""}
  switch (${propKeyExpr}) {
${cases}
    default: return <${defaultR.compName} {...props} />; // '${defaultR.propKey}' is the fallback
  }
}

export default ${Comp};
${reviewBlock}`;
}

// --- write the folder ---------------------------------------------------------
console.error(`codegen: ${comp.name} (${rendered.length} variant(s)) → ${framework}, ${allTodos.length} TODO(s), ${logicals.length} prop(s)`);
const files: { rel: string; content: string }[] = [
  { rel: "types.ts", content: typesFile() },
  { rel: "index.tsx", content: indexFile() },
  ...rendered.map((r) => ({ rel: `${r.fileSlug}.tsx`, content: variantFile(r) })),
];

if (outDir) {
  const folder = path.join(outDir, slug);
  fs.mkdirSync(folder, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(folder, f.rel), f.content);
  console.error(`wrote ${folder}/ (${files.length} files):`);
  for (const f of files) console.error(`  ${slug}/${f.rel}`);
} else {
  // no --out: print the folder contents to stdout (each file headed by its path).
  console.error(`(no --out — printing ${files.length} file(s) to stdout)`);
  console.log(files.map((f) => `// ==== ${slug}/${f.rel} ====\n${f.content}`).join("\n\n"));
}

// always echo the index to stdout as the primary artifact when writing to disk.
if (outDir) console.log(indexFile());
