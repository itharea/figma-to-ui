// Brownfield token mapping (P0-4 / P2-6): map fig values to an EXISTING code
// theme BY VALUE, never by name, and WITHIN each value's domain (kind) only — a
// 16px font size never matches a 16px gap. Output is an annotation table:
// exact / nearest(Δ) / none. It NEVER emits a rewrite; none/nearest rows are the
// "ask, don't overwrite" list (respect intentional divergence).
//
// Usage: node match-tokens.mts <message.json> <theme.(ts|json)> [guidKey]
//   - guidKey (optional) scopes the value collection to that node's subtree.
//
// Kind tagging from the fig field each value came from:
//   fillPaints/strokePaints color → color; fontSize → fontSize;
//   stackSpacing / stack*Padding → spacing; strokeWeight → strokeWidth;
//   cornerRadius / rectangle*CornerRadius → radius; size.x/y → other.
import { load, key, colorStr } from "./lib.mts";
import { loadTheme, matchTokenByValue, type ThemeKind } from "./tokens-lib.mts";

const argv = process.argv;
const msgPath = argv[2];
const themePath = argv[3];
if (!msgPath || !themePath)
  throw new Error("usage: match-tokens.mts <message.json> <theme.(ts|json)> [guidKey]");
const scope = argv[4]; // optional subtree guidKey

const index = load(msgPath);
const { byKey, children } = index;
const theme = loadTheme(themePath);

// distinct value per (kind,value), remembering one example fig source for context
type Use = { kind: ThemeKind; value: string };
const seen = new Map<string, Use>(); // `${kind}|${value}` → Use
const add = (kind: ThemeKind, value: string | undefined | null) => {
  if (value === undefined || value === null || value === "") return;
  seen.set(`${kind}|${value}`, { kind, value });
};

const PADDING_RE = /^stack(Horizontal|Vertical)Padding$|^stackPadding(Top|Right|Bottom|Left)$/;
const RADIUS_RE = /^rectangle(TopLeft|TopRight|BottomLeft|BottomRight)CornerRadius$/;

function collect(n: any) {
  for (const p of n.fillPaints ?? []) if (p?.color && p.visible !== false) add("color", colorStr(p.color));
  for (const p of n.strokePaints ?? []) if (p?.color && p.visible !== false) add("color", colorStr(p.color));
  if (n.fontSize !== undefined) add("fontSize", `${n.fontSize}px`);
  if (n.stackSpacing !== undefined) add("spacing", `${n.stackSpacing}px`);
  if (n.strokeWeight !== undefined && n.strokeWeight > 0) add("strokeWidth", `${n.strokeWeight}px`);
  if (n.cornerRadius !== undefined) add("radius", `${n.cornerRadius}px`);
  for (const f of Object.keys(n)) {
    if (PADDING_RE.test(f) && n[f] !== undefined) add("spacing", `${n[f]}px`);
    if (RADIUS_RE.test(f) && n[f] !== undefined) add("radius", `${n[f]}px`);
  }
  if (n.size) {
    add("other", `${Math.round(n.size.x)}px`);
    add("other", `${Math.round(n.size.y)}px`);
  }
}

if (scope) {
  const root = byKey.get(scope);
  if (!root) throw new Error(`scope node not found: ${scope}`);
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    collect(n);
    for (const c of children.get(key(n.guid)) ?? []) stack.push(c);
  }
} else {
  for (const n of index.nodes) collect(n);
}

// strip the trailing "px" for numeric value matching but keep it for display
const numeric = (v: string) => v.replace(/px$/, "");

const KIND_ORDER: ThemeKind[] = ["color", "fontSize", "spacing", "radius", "strokeWidth", "other"];
const rows = [...seen.values()].sort(
  (a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.value.localeCompare(b.value, undefined, { numeric: true })
);

const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));

for (const { kind, value } of rows) {
  const matchVal = kind === "color" ? value : numeric(value);
  const r = matchTokenByValue(matchVal, theme, kind);
  let rhs: string;
  if (r.match === "exact") rhs = `→ theme.${r.token}`;
  else if (r.match === "nearest")
    rhs = `→ NO EXACT MATCH (nearest ${r.token}, Δ${r.delta})`;
  else rhs = r.delta !== undefined ? `→ NO MATCH (closest Δ${r.delta})` : "→ NO MATCH";
  const tag =
    r.match === "exact" ? "[exact]" : r.match === "nearest" ? "[nearest]" : "[none → human decision]";
  console.log(`${pad(kind, 12)} ${pad(value, 9)} ${pad(rhs, 52)} ${tag}`);
}
