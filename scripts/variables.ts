// Dump Figma variables (design tokens) — the canonical token source when the
// file uses them. Groups by variable set; prints each mode's value.
// Usage: node variables.ts <message.json>
import { load, key, colorStr } from "./lib.ts";

const { nodes, byKey } = load(process.argv[2]);

const sets = nodes.filter((n: any) => n.type === "VARIABLE_SET");
for (const s of sets) {
  const modes = (s.variableSetModes ?? []).map((m: any) => `${m.id?.sessionID}:${m.id?.localID}=${m.name}`);
  console.log(`SET "${s.name}" [${key(s.guid)}] modes=[${modes.join(", ")}]`);
}

function valueStr(vd: any): string {
  const v = vd?.value;
  if (!v) return JSON.stringify(vd);
  if (v.colorValue) return colorStr(v.colorValue);
  if (v.floatValue !== undefined) return String(v.floatValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.textValue !== undefined) return JSON.stringify(v.textValue);
  if (v.alias) return `alias→${key(v.alias.guid ?? v.alias)}`;
  return JSON.stringify(v);
}

for (const n of nodes) {
  if (n.type !== "VARIABLE") continue;
  const setKey = n.variableSetID ? key(n.variableSetID.guid) : "?";
  const entries = (n.variableDataValues?.entries ?? []).map(
    (e: any) => `mode ${e.modeID?.sessionID}:${e.modeID?.localID} → ${valueStr(e.variableData)}`
  );
  console.log(`  ${n.variableResolvedType} "${n.name}" [set ${setKey}]  ${entries.join("  |  ")}`);
}
