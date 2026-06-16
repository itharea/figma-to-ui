// Dump a node's subtree as one line per node: type, name, size, position,
// fills/strokes, radius, auto-layout, font, text, effects. This dump is the
// per-screen implementation artifact — complete and unambiguous.
// Usage: node dump.mts <message.json> <guidKey> [maxDepth]
// (guidKey like "735:14256" — get it from tree.mts or find.mts)
import { load, key, colorStr } from "./lib.mts";

const { byKey, children } = load(process.argv[2]);
const target = process.argv[3];
const maxDepth = parseInt(process.argv[4] ?? "99", 10);
if (!target) throw new Error("usage: dump.mts <message.json> <guidKey> [maxDepth]");

function paintStr(p: any): string {
  if (!p) return "";
  if (p.type === "SOLID") return `solid ${colorStr(p.color)}${p.opacity !== undefined && p.opacity < 1 ? ` op=${p.opacity.toFixed(2)}` : ""}`;
  if (p.type === "IMAGE") return `image hash=${p.image?.hash ? Buffer.from(p.image.hash).toString("hex") : p.image?.name ?? "?"} mode=${p.imageScaleMode ?? ""}`;
  if (p.type?.startsWith("GRADIENT")) {
    const stops = (p.stops ?? []).map((s: any) => `${colorStr(s.color)}@${s.position?.toFixed(2)}`).join(",");
    return `${p.type} [${stops}]`;
  }
  return p.type;
}

function describe(n: any): string {
  const bits: string[] = [];
  bits.push(`${n.type}${n.visible === false ? "(HIDDEN)" : ""} "${n.name}"`);
  if (n.size) bits.push(`${Math.round(n.size.x)}x${Math.round(n.size.y)}`);
  if (n.transform) bits.push(`@(${Math.round(n.transform.m02)},${Math.round(n.transform.m12)})`);
  if (n.fillPaints?.length) bits.push(`fill[${n.fillPaints.filter((p: any) => p.visible !== false).map(paintStr).join("; ")}]`);
  if (n.strokePaints?.length) bits.push(`stroke[${n.strokePaints.filter((p: any) => p.visible !== false).map(paintStr).join("; ")} w=${n.strokeWeight ?? 1}]`);
  if (n.cornerRadius) bits.push(`r=${n.cornerRadius}`);
  if (n.rectangleTopLeftCornerRadius !== undefined)
    bits.push(`r=[${n.rectangleTopLeftCornerRadius},${n.rectangleTopRightCornerRadius},${n.rectangleBottomRightCornerRadius},${n.rectangleBottomLeftCornerRadius}]`);
  if (n.stackMode && n.stackMode !== "NONE") {
    bits.push(`autolayout=${n.stackMode} gap=${n.stackSpacing ?? 0} pad[t,l,b,r]=[${n.stackVerticalPadding ?? 0},${n.stackHorizontalPadding ?? 0},${n.stackPaddingBottom ?? 0},${n.stackPaddingRight ?? 0}] align=${n.stackPrimaryAlignItems ?? ""}/${n.stackCounterAlignItems ?? ""}`);
  }
  if (n.fontName) bits.push(`font=${n.fontName.family} ${n.fontName.style} ${n.fontSize}px ls=${n.letterSpacing?.value ?? 0} lh=${n.lineHeight?.value !== undefined ? n.lineHeight.value + (n.lineHeight.units === "PERCENT" ? "%" : "px") : "auto"}`);
  if (n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT") bits.push(`align=${n.textAlignHorizontal}`);
  if (n.type === "TEXT") {
    const chars = n.textData?.characters ?? "";
    bits.push(`text=${JSON.stringify(chars.length > 120 ? chars.slice(0, 120) + "…" : chars)}`);
  }
  if (n.effects?.length) bits.push(`effects=[${n.effects.map((e: any) => `${e.type} ${colorStr(e.color)} off=(${e.offset?.x ?? 0},${e.offset?.y ?? 0}) blur=${e.radius}`).join("; ")}]`);
  if (n.opacity !== undefined && n.opacity < 1) bits.push(`opacity=${n.opacity.toFixed(2)}`);
  if (n.symbolData?.symbolID) bits.push(`instanceOf=${key(n.symbolData.symbolID)}`);
  if (n.componentKey) bits.push(`componentKey=${n.componentKey}`);
  return bits.join(" ");
}

function walk(k: string, depth: number, prefix: string) {
  const n = byKey.get(k);
  if (!n) return;
  console.log(prefix + describe(n) + ` [${k}]`);
  if (depth >= maxDepth) return;
  for (const c of children.get(k) ?? []) {
    if (c.visible === false) continue;
    walk(key(c.guid), depth + 1, prefix + "  ");
  }
}

walk(target, 0, "");
