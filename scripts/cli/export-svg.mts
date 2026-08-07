// Export a vector node (logo, illustration, custom icon) as an SVG FILE, or — with
// `--component <icons-dir>` — as an OWNED ICON COMPONENT in the build's shared icon set.
// Geometry extraction lives in svg-lib.mts (shared with codegen's internal icon export).
//
// Why the second mode exists: codegen owns the glyphs it finds inside a component SCAFFOLD,
// but a screen carries bare VECTOR nodes that sit in no component at all, and codegen is
// invoked per component SET — it never walks a screen. The screen-assembly step therefore had
// no way to honour "the owned icon set is the source of truth" for those nodes: the only
// vector CLI wrote a raw .svg, which leaves inlining or an icon library as the only things an
// agent can do with it, and both are exactly what the harness forbids. This mode closes that
// hole with the SAME svg-lib plan/emit path and the SAME content-addressed name codegen uses,
// so a glyph codegen already owns is REUSED rather than duplicated.
//
// Usage: node export-svg.mts <message.json> <guidKey> <out.svg> [--png] [--recolor=currentColor]
//        node export-svg.mts <message.json> <guidKey> --component <icons-dir>
//                            [--framework rn|web] [--color <hex> …]
import * as fs from "fs";
import * as path from "path";
import { rasterizeFile } from "../lib/raster-lib.mts";
import { load } from "../lib/figma-index.mts";
import {
  extractGeometry,
  toSvgString,
  planIcon,
  emitIconComponent,
  type IconColor,
} from "../lib/svg-lib.mts";
import { ownedIconName } from "../lib/naming.mts";

const USAGE =
  "usage: export-svg.mts <message.json> <guidKey> <out.svg> [--png] [--recolor=currentColor]\n" +
  "       export-svg.mts <message.json> <guidKey> --component <icons-dir> [--framework rn|web] [--color <hex> …]";

// Flags that CONSUME the next argv entry — parsed explicitly so their values never fall
// through into the positional list (`--component <dir>` would otherwise be read as <out.svg>).
const VALUE_FLAGS = new Set(["--component", "--framework", "--color"]);
const argv = process.argv.slice(2);
const positional: string[] = [];
const colors: string[] = [];
let componentDir: string | undefined;
let framework = "rn";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
    if (a === "--component") componentDir = v;
    else if (a === "--framework") framework = v.toLowerCase();
    else colors.push(v);
  } else if (!a.startsWith("--")) positional.push(a);
}
const png = argv.includes("--png");
const recolor: "preserve" | "currentColor" = argv.includes("--recolor=currentColor")
  ? "currentColor"
  : "preserve";

const msgPath = positional[0];
const target = positional[1];
const outFile = positional[2];
if (!msgPath || !target || (!componentDir && !outFile)) throw new Error(USAGE);
if (framework !== "rn" && framework !== "web")
  throw new Error(`--framework must be rn|web (got "${framework}")`);

const index = load(msgPath);
const geo = extractGeometry(index, target);

// --- owned icon component (the shared icon set) --------------------------------
// Colour is the CALLER's truth, exactly as in codegen: pass one `--color <hex>` per DISTINCT
// resolved paint the IR puts on this subtree (its `color`s, then its `stroke`s). The COUNT is
// what planIcon reads — one ⇒ mono (a required `color` prop, no baked default to inherit),
// two or more ⇒ the palette is baked and an outline survives instead of being flattened into
// the fill. None given falls back to the master's own paints, which for a bare screen vector
// are already the resolved ones unless a variable binding superseded them.
if (componentDir) {
  if (!geo.paths.length)
    throw new Error(`${target}: no vector geometry — not a glyph (nothing to own)`);
  const resolved: IconColor[] = colors.map((hex) => ({ hex }));
  const plan = planIcon(geo, resolved);
  const web = framework === "web";
  fs.mkdirSync(componentDir, { recursive: true });

  // REUSE before write, keyed on the identity hash ALONE rather than the whole filename: the
  // same drawing reached through two different layer names ("Vector" in a component, "Shape"
  // on the screen) yields the same hash and a different stem, and writing both would put two
  // copies of one glyph in the owned set — the duplication this mode exists to prevent. The
  // hash is the identity; the stem is only there to make the file readable.
  const existing = fs.readdirSync(componentDir).find((f) => f.endsWith(`_${plan.idHash}Icon.tsx`));
  const Name = existing
    ? existing.replace(/\.tsx$/, "")
    : ownedIconName(nodeName(target), plan.idHash);
  const file = path.join(componentDir, `${Name}.tsx`);
  if (existing) {
    console.log(`reused ${file} (already owned — same geometry${plan.mono ? "" : " + palette"})`);
  } else {
    fs.writeFileSync(
      file,
      emitIconComponent(Name, geo, { web, mono: plan.mono, palette: plan.palette }),
    );
    console.log(`wrote ${file}: ${geo.width}x${geo.height}, ${geo.paths.length} paths`);
  }
  // The call site, printed rather than described: a mono icon has NO baked colour, so the
  // caller MUST pass one (bind it to the theme where the IR node carries a `var`).
  console.log(`import { ${Name} } from '<icons-dir>/${Name}'; // path relative to YOUR file`);
  console.log(
    plan.mono
      ? `<${Name} size={${geo.width}} color={/* the node's resolved color — theme token where it has a var */} />`
      : `<${Name} size={${geo.width}} />   // multi-paint: colours are baked from the design`,
  );
} else {
  const svg = toSvgString(geo, { recolor });
  fs.writeFileSync(outFile!, svg);
  console.log(
    `wrote ${outFile}: ${geo.width}x${geo.height}, ${geo.paths.length} paths, ${(svg.length / 1024).toFixed(1)}KB`,
  );

  // --png: rasterize the just-written SVG via headless Chrome @3x. Degrades gracefully.
  if (png) {
    const pngOut = outFile!.replace(/\.svg$/i, "") + ".png";
    const r = rasterizeFile(outFile!, pngOut, geo.width, geo.height, 3);
    if (r.ok) console.log(`wrote ${pngOut}: ${geo.width * 3}x${geo.height * 3} (@3x)`);
    else console.error(`⚠ PNG skipped (${r.reason}); ${outFile} written`);
  }
}

// The exported node's own layer name — the readable half of the generated component name.
// Read from the index rather than taken as a flag so the name matches what codegen would have
// derived for the same node, character for character.
function nodeName(guidKey: string): string {
  return index.byKey.get(guidKey)?.name ?? "";
}
