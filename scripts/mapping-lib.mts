// IR token mapping + intent/issues aggregation (Phase 8 / IR-PLAN Phase 3). NO
// top-level side effects — build-ir.mts imports these at build time. MAPPING by
// value is exact and always runs (matchTokenByValue is pure); the labeled
// `nearest(Δ)`/`placeholder` flags are informational (surfaced as scaffold // TODO
// notes, never a gate). Reuses the deterministic predicates verbatim (principle #2):
// placeholder via reconcile-lib, denylist/repeated/mono-icon via intent-lib,
// default-variant via components-lib — NO re-implementation.
import { load, key } from "./lib.mts";
import { matchTokenByValue, type ThemeEntry, type ThemeKind, type Token } from "./tokens-lib.mts";
import { classifyPlaceholderText } from "./reconcile-lib.mts";
import { isDenylistedText, repeatedStrings, isMonoColorIconFill } from "./intent-lib.mts";
import { findComponentSets, parseVariantMatrix } from "./components-lib.mts";
import type { IRNode } from "./screens-lib.mts";
import type { ResolvedNode } from "./resolve-lib.mts";

// Canonicalize a value the SAME way for a token key and an IR value, so a
// `kind:value` key reliably matches (value normalization): hex →
// lower-case 6-digit `#rrggbb`; numbers → bare, unit-less. `kind` namespaces the
// key so fontSize:16 ≠ spacing:16.
export function canonValue(value: string): string {
  const s = String(value).trim();
  const hx = /^#?([0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?)$/.exec(s);
  if (hx) {
    let h = hx[1].toLowerCase();
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length === 8) h = h.slice(0, 6); // drop alpha for the key
    return "#" + h;
  }
  const px = /^(-?\d+(?:\.\d+)?)\s*px$/.exec(s);
  if (px) return px[1];
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return s;
  return s;
}
export const decisionKey = (kind: ThemeKind, value: string): string =>
  `${kind}:${canonValue(value)}`;

// --- token mapping over the IR (pass 5 §6a) ---------------------------------
// Map each IR value to a code token BY VALUE, WITHIN ITS OWN KIND. A paint →
// color.{token,match}; a text node's font.size → font.{sizeToken,sizeMatch}.
// tokenConfirms upgrades a nearest/none to a confirmed exact. Never name-match,
// never cross kinds.
export function mapNodeTokens(
  node: IRNode,
  theme: ThemeEntry[],
  confirms: Record<string, string>,
  rejects: Set<string>,
): void {
  // A color BOUND to a Figma variable (match:"bound", var!=null) is GROUND TRUTH
  // from the bytes — value-matching applies to UNBOUND literals only, so never
  // clobber a bound color's token/match (A-variables / spec #3).
  if (node.color && node.color.hex && node.color.var == null) {
    apply(node.color, theme, "color", node.color.hex, confirms, rejects, "token", "match");
  }
  if (node.font && typeof node.font.size === "number") {
    apply(
      node.font,
      theme,
      "fontSize",
      String(node.font.size),
      confirms,
      rejects,
      "sizeToken",
      "sizeMatch",
    );
  }
  for (const c of node.children) mapNodeTokens(c, theme, confirms, rejects);
}

// Resolve one value→token field-pair on an object, folding tokenConfirms/Rejects.
function apply(
  obj: any,
  theme: ThemeEntry[],
  kind: ThemeKind,
  value: string,
  confirms: Record<string, string>,
  rejects: Set<string>,
  tokenField: string,
  matchField: string,
): void {
  const dk = decisionKey(kind, value);
  if (dk in confirms) {
    obj[tokenField] = confirms[dk];
    obj[matchField] = "exact"; // human said "yes, same token"
    return;
  }
  const m = matchTokenByValue(value, theme, kind);
  if (m.match === "exact") {
    obj[tokenField] = m.token ?? null;
    obj[matchField] = "exact";
  } else if (m.match === "nearest") {
    obj[tokenField] = m.token ?? null;
    obj[matchField] = `nearest(${m.delta})`;
  } else {
    obj[tokenField] = null;
    // a rejected value is a deliberate literal — label it so issues.json suppresses
    obj[matchField] = rejects.has(dk) ? "rejected" : "none";
  }
}

// --- intent.json aggregation over a RESOLVED screen (pass 6 §6b) ------------
// The per-build version of intent.mts: SAME predicates over the resolved tree,
// not a re-implementation. Returns the items for ONE screen; the caller merges
// across all scoped screens. `defaultVariant` maps a variant SYMBOL guid → label.
export type IntentItem = {
  kind: "placeholder" | "denylist" | "repeated" | "reconcile" | "default-variant" | "mono-icon";
  screen: string;
  guid: string;
  path: string;
  name: string;
  detail: string;
};

export function buildDefaultVariantMap(index: ReturnType<typeof load>): Map<string, string> {
  const dv = new Map<string, string>();
  for (const set of findComponentSets(index)) {
    const { axes } = parseVariantMatrix(set);
    const axisNames = Object.keys(axes);
    if (!axisNames.length) continue;
    const def = set.variants.find((v) =>
      axisNames.every((a) => (axes[a][0] !== undefined ? v.props[a] === axes[a][0] : true)),
    );
    if (def) dv.set(def.guid, `${set.name} / ${def.rawName}`);
  }
  return dv;
}

export function aggregateScreenIntent(
  root: ResolvedNode,
  screenLabel: string,
  defaultVariant: Map<string, string>,
): IntentItem[] {
  const items: IntentItem[] = [];
  // repeated-string scan over THIS screen's resolved text (intent-lib)
  const texts: string[] = [];
  (function collect(n: ResolvedNode) {
    if (n.type === "TEXT") texts.push((n as any).textData?.characters ?? "");
    for (const c of n.children ?? []) collect(c);
  })(root);
  const repeats = repeatedStrings(texts);
  const at = (n: ResolvedNode) => (n as any).path ?? n.guid;

  (function walk(n: ResolvedNode) {
    const path = at(n);
    const guid = n.guid;
    if (n.type === "TEXT") {
      const chars: string = (n as any).textData?.characters ?? "";
      const cls = classifyPlaceholderText(
        chars,
        (n as any).hasTextOverride ?? false,
        (n as any).masterDefaultText,
      );
      if (cls.placeholder)
        items.push({
          kind: "placeholder",
          screen: screenLabel,
          guid,
          path,
          name: n.name,
          detail: `${JSON.stringify(chars)} — un-overridden master default (${cls.reason})`,
        });
      if (isDenylistedText(chars))
        items.push({
          kind: "denylist",
          screen: screenLabel,
          guid,
          path,
          name: n.name,
          detail: `${JSON.stringify(chars)} — looks like a stand-in string`,
        });
      else if ((repeats.get((chars ?? "").trim()) ?? 0) > 1 && (chars ?? "").trim())
        items.push({
          kind: "repeated",
          screen: screenLabel,
          guid,
          path,
          name: n.name,
          detail: `${JSON.stringify(chars)} appears ${repeats.get(chars.trim())}× on this screen`,
        });
      // reconciliation conflicts come from the EMITTED IR node's font.conflicts
      // (collectConflictItems) — not recomputed here.
    }
    const sid = (n as any).symbolData?.symbolID;
    if (sid) {
      const label = defaultVariant.get(key(sid));
      if (label)
        items.push({
          kind: "default-variant",
          screen: screenLabel,
          guid,
          path,
          name: n.name,
          detail: `→ ${label} — instance targets the default variant`,
        });
    }
    if (isMonoColorIconFill(n))
      items.push({
        kind: "mono-icon",
        screen: screenLabel,
        guid,
        path,
        name: n.name,
        detail: `pure white/black fill — likely recolor-in-consumer`,
      });
    for (const c of n.children ?? []) walk(c);
  })(root);
  return items;
}

// Reconciliation conflicts are read from the EMITTED IR node's already-computed
// font.conflicts (Phase 7 emits them) — do not recompute. Walk the IR screen.
export function collectConflictItems(node: IRNode, screenLabel: string): IntentItem[] {
  const out: IntentItem[] = [];
  (function walk(n: IRNode) {
    const conf = n.font?.conflicts ?? [];
    for (const c of conf)
      out.push({
        kind: "reconcile",
        screen: screenLabel,
        guid: n.guid,
        path: n.path,
        name: n.name,
        detail: `${c.field} ${c.declared}→~${c.chosen} (box.y=${c.boxY} can't fit lh=${c.lhPx}) — ${c.reason}`,
      });
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

// --- token name-collision trap (the praline-ramp trap, §6b issues.json) -----
// A fig variable whose LEAF name matches a theme entry's leaf name but whose
// VALUE differs. By-value matching must NOT silently bind them; surface it.
const leafName = (p: string): string => p.split(/[./]/).pop()?.toLowerCase() ?? p.toLowerCase();
export type NameCollision = {
  figToken: string;
  figValue: string;
  themeToken: string;
  themeValue: string;
  leaf: string;
};
export function fontTokenCollisions(figTokens: Token[], theme: ThemeEntry[]): NameCollision[] {
  const out: NameCollision[] = [];
  const byLeaf = new Map<string, ThemeEntry[]>();
  for (const e of theme) {
    const l = leafName(e.path);
    (byLeaf.get(l) ?? byLeaf.set(l, []).get(l))!.push(e);
  }
  for (const t of figTokens) {
    const l = leafName(t.name);
    const cands = byLeaf.get(l);
    if (!cands) continue;
    // compare against each mode's concrete value
    for (const v of Object.values(t.modes)) {
      const cv = canonValue(v);
      for (const e of cands) {
        const ev = canonValue(e.value);
        if (cv !== ev)
          out.push({ figToken: t.name, figValue: cv, themeToken: e.path, themeValue: ev, leaf: l });
      }
    }
  }
  return out;
}
