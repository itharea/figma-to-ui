// List Figma component sets with their variant masters and a proposed TS prop API.
// Usage: node components.mts <message.json> [nameRegex]
//   node components.mts msg.json Header
import { load } from "./lib.mts";
import {
  findComponentSets,
  parseVariantMatrix,
  proposePropApi,
} from "./components-lib.mts";

const index = load(process.argv[2]);
const filter = process.argv[3] ? new RegExp(process.argv[3], "i") : null;

const sets = findComponentSets(index).filter((s) => !filter || filter.test(s.name));
if (!sets.length) console.error("(no component sets matched)");

for (const set of sets) {
  console.log(
    `${set.name}  (set ${set.guid})  [${set.detectedBy}, ${set.confidence}]`
  );
  const w = Math.max(0, ...set.variants.map((v) => v.rawName.length));
  for (const v of set.variants) {
    const sz = v.size ? `${Math.round(v.size.x)}x${Math.round(v.size.y)}` : "";
    console.log(`  ${v.rawName.padEnd(w)}   ${v.guid}   ${sz}`);
  }
  const api = proposePropApi(parseVariantMatrix(set));
  if (api) console.log(`  → ${api}`);
}
