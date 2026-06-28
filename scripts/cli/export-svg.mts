// Export a vector node (logo, illustration, custom icon) as an SVG file.
// Geometry extraction lives in svg-lib.mts (shared with codegen's internal icon export).
// Usage: node export-svg.mts <message.json> <guidKey> <out.svg> [--png] [--recolor=currentColor]
import * as fs from "fs";
import { rasterizeFile } from "../lib/raster-lib.mts";
import { load } from "../lib/figma-index.mts";
import { extractGeometry, toSvgString } from "../lib/svg-lib.mts";

const index = load(process.argv[2]);
const png = process.argv.includes("--png");
const recolor: "preserve" | "currentColor" = process.argv.includes("--recolor=currentColor")
  ? "currentColor"
  : "preserve";
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
const target = positional[0];
const outFile = positional[1];
if (!target || !outFile)
  throw new Error(
    "usage: export-svg.mts <message.json> <guidKey> <out.svg> [--png] [--recolor=currentColor]",
  );

const geo = extractGeometry(index, target);
const svg = toSvgString(geo, { recolor });
fs.writeFileSync(outFile, svg);
console.log(
  `wrote ${outFile}: ${geo.width}x${geo.height}, ${geo.paths.length} paths, ${(svg.length / 1024).toFixed(1)}KB`,
);

// --png: rasterize the just-written SVG via headless Chrome @3x. Degrades gracefully.
if (png) {
  const pngOut = outFile.replace(/\.svg$/i, "") + ".png";
  const r = rasterizeFile(outFile, pngOut, geo.width, geo.height, 3);
  if (r.ok) console.log(`wrote ${pngOut}: ${geo.width * 3}x${geo.height * 3} (@3x)`);
  else console.error(`⚠ PNG skipped (${r.reason}); ${outFile} written`);
}
