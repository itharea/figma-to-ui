// One-line node formatter, extracted from dump.mts so both dump.mts and
// resolve.mts share it. NO top-level side effects (CLI entry stays in the
// scripts that import this). The `abs` callback is injected because absCoords
// is raw-tree-only and meaningless for resolved-instance children (see lib.mts).
import { key, colorStr } from "./figma-index.mts";
import { letterSpacingStr, reconcileTextSize, classifyPlaceholderText } from "./reconcile-lib.mts";

export function paintStr(p: any): string {
  if (!p) return "";
  if (p.type === "SOLID")
    return `solid ${colorStr(p.color)}${p.opacity !== undefined && p.opacity < 1 ? ` op=${p.opacity.toFixed(2)}` : ""}`;
  if (p.type === "IMAGE")
    return `image hash=${p.image?.hash ? Buffer.from(p.image.hash).toString("hex") : (p.image?.name ?? "?")} mode=${p.imageScaleMode ?? ""}`;
  if (p.type?.startsWith("GRADIENT")) {
    const stops = (p.stops ?? [])
      .map((s: any) => `${colorStr(s.color)}@${s.position?.toFixed(2)}`)
      .join(",");
    return `${p.type} [${stops}]`;
  }
  return p.type;
}

export type DescribeOpts = {
  // raw-tree absolute coords; omit for resolved trees where it is meaningless.
  abs?: (n: any) => { absX: number; absY: number };
  // when true, TEXT nodes get a placeholder/override tag using the resolved
  // node's hasTextOverride + masterDefault (Phase 2 Task 2). Resolved trees set
  // these fields on the node; raw dumps leave them undefined → no tag.
  placeholderTag?: boolean;
};

export function describeNode(n: any, opts: DescribeOpts = {}): string {
  const bits: string[] = [];
  bits.push(`${n.type}${n.visible === false ? "(HIDDEN)" : ""} "${n.name}"`);
  if (n.size) bits.push(`${Math.round(n.size.x)}x${Math.round(n.size.y)}`);
  if (n.transform) {
    bits.push(`@(${Math.round(n.transform.m02)},${Math.round(n.transform.m12)})`);
    if (opts.abs) {
      const { absX, absY } = opts.abs(n);
      bits.push(`abs(${absX},${absY})`);
    }
  }
  if (n.fillPaints?.length)
    bits.push(
      `fill[${n.fillPaints
        .filter((p: any) => p.visible !== false)
        .map(paintStr)
        .join("; ")}]`,
    );
  if (n.strokePaints?.length)
    bits.push(
      `stroke[${n.strokePaints
        .filter((p: any) => p.visible !== false)
        .map(paintStr)
        .join("; ")} w=${n.strokeWeight ?? 1}]`,
    );
  if (n.cornerRadius) bits.push(`r=${n.cornerRadius}`);
  if (n.rectangleTopLeftCornerRadius !== undefined)
    bits.push(
      `r=[${n.rectangleTopLeftCornerRadius},${n.rectangleTopRightCornerRadius},${n.rectangleBottomRightCornerRadius},${n.rectangleBottomLeftCornerRadius}]`,
    );
  if (n.stackMode && n.stackMode !== "NONE") {
    bits.push(
      `autolayout=${n.stackMode} gap=${n.stackSpacing ?? 0} pad[t,l,b,r]=[${n.stackVerticalPadding ?? 0},${n.stackHorizontalPadding ?? 0},${n.stackPaddingBottom ?? 0},${n.stackPaddingRight ?? 0}] align=${n.stackPrimaryAlignItems ?? ""}/${n.stackCounterAlignItems ?? ""}`,
    );
  }
  if (n.fontName)
    bits.push(
      `font=${n.fontName.family} ${n.fontName.style} ${n.fontSize}px ls=${letterSpacingStr(n.letterSpacing, n.fontSize)} lh=${n.lineHeight?.value !== undefined ? n.lineHeight.value + (n.lineHeight.units === "PERCENT" ? "%" : "px") : "auto"}`,
    );
  if (n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT")
    bits.push(`align=${n.textAlignHorizontal}`);
  if (n.type === "TEXT") {
    if (n.textAutoResize) bits.push(`autoResize=${n.textAutoResize}`);
    if (n.textCase && n.textCase !== "ORIGINAL") bits.push(`case=${n.textCase}`);
    if (n.textAlignVertical && n.textAlignVertical !== "TOP")
      bits.push(`valign=${n.textAlignVertical}`);
    if (n.textTruncation && n.textTruncation !== "DISABLED")
      bits.push(`truncate=${n.textTruncation}`);
    if (n.leadingTrim && n.leadingTrim !== "NONE") bits.push(`leadingTrim=${n.leadingTrim}`);
    const rec = reconcileTextSize(n);
    for (const c of rec.conflicts)
      bits.push(`⚠ stale-style? box.y=${c.boxY} < lh=${c.lhPx} → size likely ~${c.chosen}`);
    const runs = n.textData?.styleOverrideTable?.length ?? 0;
    if (runs) bits.push(`⚠ ${runs} style runs — node-level font may not match`);
    const chars = n.textData?.characters ?? "";
    bits.push(`text=${JSON.stringify(chars.length > 120 ? chars.slice(0, 120) + "…" : chars)}`);
    if (opts.placeholderTag) {
      const cls = classifyPlaceholderText(chars, n.hasTextOverride ?? false, n.masterDefaultText);
      if (n.hasTextOverride) bits.push("[overridden]");
      else if (cls.placeholder) bits.push("[MASTER DEFAULT ⚠ likely placeholder]");
    }
  }
  if (n.effects?.length)
    bits.push(
      `effects=[${n.effects.map((e: any) => `${e.type} ${colorStr(e.color)} off=(${e.offset?.x ?? 0},${e.offset?.y ?? 0}) blur=${e.radius}`).join("; ")}]`,
    );
  if (n.opacity !== undefined && n.opacity < 1) bits.push(`opacity=${n.opacity.toFixed(2)}`);
  // In a RESOLVED tree the instance's master subtree is composed in as children,
  // so `instanceOf=` would read like a dead-end (AC3) when it is really a label.
  // Show it only when the node is NOT composed (raw dump, remote/unresolved
  // master, or a genuinely childless instance). Resolved nodes carry `path`.
  const composed =
    n.path !== undefined && Array.isArray(n.children) && n.children.length > 0 && !n.unresolved;
  if (n.symbolData?.symbolID && !composed) bits.push(`instanceOf=${key(n.symbolData.symbolID)}`);
  if (n.componentKey) bits.push(`componentKey=${n.componentKey}`);
  return bits.join(" ");
}
