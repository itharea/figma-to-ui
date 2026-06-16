// Shared node-graph index for decoded .fig messages.
// Every script takes the path to message.json (produced by parse.mts) as argv[2].
import * as fs from "fs";

export const key = (g: any) => `${g.sessionID}:${g.localID}`;

export function load(messagePath: string) {
  if (!messagePath) throw new Error("missing message.json path argument");
  const msg = JSON.parse(fs.readFileSync(messagePath, "utf8"));
  const nodes: any[] = msg.nodeChanges ?? [];
  const byKey = new Map<string, any>();
  for (const n of nodes) byKey.set(key(n.guid), n);
  const children = new Map<string, any[]>();
  for (const n of nodes) {
    if (!n.parentIndex) continue;
    const pk = key(n.parentIndex.guid);
    if (!children.has(pk)) children.set(pk, []);
    children.get(pk)!.push(n);
  }
  for (const arr of children.values())
    arr.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : 1));
  return { msg, nodes, byKey, children };
}

export function colorStr(c: any): string {
  if (!c) return "";
  const h = (v: number) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a !== undefined && c.a < 1 ? h(c.a) : ""}`;
}
