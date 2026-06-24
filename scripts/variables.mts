// Dump Figma variables (design tokens) — the canonical token source when the
// file uses them. Groups by variable set; prints each mode's value with alias
// chains resolved transitively to a concrete value (P2-1): an aliased entry
// prints `→ 18 (alias Numbers/18)` instead of a bare `alias→753:1665` dead-end.
// Usage: node variables.mts <message.json>
import { load, key } from "./lib.mts";
import { resolveVariables } from "./tokens-lib.mts";

const index = load(process.argv[2]);
const { nodes } = index;

const sets = nodes.filter((n: any) => n.type === "VARIABLE_SET" && !n.isSoftDeleted);
for (const s of sets) {
  const modes = (s.variableSetModes ?? []).map((m: any) => `${m.id?.sessionID}:${m.id?.localID}=${m.name}`);
  console.log(`SET "${s.name}" [${key(s.guid)}] modes=[${modes.join(", ")}]`);
}

for (const t of resolveVariables(index)) {
  const entries = Object.entries(t.modes).map(([mode, value]) => {
    const alias = t.aliasOf?.[mode];
    return `${mode} → ${value}${alias ? ` (alias ${alias})` : ""}`;
  });
  console.log(`  ${t.type} "${t.name}" [set ${t.setName}]  ${entries.join("  |  ")}`);
}
