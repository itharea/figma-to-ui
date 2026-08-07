// Report (and optionally materialise) the published-library `assetRef` → local-guid
// re-addressing that `figma-index.load()` already applies to every decode.
//
// The rewrite itself is unconditional and lives in lib/assetref-lib.mts, so this script is
// NOT a required pipeline step — nothing downstream is waiting on its output. It exists to
// DIAGNOSE an export: how many local assets are published by key, which binding sites were
// addressed by `assetRef`, and which keys name an asset that is not in the file (those are
// genuinely external and stay unresolved — the harness never invents a target for them).
// A large rewrite count means the file subscribes to its own published library; zero means
// it addresses by guid and the pass was a no-op.
//
// Writing <out.json> is optional and only useful for handing a normalised message to
// something outside this harness.
//
//   node cli/normalize-assetrefs.mts <msg.json> [out.json]
import * as fs from "fs";
import { load } from "../lib/figma-index.mts";

const [, , inPath, outPath] = process.argv;
if (!inPath) {
  console.error("usage: normalize-assetrefs.mts <msg.json> [out.json]");
  process.exit(1);
}

const { msg, assetRefs } = load(inPath);

console.log(`keyed local assets: ${assetRefs.keyedAssets}`);
console.log(`assetRef → guid rewrites: ${assetRefs.rewrites}`);
for (const [field, count] of Object.entries(assetRefs.byField).sort((a, b) => b[1] - a[1]))
  console.log(`  ${count}\t${field}`);

const unresolved = Object.entries(assetRefs.unresolved);
if (unresolved.length) {
  const total = unresolved.reduce((a, [, c]) => a + c, 0);
  console.log(`unresolved keys: ${unresolved.length} (${total} refs) — left as-is`);
  // Asset keys are long hashes; 16 chars is plenty to correlate one against the file.
  for (const [k, count] of unresolved.sort((a, b) => b[1] - a[1]))
    console.log(`  ${count}\t${k.length > 16 ? k.slice(0, 16) + "…" : k}`);
}

if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(msg));
  console.log(`wrote ${outPath}`);
}
