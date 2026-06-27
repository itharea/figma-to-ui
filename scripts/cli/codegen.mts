// codegen.mts — multi-file component SCAFFOLD from the IR. Emits a component folder:
//   <out>/<slug>/index.tsx       — meta component: Props (variant union + COLLAPSED
//                                   non-variant props) + a dispatcher to the variant files.
//   <out>/<slug>/types.ts        — the shared Props type (type-only import, so index and
//                                   the variant files never form a runtime cycle).
//   <out>/<slug>/<variant>.tsx   — one file per variant, each rendering THAT variant's own
//                                   resolved subtree as JSX (rn: View/Text/Image + StyleSheet;
//                                   web: div/span + style objects) with the reconciled per-node
//                                   style/layout/font/text. Bound nodes consume props (see
//                                   PROP MODEL).
//
// PROP MODEL (driven by Phase A bindings — facts only):
//   • TEXT prop bound to a node's `characters` → a string prop (falls back to the default).
//   • BOOL prop bound to a node's `visible`    → the node renders conditionally.
//   • COLLAPSE: a BOOL-visible prop AND a TEXT prop on the SAME node → ONE optional
//     `name?: string` (present → render with that text, absent → omit).
//   • INSTANCE_SWAP prop → a `React.ReactNode` slot, rendered where the instance node sits.
//   camelCase names from Phase A; collisions de-duped deterministically; each keeps its
//   original Figma name in a comment.
//
// A SCAFFOLD, not finished code: every placeholder text, unmapped font, open reconciliation
// conflict, or match:none gets a `// TODO` attributed to the variant — never a silent value.
//
// Usage: node cli/codegen.mts <ir-dir> <set-name> [--out <dir>] [--framework rn|web]
//   (--out is an output DIRECTORY; <out>/<slug>/ is written, a file summary to stderr.)
import * as fs from "fs";
import * as path from "path";
import type { IRNode } from "../lib/screens-lib.mts";
import { mapValue, deriveLogicals, type Logical } from "../lib/components-lib.mts";
import { disambiguateJustify } from "../lib/reconcile-lib.mts";
import { cssVarName, tsAccessor } from "../lib/theme-lib.mts";
import { overlap, hasSignificantNonAdjacentOverlap } from "../lib/layout-lib.mts";
import { load, colorStr } from "../lib/figma-index.mts";
import { extractGeometry, emitIconComponent } from "../lib/svg-lib.mts";
import { slugify, compIdent, kebab } from "../lib/naming.mts";

const argv = process.argv.slice(2);
const dir = argv[0];
const setName = argv[1];
if (!dir || !setName || setName.startsWith("--"))
  throw new Error(
    "usage: codegen.mts <ir-dir> <set-name> [--out <dir>] [--framework rn|web] [--theme-import <module>] [--images <dir>]",
  );
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outDir = flag("--out");
// Decoded .fig images dir (the unzipped fig's `images/`, raster fills by content hash).
// When given (with --out), codegen EXTRACTS each referenced image fill into the component
// folder's assets/ and emits a real src reference instead of a placeholder TODO.
const imagesDir = flag("--images");
const framework = (flag("--framework") ?? "rn").toLowerCase();
if (framework !== "rn" && framework !== "web")
  throw new Error(`--framework must be rn|web (got "${framework}")`);
const web = framework === "web";
// Module a generated RN component imports `{ theme, defaultMode }` from (theme-gen.mts
// output). web references CSS custom properties inline (no import).
const themeImport = flag("--theme-import") ?? "./theme";

// A bound-variable value as a reference into the generated theme, using the
// SHARED theme-lib munging so codegen and theme-gen never drift. web → CSS var() (numeric
// tokens are unit-less, so a px context wraps them in calc(... * 1px)); rn → a runtime
// `theme[defaultMode].<path>` member access (requires the import variantFile injects).
const themeRef = (varName: string, numeric: boolean): string =>
  web
    ? numeric
      ? `'calc(var(${cssVarName(varName)}) * 1px)'`
      : `'var(${cssVarName(varName)})'`
    : `theme[defaultMode].${tsAccessor(varName)}`;
const THEME_MARK = "theme[defaultMode]"; // sentinel: a variant file that contains it needs the import

const readJSON = (rel: string): any => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};

// --- locate the component file: components/<slug>.json, slug-tolerant ---------
const compDir = path.join(dir, "components");
if (!fs.existsSync(compDir))
  throw new Error(`${dir}: no components/ — not an IR (or no component sets)`);

// Registry of ALL catalog components, keyed by the set `guid` AND every
// `variants[].guidKey`. An instance's `component.guid` (= symbolData.symbolID) is a
// variant guidKey (or set guid), so this resolves a nested instance to its owning
// component + the specific variant — the basis for emitting a child-component
// reference instead of inlining. Built in the same pass that locates the target set.
type RegEntry = { slug: string; Comp: string; comp: any; variant: any };
const registry = new Map<string, RegEntry>();
const wantSlug = slugify(setName);
const availSlugs: string[] = [];
let compFile: string | null = null;
let comp: any = null;
for (const f of fs.readdirSync(compDir)) {
  if (!f.endsWith(".json")) continue;
  const fslug = f.replace(/\.json$/, "");
  availSlugs.push(fslug);
  const c = JSON.parse(fs.readFileSync(path.join(compDir, f), "utf8"));
  const Comp = compIdent(c.name ?? fslug);
  if (c.guid) registry.set(c.guid, { slug: fslug, Comp, comp: c, variant: null });
  for (const v of c.variants ?? [])
    if (v.guidKey) registry.set(v.guidKey, { slug: fslug, Comp, comp: c, variant: v });
  if (fslug === wantSlug || slugify(c.name ?? "") === wantSlug) {
    compFile = f;
    comp = c;
  }
}
if (!comp) {
  throw new Error(
    `no component set "${setName}" in ${dir}/components/. Available: ${availSlugs.slice(0, 40).join(", ")}${availSlugs.length > 40 ? " …" : ""}`,
  );
}

// --- axes / default variant ---------------------------------------------------
const axes: Record<string, string[]> = comp.axes ?? {};
const axisNames = Object.keys(axes);
// A component with NO detected variants (a heuristic single-frame component — e.g.
// `stroke-hint` detected a bordered frame, no variant axis) still IS a component: treat
// the set frame itself as one default variant rendered from its own subtree, instead of
// crashing on an empty `rendered[]` (its guid resolves in the screens IR like any variant).
const variants: any[] = comp.variants?.length
  ? comp.variants
  : comp.guid
    ? [
        {
          guidKey: comp.guid,
          props: {},
          rawName: comp.name ?? "default",
          bindings: [],
          size: comp.size,
        },
      ]
    : [];
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

// --- internal SVG/icon source (icons are an internal codegen step now) ---------
// The decoded message.json carries vector GEOMETRY (path data) the IR doesn't. With it,
// codegen exports each icon's geometry into an owned, recolorable component and wires the
// IR's (override-aware) colour — no manual export-svg + re-map. Defaults to the IR's own
// source pointer; pass --svg/--message to point at a relocated decode. Absent ⇒ icons fall
// back to the placeholder + export-svg TODO (offline-safe; never hard-fails).
const svgArg = flag("--svg") ?? flag("--message");
const msgPath = svgArg ?? manifest.source?.path;
const svgIndex = msgPath && fs.existsSync(msgPath) ? load(msgPath) : null;
// Mode coherence guard (the single style decision): build-ir + theme-gen must share --mode.
const modeArg = flag("--mode");
if (modeArg && manifest.activeMode && modeArg !== manifest.activeMode)
  console.error(
    `⚠ codegen --mode "${modeArg}" ≠ manifest.activeMode "${manifest.activeMode}" — rebuild IR + theme with the same mode`,
  );

// variable guid → token name, to resolve icon colour overrides read straight from the raw
// message (the IR drops deep-node colour overrides on icons — see iconOverrideColor).
const varNameByGuid = new Map<string, string>();
for (const v of readJSON("tokens/variables.json") ?? [])
  if (v?.guid && v?.name) varNameByGuid.set(v.guid, v.name);

function findNodeByGuid(guid: string): IRNode | null {
  for (const rel of manifest.artifacts?.screens ?? []) {
    const root = readJSON(rel);
    let hit: IRNode | null = null;
    (function w(n: any) {
      if (!n || hit) return;
      if (n.guid === guid) {
        hit = n;
        return;
      }
      for (const c of n.children ?? []) w(c);
    })(root);
    if (hit) return hit;
  }
  return null;
}

// === PROP MODEL — the idiomatic collapse lives in components-lib.mts (pure + unit-tested) ===
// `Logical` + `deriveLogicals` are imported (see the top-of-file import) so the prop-model
// transform is testable in isolation with synthetic ComponentProp fixtures.
const { logicals, logicalByDefKey } = deriveLogicals(comp);

// --- identifiers --------------------------------------------------------------
const Comp = compIdent(comp.name ?? setName);
// Output dir = the IR component's UNIQUE filename slug (build-ir already disambiguated
// same-named sets as <name>, <name>-2, ...). Using slugify(comp.name) instead would make
// two distinct sets sharing a display name (e.g. two "slider"/"Ticket" sets) collide and
// overwrite each other's folder. Fall back to the name slug only if no file matched.
const slug =
  (compFile ? compFile.replace(/\.json$/, "") : slugify(comp.name ?? setName)) || "component";

// --- image-fill asset extraction (--images) -----------------------------------
// Copy a referenced raster fill (by content hash) out of the decoded .fig images dir
// into <out>/<slug>/assets/, so codegen can emit a REAL reference (web backgroundImage /
// rn <Image source>) instead of a placeholder TODO. Memoized; returns the written
// basename (e.g. "<hash>.png") or null when no --images/--out or the asset is absent.
// Extension is sniffed from magic bytes (the fig stores fills extension-less).
const extFromMagic = (b: Buffer): string => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return ".png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return ".webp";
  if (b.length >= 6 && b.toString("ascii", 0, 4) === "GIF8") return ".gif";
  return "";
};
const assetCache = new Map<string, string | null>(); // hash → written basename | null
function assetRef(hash: string | undefined): string | null {
  if (!hash || !imagesDir || !outDir) return null;
  if (assetCache.has(hash)) return assetCache.get(hash)!;
  let src: string | null = null;
  const direct = path.join(imagesDir, hash);
  if (fs.existsSync(direct)) src = direct;
  else if (fs.existsSync(imagesDir)) {
    const f = fs.readdirSync(imagesDir).find((x) => x === hash || x.startsWith(hash + "."));
    if (f) src = path.join(imagesDir, f);
  }
  if (!src) {
    assetCache.set(hash, null);
    return null;
  }
  const buf = fs.readFileSync(src);
  const file = hash + (path.extname(src) || extFromMagic(buf));
  const destDir = path.join(outDir, slug, "assets");
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, file), buf);
  assetCache.set(hash, file);
  return file;
}
const imageHashOf = (n: IRNode): string | undefined => {
  const f = (n.style?.fills ?? []).find((x: any) => x.type === "image" && x.imageHash);
  return f ? ((f as any).imageHash as string) : undefined;
};
function variantComponentName(v: any): string {
  const k = variantPropKey(v);
  const camel = k
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/(?:^|\s)(\w)/g, (_: string, c: string) => c.toUpperCase())
    .replace(/\s/g, "");
  return `${Comp}${camel || "Default"}`;
}
const variantFileSlug = (v: any) => slugify(variantPropKey(v)) || "default";

// the prop expression the dispatcher keys on (single-axis → `variant`; multi-axis →
// composed). Falls back to 'default' when no axes.
const defaultKey = defaultVariant ? variantPropKey(defaultVariant) : "default";
const propKeyExpr =
  axisNames.length === 0
    ? `'${defaultKey}'`
    : axisNames.length === 1
      ? "variant"
      : axisNames.map((a) => kebab(a)).join(" + '/' + ");

// Name of the per-instance ROOT style-override prop for a component. Defaults
// to the idiomatic `style`, but a Figma variant axis can literally be named "Style" (→ a
// `style` variant prop — e.g. Button), which would collide. So fall back to a free name,
// derived from the component's OWN axes + logical props. Both the generated component and
// any PARENT referencing it call this on the same catalog record, so the names agree.
function styleOverridePropName(c: any): string {
  const taken = new Set<string>();
  const axNames = Object.keys(c.axes ?? {});
  if (axNames.length === 1) taken.add("variant");
  else for (const a of axNames) taken.add(kebab(a));
  for (const l of deriveLogicals(c).logicals) taken.add(l.name);
  for (const cand of ["style", "rootStyle", "styleOverride", "rootStyleOverride"])
    if (!taken.has(cand)) return cand;
  return "rootStyleOverride";
}
const STYLE_PROP = styleOverridePropName(comp); // the override-prop name for THIS component

// --- owned icon component extraction (internal SVG export) --------------------
// Geometry comes from svg-lib (the decoded message.json); colour comes from the IR
// (override-aware) via the caller's `color` prop. Icons are DEDUPED by geometry into a
// SHARED <out>/icons/ dir (sibling to each <slug>/), so repeated glyphs converge to one
// file and every variant references it (the RoastSquare pattern).
const iconByKey = new Map<string, { Name: string; file: string; mono: boolean }>();
const iconTakenNames = new Set<string>();
const iconFiles = new Map<string, string>(); // "icons/<Name>.tsx" → file content

// The contextual colour of an icon instance, read from its raw symbolOverrides (fill OR
// stroke paint). resolve-lib drops deep-node colour overrides on icons, so the resolved IR
// carries no fill/stroke on the icon's vectors — we read the raw message directly: a bound
// colorVar → its theme token (var), else the literal hex. null when the instance carries no
// colour override (the icon then renders its currentColor default, inheriting from context).
function iconOverrideColor(guid: string): { hex: string; var: string | null } | null {
  if (!svgIndex) return null;
  const raw = svgIndex.byKey.get(guid);
  for (const o of raw?.symbolData?.symbolOverrides ?? []) {
    for (const paints of [o.fillPaints, o.strokePaints]) {
      const p = (paints ?? []).find(
        (x: any) => x.type === "SOLID" && x.visible !== false && x.color,
      );
      if (!p) continue;
      const ag = p.colorVar?.value?.alias?.guid;
      const vk = ag ? `${ag.sessionID}:${ag.localID}` : null;
      return { hex: colorStr(p.color), var: (vk && varNameByGuid.get(vk)) || null };
    }
  }
  return null;
}

// PascalCase glyph name from a node/instance name ("icons/Tabbar/HouseSimple" → "HouseSimple").
function iconExportName(n: { name?: string | null }): string {
  const raw = (n.name ?? "").split("/").pop() ?? "";
  return raw
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/(?:^|\s)(\w)/g, (_: string, c: string) => c.toUpperCase())
    .replace(/\s/g, "");
}

// Extract geometry for a node and generate (or reuse) an owned icon component. Returns its
// identifier + import file + mono flag, or null (caller keeps the placeholder). monoHint:
// true/false from the IR's resolved fills; undefined ⇒ decide from the extracted geometry.
function ownIcon(
  n: { guid: string; name?: string | null },
  monoHint?: boolean,
): { Name: string; file: string; mono: boolean } | null {
  if (!svgIndex || !outDir) return null;
  let geo;
  try {
    geo = extractGeometry(svgIndex, n.guid);
  } catch {
    return null;
  }
  if (!geo.paths.length) return null;
  const mono = monoHint != null ? monoHint : geo.fills.length === 1;
  // mono recolours via the caller's `color` prop ⇒ dedup on shape only; multi bakes its fills.
  const dedupKey = mono ? geo.geomHash : `${geo.geomHash}#${geo.fills.join(",")}`;
  const hit = iconByKey.get(dedupKey);
  if (hit) return hit;
  // CONTENT-ADDRESSED name (fix): the Figma node name is generic ("Vector" for every
  // Phosphor glyph), and codegen is invoked once-per-set into a SHARED icons/ dir, so a
  // per-invocation counter ("VectorIcon","VectorIcon2"...) makes different glyphs from
  // different sets collide on the same filename and clobber each other. Folding the
  // geometry hash into the name makes it stable+unique per geometry across invocations:
  // same glyph → same file (idempotent), different glyph → different file (no clobber).
  let stem = iconExportName(n) || "Glyph";
  // A glyph named e.g. "941" (the iOS 9:41 time) yields an invalid identifier start; prefix it.
  if (!/^[A-Za-z_]/.test(stem)) stem = "Glyph" + stem;
  const base = `${stem}_${geo.geomHash.slice(0, 8)}Icon`;
  let Name = base,
    i = 2;
  while (iconTakenNames.has(Name)) Name = `${base}${i++}`;
  iconTakenNames.add(Name);
  const rec = { Name, file: Name, mono };
  iconByKey.set(dedupKey, rec);
  iconFiles.set(`icons/${Name}.tsx`, emitIconComponent(Name, geo, { web, mono }));
  return rec;
}

// === per-node JSX rendering (a variant's resolved subtree → a JSX tree) =========
const allTodos: string[] = [];
const ind = (s: string, n: number) =>
  s
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

// safe style-key (one StyleSheet entry / style object per node, by IR id).
const styleKey = (n: IRNode) => `n_${(n.id || n.guid || "x").replace(/[^A-Za-z0-9]+/g, "_")}`;

// color expression with token provenance; pushes a TODO on match:none/nearest.
function colorRef(
  c:
    | { hex: string | null; var?: string | null; token?: string | null; match?: string | null }
    | undefined,
  label: string,
  push: (m: string) => void,
): string {
  if (!c || !c.hex) return "'transparent'";
  // Bound to a Figma variable → reference the generated theme, not the literal.
  if (c.var) return themeRef(c.var, false);
  if (c.token) return c.token;
  if (c.match === "none" || (typeof c.match === "string" && c.match.startsWith("nearest"))) {
    push(
      `${label} color ${c.hex} is "${c.match}" against the theme — review the literal during elevation (kept faithfully)`,
    );
    return `'${c.hex}' /* REVIEW: ${c.match} token */`;
  }
  return `'${c.hex}'`;
}

// Collect every DISTINCT solid fill {hex, var} across a vector subtree — the vector-branch
// node itself PLUS its descendants. Icon wrappers (instance/frame) carry empty fills on the
// branch node; the real colour lives on descendant <vector> nodes, so we must recurse, not
// just read n.style.fills. Order-preserved, deduped by hex|var.
function collectVectorFills(n: IRNode): { hex: string; var: string | null }[] {
  const out: { hex: string; var: string | null }[] = [];
  const seen = new Set<string>();
  (function walk(m: IRNode) {
    for (const f of m.style?.fills ?? []) {
      if (f.type === "solid" && f.hex) {
        const v = (f as any).var ?? null;
        const k = `${f.hex}|${v ?? ""}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ hex: f.hex, var: v });
        }
      }
    }
    for (const c of m.children ?? []) walk(c);
  })(n);
  return out;
}

// One node's style object body (container/box fields). web|rn share most fields.
// `only` (optional) restricts emission to the listed override field names (a subset
// of FIELD_KEYS): codegen passes it to build a per-instance ROOT style OVERRIDE for a
// referenced child component, so only the genuinely-overridden box fields are emitted
// (no layout/flex-child lines, which aren't override-able). Omitted ⇒ full body.
function nodeStyleBody(n: IRNode, push: (m: string) => void, only?: Set<string>): string {
  const lines: string[] = [];
  const s = n.style;
  const want = (f: string) => !only || only.has(f);
  // size: emit when fixed (a hug/grow child sizes itself; still record for faithful sizing).
  if (want("size") && n.box) {
    if (n.box.w) lines.push(`width: ${n.box.w},`);
    if (n.box.h) lines.push(`height: ${n.box.h},`);
  }
  // background = first solid fill (bound var wins as a token comment).
  if (want("fillPaints")) {
    const fill = s?.fills?.find((f) => f.type === "solid" && f.hex);
    if (fill) {
      const ref = colorRef(
        {
          hex: fill.hex ?? null,
          var: (fill as any).var ?? null,
          match: (fill as any).var ? "bound" : null,
        },
        `${n.name} background`,
        push,
      );
      lines.push(`${web ? "background" : "backgroundColor"}: ${ref},`);
    }
    // image fill: with --images, EXTRACT the raster fill into
    // assets/ and emit a real backgroundImage reference; without it, leave a placeholder
    // TODO. Emitted AFTER the solid fill so a node with both keeps its solid bg too.
    // WEB only here — rn can't hold an image in a View style, so emit() renders an <Image>
    // (handled there). Skipped in override mode (`only`): an image override is flagged by
    // the caller's instance-override TODO, not inlined into a `style={{…}}` prop.
    const imgFill =
      !only && web && s?.fills?.find((f) => f.type === "image" && (f as any).imageHash);
    if (imgFill) {
      const hash = (imgFill as any).imageHash as string;
      const file = assetRef(hash);
      if (file) {
        lines.push(`backgroundImage: "url('./assets/${file}')",`);
        lines.push(`backgroundSize: 'cover',`);
        lines.push(`backgroundPosition: 'center',`);
        lines.push(`backgroundRepeat: 'no-repeat',`);
      } else {
        push(
          `image fill "${n.name}" (${n.guid}) hash ${hash.slice(0, 8)}… — pass --images <dir> to extract + wire the src`,
        );
        // No opaque placeholder bg: image-only fills are often transparent PNGs meant to
        // composite over the parent surface (an opaque #eee would show through their alpha).
        lines.push(
          `// TODO: image — backgroundImage: "url('./assets/${hash.slice(0, 16)}…')" (re-run codegen with --images)`,
        );
        lines.push(`backgroundSize: 'cover',`);
      }
    }
  }
  if (want("cornerRadius") && s?.cornerRadius !== undefined) {
    if (typeof s.cornerRadius === "number") lines.push(`borderRadius: ${s.cornerRadius},`);
    else {
      lines.push(`borderTopLeftRadius: ${s.cornerRadius.tl},`);
      lines.push(`borderTopRightRadius: ${s.cornerRadius.tr},`);
      lines.push(`borderBottomRightRadius: ${s.cornerRadius.br},`);
      lines.push(`borderBottomLeftRadius: ${s.cornerRadius.bl},`);
    }
  }
  // strokes + per-side widths.
  if ((want("strokePaints") || want("strokeWeight")) && s?.strokes?.length) {
    const st = s.strokes[0];
    // route through colorRef so a bound stroke references the theme, same as fills.
    const cref = colorRef(
      {
        hex: st.hex ?? null,
        var: (st as any).var ?? null,
        match: (st as any).var ? "bound" : null,
      },
      `${n.name} border`,
      push,
    );
    const lineStyle = st.dash?.length ? "dashed" : "solid";
    if (s.borderWidths) {
      const bw = s.borderWidths;
      if (bw.top) lines.push(`borderTopWidth: ${bw.top},`);
      if (bw.right) lines.push(`borderRightWidth: ${bw.right},`);
      if (bw.bottom) lines.push(`borderBottomWidth: ${bw.bottom},`);
      if (bw.left) lines.push(`borderLeftWidth: ${bw.left},`);
      lines.push(`borderColor: ${cref}, // align ${st.align}`);
      if (web) lines.push(`borderStyle: '${lineStyle}',`);
      else if (st.dash?.length) lines.push(`borderStyle: 'dashed',`);
    } else {
      lines.push(`borderWidth: ${st.weight},`);
      lines.push(`borderColor: ${cref}, // align ${st.align}`);
      if (web) lines.push(`borderStyle: '${lineStyle}',`);
      else if (st.dash?.length) lines.push(`borderStyle: 'dashed',`);
    }
  }
  if (want("opacity") && s?.opacity !== undefined) lines.push(`opacity: ${s.opacity},`);
  if (want("effects") && s?.effects?.length) {
    const e = s.effects[0];
    if (web)
      lines.push(
        `boxShadow: '${e.offsetX}px ${e.offsetY}px ${e.radius}px ${e.spread ?? 0}px ${e.hex ?? "#000"}', // ${e.type}${s.effects.length > 1 ? ` (+${s.effects.length - 1} more — see master)` : ""}`,
      );
    else {
      lines.push(`shadowColor: '${e.hex ?? "#000"}', // ${e.type}`);
      lines.push(`shadowOffset: { width: ${e.offsetX}, height: ${e.offsetY} },`);
      lines.push(`shadowRadius: ${e.radius},`);
      if (s.effects.length > 1)
        lines.push(`// +${s.effects.length - 1} more effect(s) — see master`);
    }
  }
  // auto-layout container + flex-child sizing: structural, never a per-instance style
  // override — emitted in full mode only (skipped when building a root override body).
  if (!only) {
    const l = n.layout;
    if (l) {
      lines.push(`display: 'flex',`);
      lines.push(`flexDirection: '${l.mode}',`);
      if (l.gap !== undefined) lines.push(`gap: ${l.gap},`);
      // SPACE_EVENLY→SPACE_BETWEEN disambiguation: the helper filters
      // absolute/invisible children and requires >=2 in-flow.
      const j = disambiguateJustify(l, n.box, n.children ?? []);
      if (j) lines.push(`justifyContent: '${j}',`);
      if (l.align) lines.push(`alignItems: '${l.align}',`);
      if (l.paddingTop !== undefined) lines.push(`paddingTop: ${l.paddingTop},`);
      if (l.paddingRight !== undefined) lines.push(`paddingRight: ${l.paddingRight},`);
      if (l.paddingBottom !== undefined) lines.push(`paddingBottom: ${l.paddingBottom},`);
      if (l.paddingLeft !== undefined) lines.push(`paddingLeft: ${l.paddingLeft},`);
      if (l.wrap) lines.push(`flexWrap: 'wrap',`);
    }
    // node as a flex child.
    lines.push(...flexChildLines(n));
  }
  return lines.join("\n");
}

// Build the per-instance ROOT style-override object body for a nested-component
// reference: only the box fields the instance actually overrode on its root (a subset
// of STYLE_OVERRIDE_FIELDS), flattened to a single inline-object body. Returns "" when
// nothing maps. Shares nodeStyleBody's field→CSS mapping so parent and child agree.
const STYLE_OVERRIDE_FIELDS = new Set([
  "fillPaints",
  "strokePaints",
  "strokeWeight",
  "cornerRadius",
  "opacity",
  "size",
  "effects",
]);
function rootOverrideStyle(n: IRNode, fields: string[], push: (m: string) => void): string {
  const sel = fields.filter((f) => STYLE_OVERRIDE_FIELDS.has(f));
  if (!sel.length) return "";
  // Strip trailing `// …` line comments (token/align annotations nodeStyleBody appends)
  // before flattening to one line — otherwise a `//` would comment out the rest of the
  // inline object literal, including its closing `}}`. Block `/* … */` comments are safe.
  return nodeStyleBody(n, push, new Set(sel))
    .split("\n")
    .map((l) => l.replace(/\s*\/\/.*$/, "").trim())
    .filter(Boolean)
    .join(" ");
}

// A node's sizing AS A FLEX CHILD: grow/alignSelf/min/aspect. Shared
// by nodeStyleBody (frames) and textStyleBody (text) — both flex parents size children
// for text too, so text nodes need the same grow/alignSelf/minW/minH.
function flexChildLines(n: IRNode): string[] {
  const lines: string[] = [];
  if (n.grow) lines.push(`flexGrow: ${n.grow},`);
  if (n.alignSelf) lines.push(`alignSelf: '${n.alignSelf}',`);
  if (n.minW) lines.push(`minWidth: ${n.minW},`);
  if (n.minH) lines.push(`minHeight: ${n.minH},`);
  if (n.aspectRatio) lines.push(`aspectRatio: ${n.aspectRatio},`);
  return lines;
}

// Figma fontName.style (the weight-axis name) → the CSS/RN numeric fontWeight string
// ('100'–'900'), valid for both React CSSProperties and React Native TextStyle. A
// trailing italic/oblique qualifier is stripped (it belongs on fontStyle, not weight).
// Returns null for an unrecognized name (caller leaves a TODO instead of guessing).
function fontWeightValue(style: string | null): string | null {
  if (!style) return null;
  const w = style
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/(italic|oblique)$/, "");
  const map: Record<string, string> = {
    thin: "100",
    hairline: "100",
    extralight: "200",
    ultralight: "200",
    light: "300",
    "": "400",
    regular: "400",
    normal: "400",
    book: "400",
    medium: "500",
    semibold: "600",
    demibold: "600",
    bold: "700",
    extrabold: "800",
    ultrabold: "800",
    black: "900",
    heavy: "900",
  };
  return map[w] ?? null;
}

// One TEXT node's typography style body, pushing TODOs for unmapped font / conflicts.
function textStyleBody(n: IRNode, push: (m: string) => void): string {
  const lines: string[] = [];
  const f = n.font;
  if (f) {
    // Each typography property carries its own Figma variable (font.vars: the design
    // token it binds to) — annotate every value with `// var <name>`, mirroring the
    // color token comment, so a real implementation references variables not literals.
    // The applied text style name heads the block (the whole-style token).
    const v = f.vars;
    const varc = (name: string | null | undefined) => (name ? ` // var ${name}` : "");
    if (f.styleName) lines.push(`// token text-style: ${f.styleName}`);
    // A bound numeric/string typography property references the theme;
    // unbound keeps the reconciled literal. lineHeight: web wants a
    // string '36px' (React treats a unitless number as a multiplier), RN a bare number.
    if (f.size != null)
      lines.push(
        v?.size
          ? `fontSize: ${themeRef(v.size, true)},`
          : `fontSize: ${f.size},${f.sizeToken ? ` // token ${f.sizeToken}` : ""}`,
      );
    if (f.lineHeightPx != null)
      lines.push(
        v?.lineHeight
          ? `lineHeight: ${themeRef(v.lineHeight, true)},`
          : `lineHeight: ${web ? `'${f.lineHeightPx}px'` : f.lineHeightPx},`,
      );
    if (f.letterSpacingPx || v?.letterSpacing)
      lines.push(
        v?.letterSpacing
          ? `letterSpacing: ${themeRef(v.letterSpacing, true)},`
          : `letterSpacing: ${f.letterSpacingPx},`,
      );
    // Emit the font family straight from Figma. decisions.fontMap (appFamily) is an
    // OPTIONAL override for when the app registers the face under a different name — it
    // must never block generation, so the raw Figma family is the default. A bound
    // family references the theme string token.
    const famName = f.appFamily ?? f.family;
    if (v?.family) lines.push(`fontFamily: ${themeRef(v.family, false)},`);
    else if (famName) lines.push(`fontFamily: '${famName}',`);
    const fw = fontWeightValue(f.weight);
    if (fw)
      lines.push(
        `fontWeight: '${fw}',${v?.weight ? ` // var ${v.weight}` : f.weight ? ` // ${f.weight}` : ""}`,
      );
    else if (f.weight) {
      lines.push(
        `// TODO: fontWeight — unmapped Figma weight "${f.weight}"${v?.weight ? ` (var ${v.weight})` : ""}`,
      );
      push(`font weight "${f.weight}" unmapped — extend fontWeightValue()`);
    }
    for (const cf of f.conflicts ?? [])
      push(
        `font ${cf.field} ${cf.declared}→~${cf.chosen} reconciliation conflict (box.y=${cf.boxY} vs lh=${cf.lhPx}) — confirm size`,
      );
  }
  const cref = colorRef(n.color as any, `${n.name} text`, push);
  lines.push(`color: ${cref},`);
  if (n.text?.case) lines.push(`textTransform: '${n.text.case}',`);
  if (n.text?.align) lines.push(`textAlign: '${n.text.align}',`);
  // text node as a flex child: same grow/alignSelf/minW/minH as frames.
  lines.push(...flexChildLines(n));
  return lines.join("\n");
}

// An icon: a node whose rendered content is purely vector geometry (no text/image).
// Codegen can't draw vector paths — these export via export-svg.mts — so an icon
// renders as ONE sized placeholder + a TODO, never a tree of empty/recolored boxes.
function isVectorOnly(n: IRNode): boolean {
  if (n.type === "vector" || n.type === "boolean_operation") return true;
  if (n.type === "text" || n.type === "image") return false;
  const kids = (n.children ?? []).filter((c) => (c as any).visible !== false);
  return kids.length > 0 && kids.every(isVectorOnly);
}

// A COMPOSITE GLYPH: a frame/group whose whole subtree is RAW vector geometry — no
// instances, text or images. Such a node is ONE drawing split across several vector
// nodes (a stroke arrow = shaft + head; a multi-letter logo), so it must be extracted as
// ONE composed SVG (export-svg style), not one sub-icon per child. The instance exclusion
// is the key difference from isVectorOnly: an instance child means a SLOT/nested component
// (e.g. a square button wrapping a swappable icon) — that's a CONTAINER, not a glyph, and
// must keep its background + slot rather than being flattened into a single icon.
function isCompositeVectorGlyph(n: IRNode): boolean {
  if (n.type === "vector" || n.type === "boolean_operation") return true;
  if (n.type === "instance" || n.type === "text" || n.type === "image") return false;
  const kids = (n.children ?? []).filter((c) => (c as any).visible !== false);
  return kids.length > 0 && kids.every(isCompositeVectorGlyph);
}

// A single-icon WRAPPER: an instance/frame whose only visible child is itself a pure
// vector subtree. These keep #4 flex-centering and must NOT switch to absolute (#6/#7).
function isSingleIconWrapper(n: IRNode): boolean {
  if (n.type !== "instance" && n.type !== "frame") return false;
  const kids = (n.children ?? []).filter((c) => (c as any).visible !== false);
  return kids.length === 1 && isVectorOnly(kids[0]);
}

// `overlap()` / `hasSignificantNonAdjacentOverlap()` live in layout-lib.mts (pure +
// unit-tested). Strict bbox intersection: touching edges (==) do NOT count.

// Does THIS container position its children absolutely?
//   #7: a non-auto-layout container (no layout) positions children absolutely.
//   #6: an auto-layout container positions children abs when a child is stack-absolute.
//   #11: an auto-layout container with an authored peek-stack (a significant NON-ADJACENT
//        overlap among children) positions them absolutely too — flex flow can't author
//        that, so the stored bboxes are intentional placement, not frozen snapshots.
// A single-icon wrapper keeps flex-centering (#4) — never positions absolutely.
function containerPositionsChildren(n: IRNode, kids: IRNode[]): boolean {
  if (!kids.length) return false;
  if (isSingleIconWrapper(n)) return false;
  if (!n.layout) return true; // #7
  if (kids.some((c) => c.positioning === "absolute")) return true; // #6
  return hasSignificantNonAdjacentOverlap(
    kids.map((c) => ({ x: c.box?.x ?? 0, y: c.box?.y ?? 0, w: c.box?.w ?? 0, h: c.box?.h ?? 0 })),
  ); // #11
}

// Interactive-archetype MARKER: a string TODO (no prop synthesis).
function interactiveArchetype(n: IRNode): string | null {
  const kids = (n.children ?? []).filter((c) => (c as any).visible !== false);
  const named = (re: RegExp) => kids.some((c) => re.test(c.name ?? ""));
  const slider =
    /slider|track/i.test(n.name ?? "") || (named(/bar|track/i) && named(/thumb|fill|blue/i));
  if (slider) return "slider — fill width is static; wire value/onChange";
  const stepper =
    /stepper|quantity/i.test(n.name ?? "") || (named(/minus|^-$/) && named(/plus|^\+$/));
  if (stepper) return "stepper — count is static; wire value/onChange";
  return null;
}

// Render a nested-component REFERENCE for an instance node that resolves to another
// catalog component (`entry`). Emits `<Comp variantAttrs propAttrs />`, mapping the
// instance's RESOLVED values onto the referenced component's props (text/visibility)
// via deriveLogicals (so the prop model matches that component's own generated Props),
// records the import, and FLAGS any per-instance overrides it can't express as props
// so nothing is silently dropped. Gated by the caller on `!isVectorOnly` (icons stay
// on the export-svg path) and a self-reference guard.
function componentReference(
  n: IRNode,
  entry: RegEntry,
  pad: string,
  push: (m: string) => void,
  refImports: Map<string, string>,
  posLines: string[],
): string {
  refImports.set(entry.Comp, entry.slug);

  // variant-selecting attrs — mirrors the meta component's Props (single-axis →
  // `variant`; multi-axis → one kebab-named prop per axis). Values use the SAME
  // mapValue() the union type is built from (parity with components-lib).
  const rax: Record<string, string[]> = entry.comp.axes ?? {};
  const axNames = Object.keys(rax);
  const vprops: Record<string, string> = entry.variant?.props ?? {};
  let attrs = "";
  if (entry.variant && axNames.length === 1) {
    attrs += ` variant="${mapValue(String(vprops[axNames[0]] ?? ""))}"`;
  } else if (entry.variant && axNames.length > 1) {
    for (const a of axNames) attrs += ` ${kebab(a)}="${mapValue(String(vprops[a] ?? ""))}"`;
  }

  // guid → resolved IR node for the instance subtree. Invisible nodes were dropped in
  // toIR, so a visible-bound node being ABSENT means the override hid it.
  const byGuid = new Map<string, IRNode>();
  (function w(node: IRNode) {
    if (!byGuid.has(node.guid)) byGuid.set(node.guid, node);
    for (const c of node.children ?? []) w(c);
  })(n);

  const { logicalByDefKey } = deriveLogicals(entry.comp);
  const propByDefKey = new Map<string, any>();
  for (const p of entry.comp.props ?? []) propByDefKey.set(p.defKey, p);

  const emitted = new Set<string>(); // logical names already set (collapse de-dupe)
  for (const b of (entry.variant?.bindings ?? []) as any[]) {
    const lg = logicalByDefKey.get(b.defKey);
    if (!lg || emitted.has(lg.name)) continue;
    if (lg.role === "text" && b.field === "characters") {
      // collapsed (bool⊕text) → hidden unless a string is passed, so emit whenever the
      // node is shown. standalone → emit only when it differs from the master default.
      const conditional = lg.figNames.length > 1;
      const target = byGuid.get(b.node);
      if (target?.text) {
        const val = target.text.value ?? "";
        if (conditional || val !== (lg.defText ?? "")) {
          attrs += ` ${lg.name}={${JSON.stringify(val)}}`;
          emitted.add(lg.name);
        }
      }
    } else if (lg.role === "bool" && b.field === "visible") {
      // standalone visibility toggle: pass only when the resolved state differs from the
      // prop default (absent ⇒ the child's IR default — codegen now defaults the bool in the
      // child's destructure — so omitting the prop reproduces the master).
      const def = propByDefKey.get(b.defKey)?.default;
      const shown = byGuid.has(b.node);
      if (typeof def === "boolean" && shown !== def) {
        attrs += shown ? ` ${lg.name}` : ` ${lg.name}={false}`;
        emitted.add(lg.name);
      }
    } else if (lg.role === "slot" && b.field === "symbolId") {
      push(
        `reference <${entry.Comp}/>: instance-swap prop "${lg.name}" not auto-wired — pass the swapped content (${n.guid})`,
      );
    }
  }

  // ROOT style override (regression fix): the instance subtree was
  // inlined, so per-instance ROOT box overrides (fill/radius/border/opacity/size/effects)
  // rendered. Referencing dropped them — the child drew its MASTER styles. Re-apply them
  // here as a `style` prop the referenced child merges onto its root (root-container scope;
  // deeper-node overrides stay flagged below). The override fields come straight from the
  // IR (resolve-lib's overrideApplied, surfaced as n.override.fields).
  const styleFields = (n.override?.fields ?? []).filter((f) => STYLE_OVERRIDE_FIELDS.has(f));
  const overrideBody = styleFields.length ? rootOverrideStyle(n, styleFields, push) : "";
  // ABSOLUTE PLACEMENT (regression fix for the nested-component reference path): when the
  // parent positions this child absolutely (stack-absolute, parent-positions-children, or
  // overlap escalation), the position/left/top/zIndex prefix MUST ride along — a reference
  // has no JSX box of its own to carry it,
  // so it flows into the parent and the overlap/peek layout collapses to a flat row. Merge it
  // into the same root style-override prop the child already merges, so the
  // referenced component's root applies it. posLines wins over master styles (later in merge).
  // Inlined to ONE line: this body lands inside a JSX attr AND inside a `//` TODO message, so
  // an embedded newline would break out of the comment / split the attribute.
  const inlineBody = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
  const mergedBody = [posLines.join(" "), overrideBody].filter(Boolean).map(inlineBody).join(" ");
  if (mergedBody) attrs += ` ${styleOverridePropName(entry.comp)}={{ ${mergedBody} }}`;

  const overrides = n.component?.overrides ?? 0;
  if (overrides) {
    const passed = [...emitted, ...(overrideBody ? [`style[${styleFields.join(",")}]`] : [])];
    push(
      `referenced <${entry.Comp}${attrs}/> for "${n.name}" (${n.guid}) — ${overrides} instance override(s)` +
        `${passed.length ? `, passed [${passed.join(", ")}]` : ""}; confirm remaining overrides (image/icon/deep-node) are handled`,
    );
  }
  return `${pad}<${entry.Comp}${attrs} />`;
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
  refImports: Map<string, string>; // referenced child component: Comp identifier → file slug
  iconImports: Map<string, string>; // owned icon component: identifier → file (in ../icons)
  usesStyleProp: boolean; // root merges the `style` override prop → destructure it
  rnImageUsed: boolean; // an rn <Image> was emitted → import it
  todos: string[];
};

// Per-node context threaded from emit() into the per-case render helpers below — the
// values emit() computes once at the top of each node (everything else they need is
// closed over from renderVariant's scope).
type NodeCtx = {
  n: IRNode;
  depth: number;
  binds:
    | {
        text?: Extract<Logical, { role: "text" }>;
        bool?: Logical;
        slot?: Extract<Logical, { role: "slot" }>;
      }
    | undefined;
  pad: string;
  sk: string;
  styleAttr: string;
  prefixBody: (body: string) => string;
  kidsAll: IRNode[];
};

function renderVariant(v: any): VariantRender {
  const propKey = variantPropKey(v);
  const todos: string[] = [];
  const push = (m: string) => todos.push(`[${propKey}] ${m}`);
  const styles: { key: string; body: string }[] = [];
  const usedProps = new Set<string>();
  const refImports = new Map<string, string>(); // nested child components referenced here
  const iconImports = new Map<string, string>(); // owned icons referenced here (../icons/<file>)
  let usesStyleProp = false; // set when the root node merges the `style` override prop
  let rnImageUsed = false; // set when an rn <Image> is emitted for an extracted fill

  // node guid → logical prop, via THIS variant's bindings (defKey-joined). A node may
  // carry a text binding, a visibility binding, an instance-swap binding, or several.
  const bindingsOf = new Map<
    string,
    {
      text?: Extract<Logical, { role: "text" }>;
      bool?: Logical;
      slot?: Extract<Logical, { role: "slot" }>;
    }
  >();
  for (const b of (v.bindings ?? []) as any[]) {
    const lg = logicalByDefKey.get(b.defKey);
    if (!lg) continue;
    const slot = bindingsOf.get(b.node) ?? {};
    if (b.field === "characters" && lg.role === "text") slot.text = lg;
    else if (b.field === "visible")
      slot.bool = lg; // may be a collapsed text logical
    else if (b.field === "symbolId" && lg.role === "slot") slot.slot = lg;
    bindingsOf.set(b.node, slot);
  }

  const subtree = findNodeByGuid(v.guidKey);
  if (!subtree) {
    push(`variant subtree not found by guid ${v.guidKey} — emitting an empty shell`);
    return {
      v,
      propKey,
      compName: variantComponentName(v),
      fileSlug: variantFileSlug(v),
      jsx: web ? "<div />" : "<View />",
      styles,
      usedProps,
      refImports,
      iconImports,
      usesStyleProp,
      rnImageUsed,
      todos,
    };
  }

  const Box = web ? "div" : "View";
  const Txt = web ? "span" : "Text";

  // Compute the position/left/top/zIndex prefix for ONE node. A
  // node is absolutely placed when it's stack-absolute, the parent positions all its
  // children, or an overlap-group escalation (absOverride) forced it. We prepend these
  // lines to the node's style body (emit holds the parent flag + the overlap decision).
  function positionPrefix(
    n: IRNode,
    parentPositionsChildren: boolean,
    absOverride: boolean,
    zIndex: number | undefined,
    kids: IRNode[],
  ): string[] {
    const placedAbs = n.positioning === "absolute" || parentPositionsChildren || absOverride;
    const lines: string[] = [];
    if (placedAbs) {
      lines.push(`position: 'absolute',`);
      lines.push(`left: ${n.box?.x ?? 0},`);
      lines.push(`top: ${n.box?.y ?? 0},`);
    } else if (
      containerPositionsChildren(n, kids) ||
      kids.some((c) => c.positioning === "absolute")
    ) {
      // a container that positions descendants establishes a containing block — but
      // 'absolute' already does that, so suppress 'relative' when itself abs-placed.
      lines.push(`position: 'relative',`);
    }
    if (zIndex !== undefined) lines.push(`zIndex: ${zIndex},`);
    return lines;
  }

  // Recurse into a node's visible children, computing per-child absolute/zIndex
  // decisions. Returns the joined JSX of the children.
  function emitChildren(n: IRNode, kids: IRNode[], depth: number): string {
    const positionsKids = containerPositionsChildren(n, kids);
    // #9 z-index: detect a positioned child overlapping a sibling (strict). If any
    // overlap exists in the set, escalate the WHOLE overlapping set to absolute and
    // emit zIndex by child-array order (later children paint on top → Figma order).
    // GATE: only run this for children ALREADY out of flow. An
    // auto-layout (flex) row places children by flexbox, so their stored bboxes are
    // frozen snapshots — a sub-pixel bbox touch there is not a real z-overlap and must
    // never pull a flex child absolute. positionsKids is true only for a non-auto-layout
    // container, one with an explicitly-absolute child, or an authored peek-stack (#11:
    // significant NON-ADJACENT overlap, which flex flow cannot produce); positionPrefix
    // establishes the containing block on exactly that condition, so any escalation here
    // also gets a `position:relative` parent for free.
    const overlapping = new Set<IRNode>();
    if (positionsKids) {
      const boxOf = (c: IRNode) => ({
        x: c.box?.x ?? 0,
        y: c.box?.y ?? 0,
        w: c.box?.w ?? 0,
        h: c.box?.h ?? 0,
      });
      for (let i = 0; i < kids.length; i++)
        for (let j = i + 1; j < kids.length; j++)
          if (overlap(boxOf(kids[i]), boxOf(kids[j]))) {
            overlapping.add(kids[i]);
            overlapping.add(kids[j]);
          }
    }
    const childIndex = new Map<IRNode, number>();
    (n.children ?? []).forEach((c, i) => childIndex.set(c, i));
    return kids
      .map((c) => {
        const inGroup = overlapping.has(c);
        const absOverride = inGroup; // force abs for the whole overlapping set
        const zIndex = inGroup ? childIndex.get(c) : undefined;
        return emit(c, depth + 1, positionsKids, absOverride, zIndex);
      })
      .join("\n");
  }

  function emit(
    n: IRNode,
    depth: number,
    parentPositionsChildren: boolean,
    absOverride = false,
    zIndex: number | undefined = undefined,
  ): string {
    const pad = "  ".repeat(depth);
    const sk = styleKey(n);
    const binds = bindingsOf.get(n.guid);
    // The ROOT node (depth 0) merges the incoming `style` override prop on top of its
    // own style, so a parent referencing this component can re-apply per-instance root
    // overrides. Non-root nodes keep their plain style object.
    const isRoot = depth === 0;
    if (isRoot) usesStyleProp = true;
    const styleAttr = isRoot
      ? web
        ? `style={{ ...styles.${sk}, ...${STYLE_PROP} }}`
        : `style={[styles.${sk}, ${STYLE_PROP}]}`
      : `style={styles.${sk}}`;
    const kidsAll = (n.children ?? []).filter((c) => (c as any).visible !== false);
    const posLines = positionPrefix(n, parentPositionsChildren, absOverride, zIndex, kidsAll);
    const prefixBody = (body: string) =>
      posLines.length ? posLines.join("\n") + (body ? "\n" + body : "") : body;

    // TEXT node → <Text>/<span>. Bound text → prop (fallback to default), else literal.
    if (n.type === "text") {
      styles.push({ key: sk, body: prefixBody(textStyleBody(n, push)) });
      const raw = n.text?.value ?? "";
      if (n.text?.placeholder)
        push(
          `text ${JSON.stringify(raw)} on "${n.name}" is a placeholder (${n.text.reason}) — confirm real copy`,
        );
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
    if (binds?.slot)
      return emitSlotNode({ n, depth, binds, pad, sk, styleAttr, prefixBody, kidsAll });

    // NESTED COMPONENT → reference it as a child component instead of inlining the
    // resolved subtree (the design uses it AS a component). Gated on !isVectorOnly so
    // vector icons keep the export-svg path; self-references fall through to inline.
    const refEntry =
      n.type === "instance" && n.component?.guid ? registry.get(n.component.guid) : undefined;
    if (refEntry && refEntry.slug !== slug && !isVectorOnly(n)) {
      const el = componentReference(n, refEntry, pad, push, refImports, posLines);
      return wrapConditional(el, binds, depth, n);
    }

    // vector art / an icon instance (subtree is purely vectors) → ONE sized
    // placeholder + an export-svg TODO, NOT a tree of meaningless empty/recolored
    // boxes (codegen can't draw vector paths; export-svg.mts does). The placeholder
    // box flex-centers so the inlined <svg>/<Image> ends up centered.
    // Extract the WHOLE subtree as ONE composed icon (the export-svg approach) when it is a
    // composite GLYPH (raw vectors only — e.g. a stroke arrow = shaft + head, or a multi-letter
    // logo) OR a vector-only icon INSTANCE. NOT one sub-icon per child: the previous per-vector
    // split left the pieces mis-positioned by their wrappers. A frame with an instance/slot
    // child is a container (keeps its bg + slot), so it is deliberately excluded here.
    if (isCompositeVectorGlyph(n) || (n.type === "instance" && isVectorOnly(n)))
      return emitVectorGlyph({ n, depth, binds, pad, sk, styleAttr, prefixBody, kidsAll });

    // container / leaf box. Recurse into children.
    styles.push({ key: sk, body: prefixBody(nodeStyleBody(n, push)) });
    const kids = kidsAll;
    // interactive-archetype MARKER: a TODO in the variant block.
    const arch = interactiveArchetype(n);
    if (arch) push(`interactive: ${arch}`);
    let inner = emitChildren(n, kids, depth);
    // a leaf box that has neither children nor binding: still emit (geometry/style).
    if (n.type === "instance" && !kids.length) {
      // an instance with no resolved children → leave a TODO (icon master placeholder).
      push(`instance "${n.name}" (${n.guid}) has no resolved children — confirm the icon master`);
      inner = `${"  ".repeat(depth + 1)}{/* TODO: instance "${n.name}" — confirm icon master (${n.guid}) */}`;
    }
    // rn: a View style can't hold a background image, so render an absolute-fill <Image>
    // BEHIND the children (web set backgroundImage in the style above). Needs --images to
    // extract the asset; without it, flag the node so nothing is silently dropped.
    if (!web) {
      const ih = imageHashOf(n);
      if (ih) {
        const file = assetRef(ih);
        if (file) {
          rnImageUsed = true;
          const ik = `${sk}__img`;
          styles.push({
            key: ik,
            body: "position: 'absolute',\ntop: 0,\nleft: 0,\nright: 0,\nbottom: 0,",
          });
          const imgEl = `${"  ".repeat(depth + 1)}<Image source={require('./assets/${file}')} style={styles.${ik}} resizeMode="cover" />`;
          inner = inner ? `${imgEl}\n${inner}` : imgEl;
        } else {
          push(
            `image fill "${n.name}" (${n.guid}) hash ${ih.slice(0, 8)}… — pass --images <dir> to extract + render <Image>`,
          );
        }
      }
    }
    const el = inner
      ? `${pad}<${Box} ${styleAttr}>\n${inner}\n${pad}</${Box}>`
      : `${pad}<${Box} ${styleAttr} />`;
    return wrapConditional(el, binds, depth, n);
  }

  // a BOOL-visible binding (incl. a collapsed text logical) makes the node conditional.
  function wrapConditional(
    el: string,
    binds: { text?: Logical; bool?: Logical; slot?: Logical } | undefined,
    depth: number,
    n: IRNode,
  ): string {
    const cond = binds?.bool;
    if (!cond) return el;
    usedProps.add(cond.name);
    const pad = "  ".repeat(depth);
    // collapsed text logical → render when the string is provided (present → show).
    const test =
      cond.role === "text" ? `${cond.name} != null` : cond.name === undefined ? "true" : cond.name;
    const body = el.replace(new RegExp(`^${pad}`), "");
    return `${pad}{${test} && (\n${ind(body, 2).replace(/^/, pad)}\n${pad})}`;
  }

  // INSTANCE_SWAP slot → render the ReactNode prop where the instance sits, with the
  // master's default glyph behind it ({slot ?? <Default/>}). Dispatched from emit().
  function emitSlotNode(ctx: NodeCtx): string {
    const { n, depth, binds, pad, sk, styleAttr, prefixBody } = ctx;
    const slotLg = binds!.slot!; // emit() only dispatches here when binds.slot is present
    usedProps.add(slotLg.name);
    // An instance-swap slot is an icon/content placeholder — center the
    // injected {prop} like a single-icon wrapper, else an inlined <svg>/{icon} aligns
    // to the text baseline (the "Hepsi ›" caret floats). Skip when the slot defines its
    // OWN auto-layout (that flow already positions the content).
    const slotBody = nodeStyleBody(n, push);
    const body = n.layout
      ? slotBody
      : [slotBody, `display: 'flex',`, `alignItems: 'center',`, `justifyContent: 'center',`]
          .filter(Boolean)
          .join("\n");
    styles.push({ key: sk, body: prefixBody(body) });
    // NEVER leave a slot with no default AND no marker: the master swaps a
    // default symbol in here, so always flag it (best-effort named via the screens
    // artifacts) — otherwise the zero-prop render is silently empty with nothing to catch.
    const defSym = slotLg.role === "slot" ? slotLg.defSym : null;
    let defaultEl = "null";
    if (defSym) {
      const defNode = findNodeByGuid(defSym);
      const defFills = defNode ? collectVectorFills(defNode) : [];
      const icon = ownIcon(
        { guid: defSym, name: defNode?.name },
        defFills.length ? defFills.length === 1 : undefined,
      );
      if (icon) {
        iconImports.set(icon.Name, icon.file);
        const sizeAttr = defNode?.box?.w ? ` size={${defNode.box.w}}` : "";
        // Icon colour: the default symbol's own fill if it has one, ELSE the CONTEXTUAL
        // colour this slot is recoloured to (read from the slot instance's override — e.g. a
        // filled button paints its icon praline-50). Without this a mono icon falls back to
        // currentColor and renders the wrong colour (dark icon on a dark button).
        const slotColor =
          defFills.length === 1
            ? { hex: defFills[0].hex, var: defFills[0].var as string | null }
            : iconOverrideColor(n.guid);
        const colorAttr =
          icon.mono && slotColor && slotColor.hex
            ? ` color={${colorRef({ hex: slotColor.hex, var: slotColor.var, match: slotColor.var ? "bound" : null }, `${n.name} default icon`, push)}}`
            : "";
        defaultEl = `<${icon.Name}${sizeAttr}${colorAttr} />`;
      } else {
        push(
          `instance-swap "${slotLg.name}": default ${defNode?.name ? `"${defNode.name}" ` : ""}(${defSym}) — no geometry extracted; pass ${slotLg.name} or it renders empty`,
        );
      }
    } else {
      push(
        `instance-swap "${slotLg.name}": no IR default — pass ${slotLg.name} or it renders empty`,
      );
    }
    const el = `${pad}<${Box} ${styleAttr}>{${slotLg.name} ?? ${defaultEl}}</${Box}>`;
    return wrapConditional(el, binds, depth, n);
  }

  // Composite vector glyph / vector-only icon instance → export the geometry into an owned,
  // recolorable icon component (svg-lib) and render it centered. Dispatched from emit().
  function emitVectorGlyph(ctx: NodeCtx): string {
    const { n, depth, binds, pad, sk, styleAttr, prefixBody } = ctx;
    // Icons are an INTERNAL codegen step: export the geometry (svg-lib, from the decoded
    // message.json) into an owned recolorable component and drive its colour from the IR's
    // (override-aware) resolved fills — a mono icon gets currentColor + the resolved token
    // (fixes the baked-master-fill defect). The sized wrapper still flex-centres the glyph;
    // absolute placement / root-style merge ride on it exactly as before.
    const fills = collectVectorFills(n);
    // Icon colour: a single resolved fill (override-aware) wins; else the instance's raw
    // fill/stroke colour override (the common case — icons are recoloured via an override
    // the IR drops). null ⇒ the icon keeps its currentColor default and inherits context.
    const iconColor =
      fills.length === 1 ? { hex: fills[0].hex, var: fills[0].var } : iconOverrideColor(n.guid);
    const monoHint = fills.length ? fills.length === 1 : iconColor ? true : undefined;
    const icon = ownIcon(n, monoHint);
    const box = [
      n.box?.w ? `width: ${n.box.w},` : "",
      n.box?.h ? `height: ${n.box.h},` : "",
      `display: 'flex',`,
      `alignItems: 'center',`,
      `justifyContent: 'center',`,
    ]
      .filter(Boolean)
      .join("\n");
    styles.push({ key: sk, body: prefixBody(box) });
    if (icon) {
      iconImports.set(icon.Name, icon.file);
      const sizeAttr = n.box?.w ? ` size={${n.box.w}}` : "";
      const colorAttr =
        icon.mono && iconColor
          ? ` color={${colorRef({ hex: iconColor.hex, var: iconColor.var, match: iconColor.var ? "bound" : null }, `${n.name} icon`, push)}}`
          : "";
      const el = `${pad}<${Box} ${styleAttr}><${icon.Name}${sizeAttr}${colorAttr} /></${Box}>`;
      return wrapConditional(el, binds, depth, n);
    }
    // fallback — ownIcon produced nothing. Two cases:
    // (a) the geometry source WAS available (--svg + --out) but the vector yields no drawable
    //     paths → it's an INVISIBLE structural layer (e.g. a paintless vector-network base in a
    //     stroke glyph). Emit an empty box, NOT a scary export-svg TODO for something that
    //     draws nothing.
    if (svgIndex && outDir) {
      const el = `${pad}<${Box} ${styleAttr} />`;
      return wrapConditional(el, binds, depth, n);
    }
    // (b) no geometry source (no --svg/--out) → keep the export-svg placeholder so the user
    //     knows to pass it.
    const fillNote = fills.length
      ? ` fills:[${fills.map((f) => `${f.hex}${f.var ? ` ${f.var}` : ""}`).join(", ")}]`
      : "";
    const size = `${n.box?.w ?? "?"}×${n.box?.h ?? "?"}`;
    push(
      `icon/vector "${n.name}" (${n.guid}) ${size}${fillNote} — pass --svg <message.json> to export + wire it (or run export-svg.mts and inline)`,
    );
    const el = `${pad}<${Box} ${styleAttr}>{/* TODO: export "${n.name}" via export-svg (${n.guid})${fillNote} */}</${Box}>`;
    return wrapConditional(el, binds, depth, n);
  }

  const jsx = emit(subtree, 0, false);
  return {
    v,
    propKey,
    compName: variantComponentName(v),
    fileSlug: variantFileSlug(v),
    jsx,
    styles,
    usedProps,
    refImports,
    iconImports,
    usesStyleProp,
    rnImageUsed,
    todos,
  };
}

const rendered = variants.map(renderVariant);
if (!rendered.length)
  throw new Error(
    `component set "${comp.name ?? setName}" has no variants and no set guid to render — nothing to generate (check the component detection in build-ir)`,
  );
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
  // Per-instance ROOT style override, merged onto the component's root node.
  // A parent referencing this component as a nested instance passes its overridden root
  // box styles here; also usable when assembling screens to nudge an instance.
  lines.push(`  /** Root style override (applied to this component's root element). */`);
  lines.push(`  ${STYLE_PROP}?: ${web ? "React.CSSProperties" : "StyleProp<ViewStyle>"};`);
  return lines.join("\n");
}

function typesFile(): string {
  const typeImports = web
    ? `import type * as React from 'react';`
    : `import type * as React from 'react';\nimport type { StyleProp, ViewStyle } from 'react-native';`;
  return `// AUTO-GENERATED — shared Props type for the "${comp.name}" component folder.
// Type-only module so index.tsx and the per-variant files never form a runtime cycle.
${typeImports}

export type ${Comp}Props = {
${propsTypeBody()}
};
`;
}

// the destructure of logical props (all optional) for a variant component signature.
// `withStyle` appends the root `style` override prop when the variant's root merges it.
function destructure(used: Set<string>, withStyle: boolean): string {
  // bool visibility props default to their IR value so a master-visible node renders at zero
  // props: `{ showHeader = true }`. text/slot props stay plain (text carries its
  // master-default fallback at the use site; a slot has no sensible literal default).
  const names = logicals
    .filter((l) => used.has(l.name))
    .map((l) => (l.role === "bool" && l.defBool != null ? `${l.name} = ${l.defBool}` : l.name));
  if (withStyle) names.push(STYLE_PROP);
  return names.length ? `{ ${names.join(", ")} }` : "_props";
}

function variantFile(r: VariantRender): string {
  const stylesDecl = web
    ? `const styles: Record<string, React.CSSProperties> = {\n${r.styles.map((s) => `  ${s.key}: {\n${ind(s.body, 4)}\n  },`).join("\n")}\n};`
    : `const styles = StyleSheet.create({\n${r.styles.map((s) => `  ${s.key}: {\n${ind(s.body, 4)}\n  },`).join("\n")}\n});`;
  // RN files that reference the theme (theme[defaultMode]…) need the import; web uses
  // inline CSS var() strings and needs none.
  const usesTheme = !web && (stylesDecl.includes(THEME_MARK) || r.jsx.includes(THEME_MARK));
  // nested child components referenced by this variant → sibling-folder imports
  // (all component folders share the same --out base, so '../<slug>'). Deterministic
  // order; de-duped by component identifier.
  const refImportLines = [...r.refImports.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([Ref, refSlug]) => `import { ${Ref} } from '../${refSlug}';`)
    .join("\n");
  // owned icons live in the SHARED <out>/icons/ dir (sibling to this <slug>/ folder).
  const iconImportLines = [...r.iconImports.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([Name, file]) => `import { ${Name} } from '../icons/${file}';`)
    .join("\n");
  const rnImports = ["View", "Text", "StyleSheet", ...(r.rnImageUsed ? ["Image"] : [])].join(", ");
  const imports =
    (web
      ? `import * as React from 'react';`
      : `import * as React from 'react';\nimport { ${rnImports} } from 'react-native';`) +
    (usesTheme ? `\nimport { theme, defaultMode } from '${themeImport}';` : "") +
    (refImportLines ? `\n${refImportLines}` : "") +
    (iconImportLines ? `\n${iconImportLines}` : "");
  const todoBlock = r.todos.length
    ? "\n// === TODO (this variant — unconfirmed values) ===\n" +
      r.todos.map((t) => `// TODO: ${t}`).join("\n") +
      "\n"
    : "\n// (no open TODOs for this variant)\n";
  return `// AUTO-GENERATED SCAFFOLD — "${comp.name}" variant "${r.propKey}" (${r.v.rawName}). NOT finished code.
// Renders this variant's OWN resolved subtree (guid ${r.v.guidKey}) with reconciled
// per-node style/layout/font/text; bound nodes consume props. Review every // TODO.
${imports}
import type { ${Comp}Props } from './types';

export function ${r.compName}(${destructure(r.usedProps, r.usesStyleProp)}: ${Comp}Props) {
  return (
${ind(r.jsx, 4)}
  );
}

${stylesDecl}
${todoBlock}`;
}

function indexFile(): string {
  const reactImport = web ? `import * as React from 'react';` : `import * as React from 'react';`;
  const variantImports = rendered
    .map((r) => `import { ${r.compName} } from './${r.fileSlug}';`)
    .join("\n");
  // dispatcher: map variant prop key → variant component. Default is the fallback.
  const cases = rendered
    .map((r) => `    case '${r.propKey}': return <${r.compName} {...props} />;`)
    .join("\n");
  const defaultR = rendered.find((r) => r.v.guidKey === defaultVariant?.guidKey) ?? rendered[0];
  const destructured =
    axisNames.length === 0
      ? ""
      : axisNames.length === 1
        ? "variant"
        : axisNames.map(kebab).join(", ");
  const reviewBlock = allTodos.length
    ? "\n// === REVIEW (all open TODOs, attributed to the variant) ===\n" +
      allTodos.map((t) => `// TODO: ${t}`).join("\n") +
      "\n"
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
console.error(
  `codegen: ${comp.name} (${rendered.length} variant(s)) → ${framework}, ${allTodos.length} TODO(s), ${logicals.length} prop(s)`,
);
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
  // owned icons → the SHARED <out>/icons/ dir (siblings of every component folder).
  if (iconFiles.size) {
    fs.mkdirSync(path.join(outDir, "icons"), { recursive: true });
    for (const [rel, content] of iconFiles) fs.writeFileSync(path.join(outDir, rel), content);
    console.error(`wrote ${path.join(outDir, "icons")}/ (${iconFiles.size} owned icon(s))`);
  }
} else {
  // no --out: print the folder contents to stdout (each file headed by its path).
  console.error(`(no --out — printing ${files.length} file(s) to stdout)`);
  console.log(files.map((f) => `// ==== ${slug}/${f.rel} ====\n${f.content}`).join("\n\n"));
}

// always echo the index to stdout as the primary artifact when writing to disk.
if (outDir) console.log(indexFile());
