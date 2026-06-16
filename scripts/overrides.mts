// Print symbolOverrides for every INSTANCE in a node's subtree — this is
// where per-instance text/colors live (instances have no children in the tree).
// Usage: node overrides.mts <message.json> <guidKey>
import { load, key, colorStr } from "./lib.mts";

const { byKey, children } = load(process.argv[2]);
const target = process.argv[3];
if (!target) throw new Error("usage: overrides.mts <message.json> <guidKey>");

function summarizeOverride(o: any): string {
  const bits: string[] = [];
  const path = (o.guidPath?.guids ?? []).map((g: any) => `${g.sessionID}:${g.localID}`).join("/");
  bits.push(`path=${path}`);
  if (o.textData?.characters !== undefined) bits.push(`text=${JSON.stringify(o.textData.characters)}`);
  if (o.fillPaints) bits.push(`fills=${o.fillPaints.map((p: any) => (p.type === "SOLID" ? colorStr(p.color) : p.type)).join(",")}`);
  if (o.strokePaints) bits.push(`strokes=${o.strokePaints.map((p: any) => (p.type === "SOLID" ? colorStr(p.color) : p.type)).join(",")}`);
  if (o.fontName) bits.push(`font=${o.fontName.family} ${o.fontName.style}`);
  if (o.fontSize) bits.push(`size=${o.fontSize}`);
  if (o.visible !== undefined) bits.push(`visible=${o.visible}`);
  if (o.size) bits.push(`sz=${Math.round(o.size.x)}x${Math.round(o.size.y)}`);
  const known = new Set(["guidPath", "textData", "fillPaints", "strokePaints", "fontName", "fontSize", "visible", "size"]);
  const other = Object.keys(o).filter((k2) => !known.has(k2));
  if (other.length) bits.push(`other=[${other.join(",")}]`);
  return bits.join(" ");
}

function walk(k: string, depth: number) {
  const n = byKey.get(k);
  if (!n) return;
  if (n.symbolData) {
    const ovr = n.symbolData.symbolOverrides ?? [];
    console.log(`${"  ".repeat(depth)}${n.type} "${n.name}" [${k}] instanceOf=${key(n.symbolData.symbolID)}${ovr.length ? "" : "  (NO OVERRIDES — master placeholders shown as-is)"}`);
    for (const o of ovr) console.log(`${"  ".repeat(depth + 1)}- ${summarizeOverride(o)}`);
  }
  for (const c of children.get(k) ?? []) walk(key(c.guid), depth + 1);
}

walk(target, 0);
