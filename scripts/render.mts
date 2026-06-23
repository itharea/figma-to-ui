// Visual ground-truth for a frame (P1-3): resolve the instance tree, emit a
// self-contained HTML page, screenshot it with headless Chrome. NOT pixel-perfect
// — enough to catch "obviously bigger / wrong font / wrong position". Always also
// writes <out>.html beside the PNG so the RECONCILED-size claim is inspectable
// without Chrome (and so a Chrome-less machine still gets the artifact).
//
// Usage: node render.mts <message.json> <frame-guidKey> <out.png> [--images <dir>]
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { load, key } from "./lib.mts";
import { resolveScreen, type ResolvedNode } from "./resolve-lib.mts";
import { reconcileTextSize, letterSpacingToPx, lineHeightPx, disambiguateJustify } from "./reconcile-lib.mts";
import { rasterizeFile } from "./raster-lib.mts";

const imagesFlagIdx = process.argv.indexOf("--images");
const imagesDirArg = imagesFlagIdx >= 0 ? process.argv[imagesFlagIdx + 1] : undefined;

// --- IR mode (Phase 9 Task 4): render OVER an already-resolved+reconciled IR ---
// node render.mts --ir <ir-dir> <screen-id> <out.png> [--images <dir>]
// One step: read screens/<…>.json directly → HTML → PNG. NO re-resolve, NO
// re-reconcile, and NO blob re-decode (never calls load/resolveScreen/export-svg/
// parse). Asset bytes (images / pre-exported SVGs) are read from a sidecar dir;
// a missing asset draws the phase-05 labeled placeholder, never a silent drop.
const irFlagIdx = process.argv.indexOf("--ir");
if (irFlagIdx >= 0) {
  await renderOverIR();
} else {
  renderRaw();
}

async function renderOverIR() {
  const irDir = process.argv[irFlagIdx + 1];
  // positional screen-id + out.png are the next two non-flag args after --ir's value
  const rest = process.argv.slice(irFlagIdx + 2).filter((a, i, arr) => {
    if (a === "--images") return false;
    if (i > 0 && arr[i - 1] === "--images") return false;
    return !a.startsWith("--");
  });
  const screenId = rest[0];
  const outPng = rest[1];
  if (!irDir || !screenId || !outPng)
    throw new Error("usage: render.mts --ir <ir-dir> <screen-id> <out.png> [--images <dir>]");

  const readJSON = (p: string): any => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
  const manifest = readJSON(path.join(irDir, "manifest.json"));
  if (!manifest) throw new Error(`${irDir}: no manifest.json — not an IR directory`);
  const screenRels: string[] = manifest.artifacts?.screens ?? [];

  // resolve <screen-id>: a screen file (slug/path/basename) OR a node id/guid.
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let rootNode: any = null;
  let label = screenId;
  const byFile = screenRels.find(
    (r) => r === screenId || r.endsWith("/" + screenId) || r.endsWith("/" + screenId + ".json") ||
      slug(path.basename(r, ".json")) === slug(screenId)
  );
  if (byFile) {
    rootNode = readJSON(path.join(irDir, byFile));
    label = byFile;
  } else {
    // search every screen for a node whose id or guid matches
    for (const r of screenRels) {
      const data = readJSON(path.join(irDir, r));
      (function w(n: any) {
        if (!n || rootNode) return;
        if (n.id === screenId || n.guid === screenId) { rootNode = n; label = `${r}#${screenId}`; return; }
        for (const c of n.children ?? []) w(c);
      })(data);
      if (rootNode) break;
    }
  }
  if (!rootNode)
    throw new Error(`screen-id "${screenId}" not found in ${irDir} (try a screen file slug, a node id, or a guid). Screens: ${screenRels.map((r) => slug(path.basename(r, ".json"))).slice(0, 20).join(", ")}`);

  const outDir = path.dirname(path.resolve(outPng));
  const outHtml = outPng.replace(/\.png$/i, "") + ".html";
  const assetsDir = path.join(outDir, "images");
  // sidecar images: --images, else sibling images/ next to the IR dir or the out file.
  const imgCands = [imagesDirArg, path.join(irDir, "images"), path.join(outDir, "images")].filter(Boolean) as string[];
  const imgSrc = imgCands.find((c) => fs.existsSync(c)) ?? null;
  // pre-exported SVGs: <ir-dir>/vectors/<id|guid>.svg (assets IR deferred — read bytes if present)
  const vecDir = [path.join(irDir, "vectors"), path.join(outDir, "vectors")].find((d) => fs.existsSync(d)) ?? null;

  const esc = (s: string) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const placeholder = (w: number, h: number, lbl: string) =>
    `<div style="position:absolute;width:${w}px;height:${h}px;box-sizing:border-box;border:1px dashed #c0392b;` +
    `background:repeating-linear-gradient(45deg,#fbeae8,#fbeae8 6px,#f6d6d2 6px,#f6d6d2 12px);` +
    `color:#c0392b;font:10px/1.2 monospace;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden">${esc(lbl)}</div>`;

  const notes: string[] = [];
  const rootAbsX = rootNode.box?.absX ?? 0;
  const rootAbsY = rootNode.box?.absY ?? 0;
  const weightOf = (w: string | null) => (/bold|black|heavy|semibold|800|700|900/i.test(w ?? "") ? 700 : 400);

  // Read a sidecar SVG for a node id/guid, if one was pre-exported.
  const svgFor = (n: any): string | null => {
    if (!vecDir) return null;
    for (const k of [n.id, n.guid]) {
      const p = path.join(vecDir, `${k}.svg`);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
    return null;
  };

  // Resolve a sidecar image hash → a copied basename under the out images/ dir, or
  // null (caller draws a labeled placeholder). Reads bytes from the resolved imgSrc.
  const copiedImg = new Map<string, string | null>();
  const useImage = (hash: string | undefined): string | null => {
    if (!hash || !imgSrc) return null;
    if (copiedImg.has(hash)) return copiedImg.get(hash)!;
    let found: string | null = null;
    const direct = fs.existsSync(path.join(imgSrc, hash)) ? hash : null;
    found = direct ?? fs.readdirSync(imgSrc).find((f) => f === hash || f.startsWith(hash + ".")) ?? null;
    if (found) {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.copyFileSync(path.join(imgSrc, found), path.join(assetsDir, found));
    }
    copiedImg.set(hash, found);
    return found;
  };

  // border-radius CSS from style.cornerRadius (uniform number | per-corner object).
  const radiusCss = (cr: any): string | null => {
    if (cr === undefined || cr === null) return null;
    if (typeof cr === "number") return cr ? `border-radius:${cr}px` : null;
    return `border-radius:${cr.tl ?? 0}px ${cr.tr ?? 0}px ${cr.br ?? 0}px ${cr.bl ?? 0}px`;
  };

  // Faithful box-styling from IRStyle (B-style-layout / spec #2): solid/gradient
  // background, border-radius, border (first stroke), box-shadow (drop/inner
  // shadows), opacity. Returns the CSS decls + whether an IMAGE fill is present.
  const styleCss = (n: any): { decls: string[]; imageHash: string | null } => {
    const decls: string[] = [];
    const st = n.style;
    let imageHash: string | null = null;
    if (!st) return { decls, imageHash };
    // fills: first visible solid → background-color; gradient → linear-gradient;
    // image → defer to caller (background-image or placeholder).
    for (const f of st.fills ?? []) {
      if (f.type === "solid" && f.hex && n.type !== "text") {
        decls.push(`background-color:${f.hex}`);
        break;
      }
      if (f.type === "gradient" && (f.stops ?? []).length) {
        const stops = f.stops.map((s: any) => `${s.hex} ${Math.round((s.position ?? 0) * 100)}%`).join(",");
        decls.push(`background-image:linear-gradient(${stops})`);
        break;
      }
      if (f.type === "image") {
        imageHash = f.imageHash ?? null;
        break;
      }
    }
    const r = radiusCss(st.cornerRadius);
    if (r) decls.push(r);
    const stroke = (st.strokes ?? [])[0];
    if (stroke && stroke.hex) {
      // dashed stroke (3-borders): a non-empty dash → border-style:dashed.
      const lineStyle = Array.isArray(stroke.dash) && stroke.dash.length ? "dashed" : "solid";
      // per-side border widths (3-borders): when style.borderWidths is present the
      // four side weights apply INSTEAD of a uniform border, so a bottom-only
      // divider survives. Emit border-<side>-width for each side, plus a shared
      // style+color. Graceful: absent borderWidths → the uniform border as before.
      const bw = st.borderWidths;
      if (bw && (bw.top || bw.right || bw.bottom || bw.left)) {
        decls.push(`border-style:${lineStyle}`, `border-color:${stroke.hex}`);
        for (const [side, val] of [["top", bw.top], ["right", bw.right], ["bottom", bw.bottom], ["left", bw.left]] as const)
          decls.push(`border-${side}-width:${val ?? 0}px`);
      } else {
        decls.push(`border:${stroke.weight ?? 1}px ${lineStyle} ${stroke.hex}`);
      }
    }
    const shadows = (st.effects ?? [])
      .filter((e: any) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
      .map((e: any) => `${e.type === "INNER_SHADOW" ? "inset " : ""}${e.offsetX ?? 0}px ${e.offsetY ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px ${e.hex ?? "#0000"}`);
    if (shadows.length) decls.push(`box-shadow:${shadows.join(",")}`);
    if (typeof st.opacity === "number" && st.opacity < 1) decls.push(`opacity:${st.opacity}`);
    return { decls, imageHash };
  };

  // Faithful auto-layout from IRLayout (B-style-layout / spec #2): flex container.
  const layoutCss = (n: any): string[] => {
    const l = n.layout;
    if (!l) return [];
    const out = ["display:flex", `flex-direction:${l.mode}`];
    if (l.gap) out.push(`gap:${l.gap}px`);
    const pt = l.paddingTop ?? 0, pr = l.paddingRight ?? 0, pb = l.paddingBottom ?? 0, pl = l.paddingLeft ?? 0;
    if (pt || pr || pb || pl) out.push(`padding:${pt}px ${pr}px ${pb}px ${pl}px`);
    const j = disambiguateJustify(l, n.box, n.children ?? []);
    if (j) out.push(`justify-content:${j}`);
    if (l.align) out.push(`align-items:${l.align}`);
    if (l.wrap) out.push("flex-wrap:wrap");
    return out;
  };

  // hug sizing → let content drive that axis (width/height:auto). Returns the
  // axis names ("width"/"height") the layout HUGS on, so irNode can drop the
  // forced fixed px on those axes (graceful — fixed/absent keeps the box px).
  const hugAxes = (n: any): { width: boolean; height: boolean } => {
    const l = n.layout;
    if (!l) return { width: false, height: false };
    // primary axis = main (row→width, column→height); counter = the other.
    const row = l.mode === "row";
    const primaryHug = l.primarySizing === "hug";
    const counterHug = l.counterSizing === "hug";
    return {
      width: row ? primaryHug : counterHug,
      height: row ? counterHug : primaryHug,
    };
  };

  // Per-node sizing as a flex CHILD / sized box (1-sizing): grow→flex-grow,
  // alignSelf, aspect-ratio, min/max. grow/alignSelf only bite when the node flows
  // inside an auto-layout parent (parentFlow); aspect-ratio/min/max apply always.
  // stackPositioning:absolute is handled in irNode's `pos` (kept out of flow).
  const childSizingCss = (n: any, parentFlow: boolean): string[] => {
    const out: string[] = [];
    if (parentFlow && typeof n.grow === "number" && n.grow) out.push(`flex-grow:${n.grow}`);
    if (parentFlow && n.alignSelf) out.push(`align-self:${n.alignSelf}`);
    if (typeof n.aspectRatio === "number" && n.aspectRatio) out.push(`aspect-ratio:${n.aspectRatio}`);
    if (typeof n.minW === "number") out.push(`min-width:${n.minW}px`);
    if (typeof n.minH === "number") out.push(`min-height:${n.minH}px`);
    if (typeof n.maxW === "number") out.push(`max-width:${n.maxW}px`);
    if (typeof n.maxH === "number") out.push(`max-height:${n.maxH}px`);
    return out;
  };

  // Render one IR node. Auto-layout nodes (layout present) FLOW their children;
  // otherwise children are absolutely positioned from absX/absY (the IR baked abs
  // coords). `parentFlow` controls how THIS node positions itself in its parent.
  // TEXT uses the reconciled font; style.fills/strokes/effects/opacity + layout
  // give a faithful render (B-style-layout). Missing image → labeled placeholder.
  function irNode(n: any, parentFlow = false): string {
    if (!n) return "";
    const b = n.box ?? { x: 0, y: 0, w: 0, h: 0, absX: 0, absY: 0 };
    const w = Math.round(b.w ?? 0);
    const h = Math.round(b.h ?? 0);
    // stackPositioning:absolute (1-sizing) → absolutely positioned INSIDE an
    // auto-layout parent, out of flow, placed from the baked abs coords.
    const absInFlow = n.positioning === "absolute";
    const pos =
      parentFlow && !absInFlow
        ? "position:relative"
        : `position:absolute;left:${Math.round((b.absX ?? 0) - rootAbsX)}px;top:${Math.round((b.absY ?? 0) - rootAbsY)}px`;
    const base = `${pos};box-sizing:border-box`;

    if (n.type === "text" && n.font) {
      const f = n.font;
      const fam = f.appFamily || f.family || "sans-serif";
      const ts = [
        base,
        `width:${w}px`,
        `font-family:${JSON.stringify(fam)}`,
        `font-size:${f.size ?? 16}px`,
        `font-weight:${weightOf(f.weight)}`,
      ];
      if (/italic|oblique/i.test(f.weight ?? "")) ts.push("font-style:italic");
      if (f.lineHeightPx) ts.push(`line-height:${f.lineHeightPx}px`);
      if (f.letterSpacingPx) ts.push(`letter-spacing:${f.letterSpacingPx}px`);
      // text transform & alignment (2-text): IRTextField.case/align are already
      // CSS values (uppercase/capitalize/…, center/right/justify).
      if (n.text?.case) ts.push(`text-transform:${n.text.case}`);
      if (n.text?.align) ts.push(`text-align:${n.text.align}`);
      if (n.color?.hex) ts.push(`color:${n.color.hex}`);
      const { decls } = styleCss(n); // text-level effects/opacity (no bg)
      ts.push(...decls, ...childSizingCss(n, parentFlow)); // grow/alignSelf/min/max
      return `<div data-id="${n.id}" data-recon="${f.sizeSource}" style="${ts.join(";")}">${esc(n.text?.value ?? "")}</div>`;
    }

    // pre-exported vector → inline its SVG (assets IR deferred — bytes only if present)
    const svg = svgFor(n);
    if (svg && !(n.children ?? []).length) {
      const inner = svg.replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "");
      return `<div style="${base};width:${w}px;height:${h}px">${inner}</div>`;
    }

    const flow = !!n.layout;
    // hug sizing (1-sizing): on a hugged axis emit auto (content-driven) instead of
    // the forced fixed px. Fixed/absent axes keep their box px (graceful fallback).
    const hug = hugAxes(n);
    const wDecl = hug.width ? "width:auto" : `width:${w}px`;
    const hDecl = hug.height ? "height:auto" : `height:${h}px`;
    const style = [base, wDecl, hDecl, ...styleCss(n).decls, ...layoutCss(n), ...childSizingCss(n, parentFlow)];
    // IRColor.hex convenience fallback when style.fills had no solid (kept for parity)
    const { imageHash } = styleCss(n);
    const hasBg = style.some((s) => s.startsWith("background-color") || s.startsWith("background-image"));
    if (!hasBg && n.color?.hex) style.push(`background-color:${n.color.hex}`);

    // IMAGE fill → background-image (sidecar bytes), else labeled placeholder.
    if (imageHash) {
      const file = useImage(imageHash);
      if (file) {
        style.push(`background-image:url("images/${esc(file)}")`, "background-size:cover", "background-position:center", "background-repeat:no-repeat");
        return `<div data-id="${n.id}" style="${style.join(";")}"></div>`;
      }
      notes.push(`image ${imageHash.slice(0, 8)}… missing → placeholder`);
      return `<div data-id="${n.id}" style="${style.join(";")}">${placeholder(w, h, `img ${imageHash.slice(0, 8)}`)}</div>`;
    }

    // a leaf with no fill/style, no children, that looks like an asset slot → placeholder
    const isLeaf = !(n.children ?? []).length;
    if (isLeaf && !hasBg && !n.color?.hex && /image|video|vector|icon/i.test(n.type) && w && h) {
      notes.push(`asset ${n.id} (${n.type}) has no sidecar bytes → placeholder`);
      return `<div style="${base}">${placeholder(w, h, n.type)}</div>`;
    }
    const kids = (n.children ?? []).map((c: any) => irNode(c, flow)).join("");
    return `<div data-id="${n.id}" style="${style.join(";")}">${kids}</div>`;
  }

  const W = Math.ceil(rootNode.box?.w ?? 390);
  const H = Math.ceil(rootNode.box?.h ?? 844);
  const body = irNode({ ...rootNode, box: { ...rootNode.box, absX: rootAbsX, absY: rootAbsY } });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}html,body{background:#fff}
#frame{position:relative;width:${W}px;height:${H}px;overflow:hidden}
</style></head><body><div id="frame">${body}</div></body></html>`;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outHtml, html);
  console.log(`wrote ${outHtml}: ${W}x${H} from IR ${label} (resolved+reconciled — no re-resolve, no blob decode)`);
  for (const note of notes) console.error("  note: " + note);
  const r = rasterizeFile(outHtml, outPng, W, H, 2, "ffffffff");
  if (r.ok) console.log(`wrote ${outPng}: ${W * 2}x${H * 2} (@2x)`);
  else console.error(`⚠ PNG skipped (${r.reason}); ${outHtml} written and inspectable`);
}

function renderRaw() {
const msgPath = process.argv[2];
const frame = process.argv[3];
const outPng = process.argv[4];
if (!msgPath || !frame || !outPng)
  throw new Error("usage: render.mts <message.json> <frame-guidKey> <out.png> [--images <dir>]   |   render.mts --ir <ir-dir> <screen-id> <out.png> [--images <dir>]");

const index = load(msgPath);
const root = resolveScreen(index, frame);

const outDir = path.dirname(path.resolve(outPng));
const outHtml = outPng.replace(/\.png$/i, "") + ".html";
const assetsDir = path.join(outDir, "images");

// Source images dir resolution (SKILL.md §0/§7): --images, else a sibling
// images/ or ex/images/ next to message.json. The decode carries only image.hash;
// pixels live in the unzipped fig's images/ dir.
function srcImagesDir(): string | null {
  const cands = [
    imagesDirArg,
    path.join(path.dirname(path.resolve(msgPath)), "images"),
    path.join(path.dirname(path.resolve(msgPath)), "ex", "images"),
  ].filter(Boolean) as string[];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}
const imgSrc = srcImagesDir();

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hashHex = (h: any): string | null =>
  Array.isArray(h) ? Buffer.from(h).toString("hex") : typeof h === "string" ? h : null;

// Copy a referenced image hash into the output images/ dir; return its basename or
// null if the source dir/hash is missing (caller draws a labeled placeholder).
const copied = new Map<string, string | null>();
function resolveImage(hashArr: any): string | null {
  const hex = hashHex(hashArr);
  if (!hex) return null;
  if (copied.has(hex)) return copied.get(hex)!;
  let found: string | null = null;
  if (imgSrc) {
    // images/ filenames are usually the hex hash, possibly with an extension.
    const direct = fs.existsSync(path.join(imgSrc, hex)) ? hex : null;
    const withExt = direct
      ? null
      : fs.readdirSync(imgSrc).find((f) => f === hex || f.startsWith(hex + "."));
    found = direct ?? withExt ?? null;
  }
  if (found) {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(path.join(imgSrc!, found), path.join(assetsDir, found));
    copied.set(hex, found);
    return found;
  }
  copied.set(hex, null);
  return null;
}

// Vectors → run export-svg.mts as a SUBPROCESS (never import it — it runs its CLI
// at import time) to a temp .svg, then inline the markup. On failure, null →
// labeled placeholder. Degrades gracefully.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-svg-"));
let svgSeq = 0;
const runtime = process.argv[0]; // node or bun — reuse whatever invoked us
const selfDir = path.dirname(new URL(import.meta.url).pathname);
function vectorSvg(guidKey: string): string | null {
  try {
    const svgPath = path.join(tmpDir, `v${svgSeq++}.svg`);
    const r = spawnSync(runtime, [path.join(selfDir, "export-svg.mts"), msgPath, guidKey, svgPath], {
      encoding: "utf8",
      timeout: 60000,
    });
    if (r.status !== 0 || !fs.existsSync(svgPath)) return null;
    return fs.readFileSync(svgPath, "utf8");
  } catch {
    return null;
  }
}

const ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
  SPACE_EVENLY: "space-evenly",
  BASELINE: "baseline",
  STRETCH: "stretch",
};

const labeledPlaceholder = (w: number, h: number, label: string) =>
  `<div style="width:${w}px;height:${h}px;box-sizing:border-box;border:1px dashed #c0392b;` +
  `background:repeating-linear-gradient(45deg,#fbeae8,#fbeae8 6px,#f6d6d2 6px,#f6d6d2 12px);` +
  `color:#c0392b;font:10px/1.2 monospace;display:flex;align-items:center;justify-content:center;` +
  `text-align:center;overflow:hidden">${esc(label)}</div>`;

const notes: string[] = [];

// A node is auto-layout if it carries a real stackMode (HORIZONTAL/VERTICAL).
const isAutoLayout = (n: any) => n.stackMode === "HORIZONTAL" || n.stackMode === "VERTICAL";

// Render one resolved node → an HTML string. `parentAuto` controls whether the
// node positions itself absolutely (non-auto parent) or flows (auto parent).
function renderNode(n: ResolvedNode, parentAuto: boolean): string {
  if ((n as any).visible === false) return "";
  const w = Math.round((n as any).size?.x ?? 0);
  const h = Math.round((n as any).size?.y ?? 0);
  const t = (n as any).transform;
  const style: string[] = ["box-sizing:border-box"];

  // Positioning: auto-layout parents flow children; otherwise absolute from the
  // node's own transform translation (m02,m12) — its parent-relative origin.
  if (!parentAuto && t) {
    style.push("position:absolute", `left:${Math.round(t.m02)}px`, `top:${Math.round(t.m12)}px`);
  } else {
    style.push("position:relative");
  }

  // size — text auto-sizes (let content drive height so the reconciled font is
  // visible); everything else takes its box.
  if (n.type !== "TEXT") {
    if (w) style.push(`width:${w}px`);
    if (h) style.push(`height:${h}px`);
  }

  // fills: first visible SOLID → background; IMAGE → <img>/placeholder handled below.
  const fills = ((n as any).fillPaints ?? []).filter((p: any) => p.visible !== false);
  const solid = fills.find((p: any) => p.type === "SOLID");
  if (solid && n.type !== "TEXT") {
    const c = solid.color ?? {};
    const a = (c.a ?? 1) * (solid.opacity ?? 1) * ((n as any).opacity ?? 1);
    style.push(`background-color:rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a.toFixed(3)})`);
  }
  const cr = (n as any).cornerRadius;
  if (cr) style.push(`border-radius:${cr}px`);
  const stroke = ((n as any).strokePaints ?? []).find((p: any) => p.visible !== false && p.type === "SOLID");
  if (stroke) {
    const c = stroke.color ?? {};
    style.push(`border:${(n as any).strokeWeight ?? 1}px solid rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${(c.a ?? 1).toFixed(3)})`);
  }
  if ((n as any).opacity !== undefined && (n as any).opacity < 1 && n.type !== "TEXT")
    style.push(`opacity:${(n as any).opacity}`);

  // auto-layout container → flex (§4 fig→CSS table)
  if (isAutoLayout(n)) {
    style.push("display:flex");
    style.push(`flex-direction:${n.stackMode === "HORIZONTAL" ? "row" : "column"}`);
    style.push(`gap:${(n as any).stackSpacing ?? 0}px`);
    style.push(
      `padding:${(n as any).stackVerticalPadding ?? 0}px ${(n as any).stackPaddingRight ?? 0}px ${(n as any).stackPaddingBottom ?? 0}px ${(n as any).stackHorizontalPadding ?? 0}px`
    );
    style.push(`justify-content:${ALIGN[(n as any).stackPrimaryAlignItems] ?? "flex-start"}`);
    style.push(`align-items:${ALIGN[(n as any).stackCounterAlignItems] ?? "flex-start"}`);
  }

  // ---- TEXT ----
  if (n.type === "TEXT") {
    const rec = reconcileTextSize(n as any); // RECONCILED size (geometry beats stale font)
    const size = rec.size ?? (n as any).fontSize ?? 16;
    const fn = (n as any).fontName ?? {};
    const lh = lineHeightPx((n as any).lineHeight, (n as any).fontSize);
    const ls = letterSpacingToPx((n as any).letterSpacing, (n as any).fontSize);
    const ts: string[] = [
      "box-sizing:border-box",
      "position:" + (!parentAuto && t ? "absolute" : "relative"),
    ];
    if (!parentAuto && t) ts.push(`left:${Math.round(t.m02)}px`, `top:${Math.round(t.m12)}px`);
    ts.push(`font-family:${JSON.stringify(fn.family ?? "sans-serif")}`);
    ts.push(`font-size:${size}px`);
    ts.push(`font-weight:${/bold|black|heavy|semibold|800|700|900/i.test(fn.style ?? "") ? 700 : 400}`);
    if (/italic|oblique/i.test(fn.style ?? "")) ts.push("font-style:italic");
    if (lh) ts.push(`line-height:${lh}px`);
    if (ls) ts.push(`letter-spacing:${ls}px`);
    if ((n as any).textAlignHorizontal && (n as any).textAlignHorizontal !== "LEFT")
      ts.push(`text-align:${String((n as any).textAlignHorizontal).toLowerCase()}`);
    if ((n as any).textCase === "UPPER") ts.push("text-transform:uppercase");
    if (solid) {
      const c = solid.color ?? {};
      ts.push(`color:rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${(c.a ?? 1).toFixed(3)})`);
    }
    const chars = (n as any).textData?.characters ?? "";
    const tag = rec.conflicts.length ? `<!-- reconciled ${(n as any).fontSize}→${size} (geometry) -->` : "";
    return `${tag}<div data-recon="${rec.source}" data-size="${size}" style="${ts.join(";")}">${esc(chars)}</div>`;
  }

  // ---- IMAGE fill ----
  const imgPaint = fills.find((p: any) => p.type === "IMAGE");
  if (imgPaint) {
    const file = resolveImage(imgPaint.image?.hash);
    if (file) {
      style.push(`background-image:url("images/${esc(file)}")`);
      style.push(`background-size:${imgPaint.imageScaleMode === "FIT" ? "contain" : "cover"}`);
      style.push("background-position:center", "background-repeat:no-repeat");
      return `<div style="${style.join(";")}"></div>`;
    }
    const hex = hashHex(imgPaint.image?.hash) ?? "?";
    notes.push(`image ${hex.slice(0, 8)}… missing → placeholder`);
    return `<div style="${style.join(";")}">${labeledPlaceholder(w, h, `img ${hex.slice(0, 8)}`)}</div>`;
  }

  // ---- VECTOR / geometry node → inline export-svg subprocess output ----
  const hasGeom = ((n as any).fillGeometry?.length || (n as any).strokeGeometry?.length) && n.type !== "FRAME";
  if (hasGeom && (!n.children || !n.children.length)) {
    const svg = vectorSvg((n as any).guid);
    if (svg) {
      // strip the XML width/height so it scales to the box
      const inner = svg.replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "");
      return `<div style="${style.join(";")}">${inner}</div>`;
    }
    notes.push(`vector ${(n as any).guid} → placeholder (export-svg failed/absent)`);
    return `<div style="${style.join(";")}">${labeledPlaceholder(w, h, "vector")}</div>`;
  }

  // ---- container: recurse ----
  const auto = isAutoLayout(n);
  const kids = (n.children ?? []).map((c) => renderNode(c, auto)).join("");
  return `<div style="${style.join(";")}">${kids}</div>`;
}

const W = Math.ceil((root as any).size?.x ?? 390);
const H = Math.ceil((root as any).size?.y ?? 844);
const body = renderNode(root, false);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}
html,body{background:#fff}
#frame{position:relative;width:${W}px;height:${H}px;overflow:hidden}
</style></head><body><div id="frame">${body}</div></body></html>`;

fs.writeFileSync(outHtml, html);
console.log(`wrote ${outHtml}: ${W}x${H} (self-contained, reconciled sizes inspectable)`);
for (const note of notes) console.error("  note: " + note);

const r = rasterizeFile(outHtml, outPng, W, H, 2, "ffffffff");
if (r.ok) console.log(`wrote ${outPng}: ${W * 2}x${H * 2} (@2x)`);
else console.error(`⚠ PNG skipped (${r.reason}); ${outHtml} written and inspectable`);

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}
}
