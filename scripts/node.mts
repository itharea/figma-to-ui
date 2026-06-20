// Raw single-node inspector (the IR-PLAN "Phase 0, ship first" escape hatch).
// Print one raw node's full JSON, or just a projection of named top-level fields.
// This is the documented way to CONFIRM a field name exists before any later
// phase relies on it (see specs/README field-name caveat).
// Usage: node node.mts <message.json> <guidKey> [field …]
//   node node.mts msg.json 1273:19842
//   node node.mts msg.json 1273:19842 fontSize lineHeight textAutoResize size
import { load } from "./lib.mts";

const { byKey } = load(process.argv[2]);
const target = process.argv[3];
if (!target) throw new Error("usage: node.mts <message.json> <guidKey> [field …]");
const node = byKey.get(target);
if (!node) throw new Error(`node not found: ${target}`);

const fields = process.argv.slice(4);
let out: any = node;
if (fields.length) {
  out = {};
  for (const f of fields) out[f] = node[f];
}
console.log(JSON.stringify(out, null, 2));
