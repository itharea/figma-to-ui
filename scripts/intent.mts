// Designer-intent gap report (P2-5): walk a RESOLVED screen and emit one flat,
// copy-pasteable "to-ask" checklist of things to confirm before shipping. Thin
// walker — every predicate comes from a lib (principle #2): placeholder +
// reconciliation from reconcile-lib, default-variant from components-lib, the
// denylist/repeated-string + mono-color-icon checks from intent-lib.
//
// Usage: node intent.mts <message.json> <screen-guidKey>
import { load, key } from "./lib.mts";
import { resolveScreen, type ResolvedNode } from "./resolve-lib.mts";
import { reconcileTextSize, classifyPlaceholderText } from "./reconcile-lib.mts";
import { findComponentSets, parseVariantMatrix } from "./components-lib.mts";
import { isDenylistedText, repeatedStrings, isMonoColorIconFill } from "./intent-lib.mts";

const msgPath = process.argv[2];
const screen = process.argv[3];
if (!msgPath || !screen) throw new Error("usage: intent.mts <message.json> <screen-guidKey>");

const index = load(msgPath);
const root = resolveScreen(index, screen);

// --- default-variant map (components-lib; no re-derivation here) -------------
// For each component set, the default variant is the SYMBOL whose props match the
// FIRST value of every axis (Figma's variant default — confirmed against the
// decode via stateGroupPropertyValueOrders[].values[0]). Map masterGuid → label
// for the default variant so we can flag instances pinned to it.
const defaultVariant = new Map<string, string>(); // variant guid → "Set / Version=Default"
for (const set of findComponentSets(index)) {
  const { axes } = parseVariantMatrix(set);
  const axisNames = Object.keys(axes);
  if (!axisNames.length) continue;
  const def = set.variants.find((v) =>
    axisNames.every((a) => (axes[a][0] !== undefined ? v.props[a] === axes[a][0] : true))
  );
  if (def) defaultVariant.set(def.guid, `${set.name} / ${def.rawName}`);
}

// Collect all resolved TEXT strings up front for the repeated-string check.
const allTexts: string[] = [];
(function collect(n: ResolvedNode) {
  if (n.type === "TEXT") allTexts.push((n as any).textData?.characters ?? "");
  for (const c of n.children ?? []) collect(c);
})(root);
const repeats = repeatedStrings(allTexts);

type Item = { kind: string; line: string };
const items: Item[] = [];
const seen = new Set<string>(); // dedupe identical lines

function add(kind: string, line: string) {
  const sig = kind + "|" + line;
  if (seen.has(sig)) return;
  seen.add(sig);
  items.push({ kind, line });
}

function walk(n: ResolvedNode) {
  const at = (n as any).path ?? n.guid;

  // 1. placeholder master-default text (resolver override-presence + classifier)
  if (n.type === "TEXT") {
    const chars = (n as any).textData?.characters ?? "";
    const cls = classifyPlaceholderText(chars, (n as any).hasTextOverride ?? false, (n as any).masterDefaultText);
    if (cls.placeholder)
      add("placeholder", `[PLACEHOLDER] ${n.name}: ${JSON.stringify(chars)} — un-overridden master default (${cls.reason}) @ ${at}`);

    // 2. denylisted / repeated placeholder strings (intent-lib)
    if (isDenylistedText(chars))
      add("denylist", `[DENYLIST] ${n.name}: ${JSON.stringify(chars)} — looks like a stand-in string @ ${at}`);
    else if ((repeats.get((chars ?? "").trim()) ?? 0) > 1 && (chars ?? "").trim())
      add("repeated", `[REPEATED] ${JSON.stringify(chars)} appears ${repeats.get(chars.trim())}× — confirm it is intentional, not duplicated placeholder`);

    // 3. geometry/fontSize reconciliation conflicts (reconcile-lib)
    const rec = reconcileTextSize(n as any);
    for (const c of rec.conflicts)
      add("reconcile", `[RECONCILE] ${n.name}: fontSize ${c.declared}→~${c.chosen} (box.y=${c.boxY} can't fit lh=${c.lhPx}) — confirm size @ ${at}`);
  }

  // 4. instance pinned to the DEFAULT variant. In this file a variant choice IS
  //    the symbolData.symbolID the instance targets (each variant is a distinct
  //    SYMBOL; confirmed against the decode — there is no separate per-axis
  //    override, only componentPropAssignments for BOOL/TEXT props). So an
  //    instance whose symbolID is the set's default-variant SYMBOL is pinned to
  //    the default unless a componentPropAssignment deliberately re-selects it.
  const sid = (n as any).symbolData?.symbolID;
  if (sid) {
    const label = defaultVariant.get(key(sid));
    if (label)
      add("default-variant", `[DEFAULT VARIANT] ${n.name} → ${label} — instance targets the default variant; confirm the intended variant @ ${at}`);
  }

  // 5. pure #ffffff/#000000 icon fills (recolor-in-consumer) — intent-lib
  if (isMonoColorIconFill(n))
    add("mono-icon", `[MONO ICON] ${n.name}: pure white/black fill — likely recolor-in-consumer, not a literal color @ ${at}`);

  for (const c of n.children ?? []) walk(c);
}
walk(root);

// --- output: grouped, flat, copy-pasteable ----------------------------------
console.log(`# intent gaps for ${root.name} [${screen}] — confirm before shipping`);
console.log(`# ${items.length} item(s). Each line is a thing to ASK; none is silently resolved.`);
const order = ["placeholder", "denylist", "repeated", "reconcile", "default-variant", "mono-icon"];
const titles: Record<string, string> = {
  placeholder: "Un-overridden placeholder text",
  denylist: "Stand-in / denylisted strings",
  repeated: "Repeated strings (possible duplicated placeholder)",
  reconcile: "Geometry/fontSize reconciliation conflicts",
  "default-variant": "Instances pinned to the default variant",
  "mono-icon": "Mono-color icon fills (recolor in consumer)",
};
for (const k of order) {
  const group = items.filter((i) => i.kind === k);
  if (!group.length) continue;
  console.log(`\n## ${titles[k]} (${group.length})`);
  for (const i of group) console.log(i.line);
}
if (!items.length) console.log("\n(no intent gaps detected — still eyeball the render)");
