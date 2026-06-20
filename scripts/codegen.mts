// codegen.mts — typed component SCAFFOLD from the IR (Phase 9 / IR-PLAN Phase 4).
// Reads components/<set>.json for the variant union prop type (proposePropApi,
// already in the IR) and the DEFAULT variant's resolved subtree (located in the
// screens IR by guid) for default styles — reconciled font.size, lineHeightPx,
// letterSpacingPx, token refs where present, colors, box dimensions. Leaves a
// clearly-marked `// TODO` wherever a placeholder:true text, an open conflict, or
// a match:none/unmapped value exists — NEVER bakes an unconfirmed value silently.
//
// A SCAFFOLD, not finished code — it mirrors the SYMBOL master and hands the human
// a typed starting point. Framework-pluggable via a small template; default RN.
//
// Usage: node codegen.mts <ir-dir> <set-name> [--out <file>] [--framework rn|web]
import * as fs from "fs";
import * as path from "path";
import type { IRNode } from "./screens-lib.mts";

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

// --- default variant: first value of every axis (proposePropApi's union order) ---
const axes: Record<string, string[]> = comp.axes ?? {};
const axisNames = Object.keys(axes);
const defaultVariant =
  comp.variants?.find((v: any) => axisNames.every((a) => (axes[a]?.[0] !== undefined ? v.props[a] === axes[a][0] : true))) ??
  comp.variants?.[0];

// --- locate the default variant's RESOLVED subtree in the screens IR ----------
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
const subtree = defaultVariant ? findNodeByGuid(defaultVariant.guidKey) : null;

// --- collect default styles from the resolved subtree -------------------------
const todos: string[] = [];
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

// container style from the subtree box + its own background color
const box = subtree?.box ?? defaultVariant?.size ?? comp.size ?? { w: 0, h: 0 };
const bg = subtree?.color?.hex ?? null;
const containerColorTodo = subtree?.color && subtree.color.hex && subtree.color.match && subtree.color.match !== "exact" && !subtree.color.token;

const text = firstText(subtree);
const colorNode = firstColor(subtree);

// Render a value with a token ref where the IR mapped one (token wins; else literal +
// a TODO when the value is unmapped/none against a theme).
function colorRef(c: { hex: string | null; token: string | null; match: string | null } | undefined, label: string): string {
  if (!c || !c.hex) return "'transparent'";
  if (c.token) return c.token; // mapped token ref
  if (c.match === "none" || (typeof c.match === "string" && c.match.startsWith("nearest"))) {
    todos.push(`${label} color ${c.hex} is "${c.match}" against the theme — confirm/reject in decisions.json before shipping the literal`);
    return `'${c.hex}' /* TODO: ${c.match} — adjudicate token */`;
  }
  return `'${c.hex}'`;
}

if (text?.text?.placeholder)
  todos.push(`text ${JSON.stringify(text.text.value)} is a placeholder (${text.text.reason}) — confirm real copy`);
for (const cf of text?.font?.conflicts ?? [])
  todos.push(`font ${cf.field} ${cf.declared}→~${cf.chosen} reconciliation conflict (box.y=${cf.boxY} vs lh=${cf.lhPx}) — confirm size`);

// font default
const fontSize = text?.font?.size ?? null;
const lineHeightPx = text?.font?.lineHeightPx ?? null;
const letterSpacingPx = text?.font?.letterSpacingPx ?? null;
const appFamily = text?.font?.appFamily ?? null;
const rawFamily = text?.font?.family ?? null;
const sizeToken = text?.font?.sizeToken ?? null;
if (text?.font && !appFamily)
  todos.push(`font "${rawFamily}" has no appFamily — set decisions.fontMap["${rawFamily}"]`);

// --- TS prop type -------------------------------------------------------------
const Comp = (comp.name ?? setName).replace(/[^A-Za-z0-9]+/g, " ").replace(/(?:^|\s)(\w)/g, (_: string, c: string) => c.toUpperCase()).replace(/\s/g, "") || "Component";
const propApi = comp.propApi || "/* no variant axes */";
const propType = propApi ? `{ ${propApi} }` : "{}";

// --- emit (framework-pluggable template; default React Native) ----------------
const fontLine = fontSize != null
  ? `    fontSize: ${fontSize},${sizeToken ? ` // token ${sizeToken}` : ""}` +
    (lineHeightPx != null ? `\n    lineHeight: ${lineHeightPx},` : "") +
    (letterSpacingPx ? `\n    letterSpacing: ${letterSpacingPx},` : "") +
    (appFamily ? `\n    fontFamily: '${appFamily}',` : `\n    // TODO: fontFamily — "${rawFamily}" unmapped (decisions.fontMap)`)
  : "    // TODO: no text in the default variant subtree — fill typography from the master";

function emitRN(): string {
  return `// AUTO-GENERATED SCAFFOLD from IR ${path.basename(dir)}/components/${compFile} — NOT finished code.
// Mirrors the "${comp.name}" SYMBOL master (default variant: ${defaultVariant?.rawName ?? "?"}).
// Review every // TODO before shipping. (Phase 9 codegen — framework: react-native)
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type ${Comp}Props = ${propType} & { children?: React.ReactNode };

export function ${Comp}({ ${axisNames.length ? (axisNames.length === 1 ? "variant" : axisNames.map((a) => a.toLowerCase()).join(", ")) : ""}${axisNames.length ? ", " : ""}children }: ${Comp}Props) {
  // default variant styles below; branch per variant as you implement the others.
  return (
    <View style={styles.container}>
      ${text ? `<Text style={styles.label}>{${JSON.stringify(text.text?.value ?? "")}}</Text>` : "{children}"}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: ${Math.round(box.w ?? (box as any).x ?? 0)},
    height: ${Math.round(box.h ?? (box as any).y ?? 0)},
    backgroundColor: ${colorRef(subtree?.color, "container")},
  },
  label: {
${fontLine}
    color: ${colorRef(text?.color ?? colorNode?.color, "label")},
  },
});

${todos.length ? "// === REVIEW (unconfirmed values) ===\n" + todos.map((t) => `// TODO: ${t}`).join("\n") : "// (no open TODOs — all default-variant values were confirmed)"}
`;
}

function emitWeb(): string {
  return `// AUTO-GENERATED SCAFFOLD from IR ${path.basename(dir)}/components/${compFile} — NOT finished code.
// Mirrors the "${comp.name}" SYMBOL master (default variant: ${defaultVariant?.rawName ?? "?"}).
// Review every // TODO before shipping. (Phase 9 codegen — framework: web/react)
import React from 'react';

export type ${Comp}Props = ${propType} & { children?: React.ReactNode };

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: ${Math.round(box.w ?? (box as any).x ?? 0)},
    height: ${Math.round(box.h ?? (box as any).y ?? 0)},
    background: ${colorRef(subtree?.color, "container")},
  },
  label: {
${fontLine.replace(/fontSize: (\d+),/, "fontSize: $1,")}
    color: ${colorRef(text?.color ?? colorNode?.color, "label")},
  },
};

export function ${Comp}({ children }: ${Comp}Props) {
  return (
    <div style={styles.container}>
      ${text ? `<span style={styles.label}>{${JSON.stringify(text.text?.value ?? "")}}</span>` : "{children}"}
    </div>
  );
}

${todos.length ? "// === REVIEW (unconfirmed values) ===\n" + todos.map((t) => `// TODO: ${t}`).join("\n") : "// (no open TODOs)"}
`;
}

const code = framework === "web" ? emitWeb() : emitRN();

console.error(`codegen: ${comp.name} (${comp.variants?.length ?? 0} variants) → ${framework}, ${todos.length} TODO(s)`);
if (outFile) {
  fs.writeFileSync(outFile, code);
  console.error(`wrote ${outFile}`);
}
console.log(code);
