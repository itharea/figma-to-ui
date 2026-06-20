// codegen.mts — typed component SCAFFOLD from the IR (Phase 9 / IR-PLAN Phase 4).
// Reads components/<set>.json for the variant union prop type (proposePropApi,
// already in the IR) and EVERY variant's resolved subtree (located in the screens
// IR by guid). For each variant it collects its own reconciled styles — container
// box (w/h), Phase B box-style (background / cornerRadius / strokes / effects /
// opacity), Phase B auto-layout, and the primary text style (font.size,
// lineHeightPx, letterSpacingPx, appFamily, color) + TODOs. The default variant
// stays the fallback. Leaves a clearly-marked `// TODO` wherever a placeholder:true
// text, an open conflict, or a match:none/unmapped value exists — NEVER bakes an
// unconfirmed value silently. TODOs are attributed to the variant they came from.
//
// A SCAFFOLD, not finished code — it mirrors the SYMBOL master and hands the human
// a typed starting point with one styles entry per variant, selected via the
// variant prop. Framework-pluggable via a small template; default RN.
//
// Usage: node codegen.mts <ir-dir> <set-name> [--out <file>] [--framework rn|web]
import * as fs from "fs";
import * as path from "path";
import type { IRNode, IRStyle, IRLayout } from "./screens-lib.mts";
import { mapValue } from "./components-lib.mts";

const argv = process.argv.slice(2);
const dir = argv[0];
const setName = argv[1];
if (!dir || !setName || setName.startsWith("--"))
  throw new Error("usage: codegen.mts <ir-dir> <set-name> [--out <file>] [--framework rn|web]");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const outFile = flag("--out");
const framework = (flag("--framework") ?? "rn").toLowerCase();

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

// The prop-union literal a variant selects on. Single-axis sets key on the single
// axis value (prop `variant`); multi-axis sets compose every axis value with "/".
// This is the SAME mapValue the union type uses, so the styles key always matches a
// valid prop value (proposePropApi parity).
function variantPropKey(v: any): string {
  if (!axisNames.length) return "default";
  return axisNames.map((a) => mapValue(String(v.props[a] ?? ""))).join("/");
}

// --- locate a variant's RESOLVED subtree in the screens IR --------------------
// The variant SYMBOL master appears as a node in the components-page screen; align
// by its guidKey (never re-decode/re-resolve — read the emitted screen tree).
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

const firstText = (n: IRNode | null): IRNode | null => {
  if (!n) return null;
  if (n.font) return n;
  for (const c of n.children ?? []) { const t = firstText(c); if (t) return t; }
  return null;
};
const firstColor = (n: IRNode | null): IRNode | null => {
  if (!n) return null;
  if (n.color?.hex) return n;
  for (const c of n.children ?? []) { const t = firstColor(c); if (t) return t; }
  return null;
};

// Render a color value with a token ref where the IR mapped one (token/var wins;
// else literal + a TODO when the value is unmapped/none against a theme). TODOs are
// pushed onto the per-variant list passed in (attribution preserved by the caller).
function colorRef(
  c: { hex: string | null; token?: string | null; var?: string | null; match: string | null } | undefined,
  label: string,
  todos: string[]
): string {
  if (!c || !c.hex) return "'transparent'";
  if ((c as any).var) return `'${c.hex}' /* token ${(c as any).var} */`; // bound design token (GROUND TRUTH)
  if (c.token) return c.token; // value-matched token ref
  if (c.match === "none" || (typeof c.match === "string" && c.match.startsWith("nearest"))) {
    todos.push(`${label} color ${c.hex} is "${c.match}" against the theme — confirm/reject in decisions.json before shipping the literal`);
    return `'${c.hex}' /* TODO: ${c.match} — adjudicate token */`;
  }
  return `'${c.hex}'`;
}

// --- per-variant style collection --------------------------------------------
// One collected record per variant: its prop key, box, container style fields, the
// primary text style, and the TODOs that variant produced (each already prefixed
// with the variant prop key by `collect`).
type VariantStyle = {
  propKey: string;
  rawName: string;
  isDefault: boolean;
  box: { w: number; h: number };
  bgRef: string; // container background expression (string literal/token/transparent)
  cornerRadius?: IRStyle["cornerRadius"];
  strokes?: IRStyle["strokes"];
  effects?: IRStyle["effects"];
  opacity?: number;
  layout?: IRLayout;
  text: {
    value: string;
    fontSize: number | null;
    lineHeightPx: number | null;
    letterSpacingPx: number | null;
    appFamily: string | null;
    rawFamily: string | null;
    sizeToken: string | null;
    colorRef: string;
  } | null;
  todos: string[];
};

const allTodos: string[] = [];

function collect(v: any): VariantStyle {
  const propKey = variantPropKey(v);
  const todos: string[] = [];
  const push = (msg: string) => todos.push(`[${propKey}] ${msg}`);

  const subtree = findNodeByGuid(v.guidKey);
  if (!subtree) push(`variant subtree not found by guid ${v.guidKey} — using component-level size only`);

  // container box: prefer the resolved subtree box, else the variant size.
  const box = subtree?.box ?? v.size ?? comp.size ?? { w: 0, h: 0 };

  // Phase B container style (background = first fill / own color; cornerRadius;
  // strokes; effects; opacity). A header variant may carry none of these.
  const style: IRStyle | undefined = subtree?.style;
  const firstFill = style?.fills?.find((f) => f.type === "solid" && f.hex);
  const bgColor = firstFill
    ? { hex: firstFill.hex ?? null, var: (firstFill as any).var ?? null, token: null, match: (firstFill as any).var ? "bound" : null }
    : subtree?.color;
  const bgRef = colorRef(bgColor as any, "container", push);

  // primary text style + its TODOs.
  const textNode = firstText(subtree);
  const colorNode = firstColor(subtree);
  let text: VariantStyle["text"] = null;
  if (textNode?.font) {
    if (textNode.text?.placeholder)
      push(`text ${JSON.stringify(textNode.text.value)} is a placeholder (${textNode.text.reason}) — confirm real copy`);
    for (const cf of textNode.font.conflicts ?? [])
      push(`font ${cf.field} ${cf.declared}→~${cf.chosen} reconciliation conflict (box.y=${cf.boxY} vs lh=${cf.lhPx}) — confirm size`);
    const appFamily = textNode.font.appFamily ?? null;
    const rawFamily = textNode.font.family ?? null;
    if (!appFamily) push(`font "${rawFamily}" has no appFamily — set decisions.fontMap["${rawFamily}"]`);
    text = {
      value: textNode.text?.value ?? "",
      fontSize: textNode.font.size ?? null,
      lineHeightPx: textNode.font.lineHeightPx ?? null,
      letterSpacingPx: textNode.font.letterSpacingPx ?? null,
      appFamily,
      rawFamily,
      sizeToken: textNode.font.sizeToken ?? null,
      colorRef: colorRef((textNode.color ?? colorNode?.color) as any, "label", push),
    };
  } else if (subtree) {
    push("no text in this variant subtree — fill typography from the master");
  }

  allTodos.push(...todos);
  return {
    propKey,
    rawName: v.rawName ?? "?",
    isDefault: isDefaultVariant(v),
    box: { w: Math.round((box as any).w ?? (box as any).x ?? 0), h: Math.round((box as any).h ?? (box as any).y ?? 0) },
    bgRef,
    cornerRadius: style?.cornerRadius,
    strokes: style?.strokes,
    effects: style?.effects,
    opacity: style?.opacity,
    layout: subtree?.layout,
    text,
    todos,
  };
}

const collected = variants.length ? variants.map(collect) : [];
// Ensure a `default` fallback key exists even when the matrix's first value didn't
// map to the literal "default": alias the chosen default variant under "default".
const defaultKey = defaultVariant ? variantPropKey(defaultVariant) : "default";

// --- TS prop type -------------------------------------------------------------
const Comp = (comp.name ?? setName).replace(/[^A-Za-z0-9]+/g, " ").replace(/(?:^|\s)(\w)/g, (_: string, c: string) => c.toUpperCase()).replace(/\s/g, "") || "Component";
const propApi = comp.propApi || "/* no variant axes */";
const propType = propApi ? `{ ${propApi} }` : "{}";
// the prop expression the switch/lookup keys on (single-axis → `variant`; multi →
// composed). Falls back to the default key when no axes.
const propKeyExpr =
  axisNames.length === 0 ? `'${defaultKey}'`
  : axisNames.length === 1 ? "variant"
  : axisNames.map((a) => `${kebabProp(a)}`).join(" + '/' + ");
function kebabProp(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").replace(/[^\w-]/g, "").toLowerCase();
}
const propDestructure =
  axisNames.length === 0 ? "" : axisNames.length === 1 ? "variant" : axisNames.map(kebabProp).join(", ");

// --- per-variant style object literals ----------------------------------------
const ind = (s: string, n: number) => s.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

// container style body (web|rn share most fields; key differences handled by flags).
function containerBody(v: VariantStyle, web: boolean): string {
  const lines: string[] = [];
  lines.push(`width: ${v.box.w},`);
  lines.push(`height: ${v.box.h},`);
  lines.push(`${web ? "background" : "backgroundColor"}: ${v.bgRef},`);
  if (v.cornerRadius !== undefined) {
    if (typeof v.cornerRadius === "number") lines.push(`borderRadius: ${v.cornerRadius},`);
    else lines.push(`// borderRadius (per-corner): tl=${v.cornerRadius.tl} tr=${v.cornerRadius.tr} br=${v.cornerRadius.br} bl=${v.cornerRadius.bl}`);
  }
  if (v.strokes?.length) {
    const s = v.strokes[0];
    lines.push(`borderWidth: ${s.weight},`);
    lines.push(`borderColor: ${s.var ? `'${s.hex}' /* token ${s.var} */` : `'${s.hex ?? "transparent"}'`}, // align ${s.align}`);
  }
  if (v.opacity !== undefined) lines.push(`opacity: ${v.opacity},`);
  if (v.effects?.length) {
    const e = v.effects[0];
    if (web) lines.push(`boxShadow: '${e.offsetX}px ${e.offsetY}px ${e.radius}px ${e.spread ?? 0}px ${e.hex ?? "#000"}', // ${e.type}${v.effects.length > 1 ? ` (+${v.effects.length - 1} more — see master)` : ""}`);
    else {
      lines.push(`shadowColor: '${e.hex ?? "#000"}', // ${e.type}`);
      lines.push(`shadowOffset: { width: ${e.offsetX}, height: ${e.offsetY} },`);
      lines.push(`shadowRadius: ${e.radius},`);
    }
  }
  if (v.layout) {
    lines.push(`flexDirection: '${v.layout.mode}',`);
    if (v.layout.gap !== undefined) lines.push(`gap: ${v.layout.gap},`);
    if (v.layout.justify) lines.push(`justifyContent: '${v.layout.justify}',`);
    if (v.layout.align) lines.push(`alignItems: '${v.layout.align}',`);
    if (v.layout.paddingTop !== undefined) lines.push(`paddingTop: ${v.layout.paddingTop},`);
    if (v.layout.paddingRight !== undefined) lines.push(`paddingRight: ${v.layout.paddingRight},`);
    if (v.layout.paddingBottom !== undefined) lines.push(`paddingBottom: ${v.layout.paddingBottom},`);
    if (v.layout.paddingLeft !== undefined) lines.push(`paddingLeft: ${v.layout.paddingLeft},`);
  }
  return lines.join("\n");
}

function labelBody(v: VariantStyle): string {
  const t = v.text;
  if (!t) return `// TODO: no text in the "${v.propKey}" variant subtree — fill typography from the master`;
  const lines: string[] = [];
  if (t.fontSize != null) lines.push(`fontSize: ${t.fontSize},${t.sizeToken ? ` // token ${t.sizeToken}` : ""}`);
  if (t.lineHeightPx != null) lines.push(`lineHeight: ${t.lineHeightPx},`);
  if (t.letterSpacingPx) lines.push(`letterSpacing: ${t.letterSpacingPx},`);
  if (t.appFamily) lines.push(`fontFamily: '${t.appFamily}',`);
  else lines.push(`// TODO: fontFamily — "${t.rawFamily}" unmapped (decisions.fontMap)`);
  lines.push(`color: ${t.colorRef},`);
  return lines.join("\n");
}

// styles map: one container_<key> + label_<key> per variant, plus default aliases.
function stylesMap(web: boolean): string {
  const blocks: string[] = [];
  const safe = (k: string) => k.replace(/[^A-Za-z0-9]+/g, "_");
  for (const v of collected) {
    blocks.push(`  container_${safe(v.propKey)}: {\n${ind(containerBody(v, web), 4)}\n  },`);
    blocks.push(`  label_${safe(v.propKey)}: {\n${ind(labelBody(v), 4)}\n  },`);
  }
  return blocks.join("\n");
}

// runtime lookup: pick the per-variant style by the prop, default as fallback.
function lookup(): string {
  const safe = (k: string) => k.replace(/[^A-Za-z0-9]+/g, "_");
  const keys = collected.map((v) => `'${v.propKey}'`).join(", ");
  return `  const __key = (${propKeyExpr}) as ${collected.length ? collected.map((v) => `'${v.propKey}'`).join(" | ") : "string"};
  const container = (styles as any)['container_' + __key.replace(/[^A-Za-z0-9]+/g, '_')] ?? styles.container_${safe(defaultKey)};
  const label = (styles as any)['label_' + __key.replace(/[^A-Za-z0-9]+/g, '_')] ?? styles.label_${safe(defaultKey)};
  // variant prop values: ${keys}`;
}

const defaultV = collected.find((v) => v.isDefault) ?? collected[0];
const defaultText = defaultV?.text;

const reviewBlock = allTodos.length
  ? "// === REVIEW (unconfirmed values, attributed to the variant) ===\n" + allTodos.map((t) => `// TODO: ${t}`).join("\n")
  : "// (no open TODOs — all variant values were confirmed)";

// --- emit (framework-pluggable template; default React Native) ----------------
function emitRN(): string {
  return `// AUTO-GENERATED SCAFFOLD from IR ${path.basename(dir)}/components/${compFile} — NOT finished code.
// Mirrors the "${comp.name}" SYMBOL master — ALL ${collected.length} variant(s): ${collected.map((v) => v.propKey).join(", ")}.
// Default variant: ${defaultV?.rawName ?? "?"} (key '${defaultKey}', used as fallback).
// Review every // TODO before shipping. (Phase 9 codegen — framework: react-native)
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type ${Comp}Props = ${propType} & { children?: React.ReactNode };

export function ${Comp}({ ${propDestructure}${propDestructure ? ", " : ""}children }: ${Comp}Props) {
  // per-variant styles selected by the variant prop; default variant is the fallback.
${lookup()}
  return (
    <View style={container}>
      ${defaultText ? `<Text style={label}>{${JSON.stringify(defaultText.value)}}</Text>` : "{children}"}
    </View>
  );
}

const styles = StyleSheet.create({
${stylesMap(false)}
});

${reviewBlock}
`;
}

function emitWeb(): string {
  return `// AUTO-GENERATED SCAFFOLD from IR ${path.basename(dir)}/components/${compFile} — NOT finished code.
// Mirrors the "${comp.name}" SYMBOL master — ALL ${collected.length} variant(s): ${collected.map((v) => v.propKey).join(", ")}.
// Default variant: ${defaultV?.rawName ?? "?"} (key '${defaultKey}', used as fallback).
// Review every // TODO before shipping. (Phase 9 codegen — framework: web/react)
import React from 'react';

export type ${Comp}Props = ${propType} & { children?: React.ReactNode };

const styles: Record<string, React.CSSProperties> = {
${stylesMap(true)}
};

export function ${Comp}({ ${propDestructure}${propDestructure ? ", " : ""}children }: ${Comp}Props) {
  // per-variant styles selected by the variant prop; default variant is the fallback.
${lookup()}
  return (
    <div style={container}>
      ${defaultText ? `<span style={label}>{${JSON.stringify(defaultText.value)}}</span>` : "{children}"}
    </div>
  );
}

${reviewBlock}
`;
}

const code = framework === "web" ? emitWeb() : emitRN();

console.error(`codegen: ${comp.name} (${collected.length} variant(s)) → ${framework}, ${allTodos.length} TODO(s)`);
if (outFile) {
  fs.writeFileSync(outFile, code);
  console.error(`wrote ${outFile}`);
}
console.log(code);
