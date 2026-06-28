// raw.mts — the raw query / verify multiplexer.
//
// Once the IR is compiled (build-ir.mts), its per-screen JSON is the reading
// surface. These subcommands are the IR-superseded RAW PATH: the quick query
// before an IR exists, the field-confirmation escape hatch, and the verifier
// the IR is checked against. They read the decoded message.json (not the IR),
// so they stay the ground-truth printers the IR never replaces — only the
// reading default moves to the IR.
//
// Usage: node raw.mts <cmd> <args…>
//   dump        <message.json> <guidKey> [maxDepth] [--abs] [--resolve]
//   resolve     <message.json> <guidKey> [maxDepth]
//   overrides   <message.json> <guidKey> [--full]
//   variables   <message.json>
//   components   <message.json> [nameRegex]
//   intent      <message.json> <screen-guidKey>
//   match-tokens <message.json> <theme.(ts|json)> [guidKey]
//   diff-frames <message.json> <guidA> <guidB>
import { load, key, colorStr, absCoords } from "../lib/figma-index.mts";
import { describeNode } from "../lib/describe-lib.mts";
import { resolveScreen, type ResolvedNode } from "../lib/resolve-lib.mts";
import {
  letterSpacingStr,
  reconcileTextSize,
  classifyPlaceholderText,
} from "../lib/reconcile-lib.mts";
import { findComponentSets, parseVariantMatrix, proposePropApi } from "../lib/components-lib.mts";
import { isDenylistedText, repeatedStrings, isMonoColorIconFill } from "../lib/intent-lib.mts";
import {
  resolveVariables,
  loadTheme,
  matchTokenByValue,
  type ThemeKind,
} from "../lib/tokens-lib.mts";

// Each cmd takes a process.argv-shaped array where argv[2] is its first real arg
// (so the ported bodies keep their original argv[2]/argv[3]/slice(4) indexing).

// --- dump --------------------------------------------------------------------
function cmdDump(argv: string[]) {
  const abs = argv.includes("--abs"); // scan for the flag; keep maxDepth positional
  const resolve = argv.includes("--resolve"); // opt-in instance resolution (Phase 2 Task 2)
  const index = load(argv[2]);
  const { byKey, children } = index;
  const target = argv[3];
  const maxDepthArg = argv.slice(4).find((a) => !a.startsWith("--") && /^\d+$/.test(a));
  const maxDepth = parseInt(maxDepthArg ?? "99", 10);
  if (!target)
    throw new Error("usage: raw.mts dump <message.json> <guidKey> [maxDepth] [--abs] [--resolve]");

  const absFn = (n: any) => absCoords(byKey, key(n.guid));

  // Default fast path: raw tree, no resolution (the "raw tools stay" principle).
  function walk(k: string, depth: number, prefix: string) {
    const n = byKey.get(k);
    if (!n) return;
    console.log(prefix + describeNode(n, { abs: abs ? absFn : undefined }) + ` [${k}]`);
    if (depth >= maxDepth) return;
    for (const c of children.get(k) ?? []) {
      if (c.visible === false) continue;
      walk(key(c.guid), depth + 1, prefix + "  ");
    }
  }

  // --resolve: compose master + overrides, tag placeholder/overridden text.
  function walkResolved(n: ResolvedNode, depth: number, prefix: string) {
    if (depth > maxDepth) return;
    const tags: string[] = [];
    if (n.fromInstance) tags.push(`[from ${n.fromInstance}]`);
    if (n.overrideApplied) tags.push(`[overridden: ${Object.keys(n.overrideApplied).join(",")}]`);
    if (n.unresolved) tags.push(`⚠ unresolved (${n.unresolved})`);
    if (n.unresolvedOverrides?.length)
      tags.push(`⚠ stale overrides: ${n.unresolvedOverrides.join("; ")}`);
    console.log(
      prefix +
        describeNode(n as any, { placeholderTag: true }) +
        ` [${n.guid}]` +
        (tags.length ? " " + tags.join(" ") : ""),
    );
    for (const c of n.children ?? []) {
      if ((c as any).visible === false) continue;
      walkResolved(c, depth + 1, prefix + "  ");
    }
  }

  if (resolve) walkResolved(resolveScreen(index, target), 0, "");
  else walk(target, 0, "");
}

// --- resolve -----------------------------------------------------------------
function cmdResolve(argv: string[]) {
  const index = load(argv[2]);
  const target = argv[3];
  const maxDepthArg = argv.slice(4).find((a) => !a.startsWith("--") && /^\d+$/.test(a));
  const maxDepth = parseInt(maxDepthArg ?? "99", 10);
  if (!target) throw new Error("usage: raw.mts resolve <message.json> <guidKey> [maxDepth]");

  function walk(n: ResolvedNode, depth: number, prefix: string) {
    if (depth > maxDepth) return;
    const tags: string[] = [];
    if (n.fromInstance) tags.push(`[from ${n.fromInstance}]`);
    if (n.overrideApplied) tags.push(`[overridden: ${Object.keys(n.overrideApplied).join(",")}]`);
    if (n.unresolved) tags.push(`⚠ unresolved (${n.unresolved})`);
    if (n.unresolvedOverrides?.length)
      tags.push(`⚠ stale overrides: ${n.unresolvedOverrides.join("; ")}`);
    console.log(
      prefix +
        describeNode(n as any, { placeholderTag: true }) +
        ` [${n.path}]` +
        (tags.length ? " " + tags.join(" ") : ""),
    );
    for (const c of n.children ?? []) {
      if ((c as any).visible === false) continue;
      walk(c, depth + 1, prefix + "  ");
    }
  }

  walk(resolveScreen(index, target), 0, "");
}

// --- overrides ---------------------------------------------------------------
function cmdOverrides(argv: string[]) {
  const { byKey, children } = load(argv[2]);
  const target = argv[3];
  const full = argv.includes("--full"); // tolerant scan; value-print collapsed fields (P1-4)
  if (!target) throw new Error("usage: raw.mts overrides <message.json> <guidKey> [--full]");

  const lhStr = (lh: any) =>
    lh?.value !== undefined
      ? `${lh.value}${lh.units === "PERCENT" ? "%" : lh.units === "PIXELS" ? "px" : ""}`
      : "auto";

  function summarizeOverride(o: any): string {
    const bits: string[] = [];
    const path = (o.guidPath?.guids ?? []).map((g: any) => `${g.sessionID}:${g.localID}`).join("/");
    bits.push(`path=${path}`);
    if (o.textData?.characters !== undefined)
      bits.push(`text=${JSON.stringify(o.textData.characters)}`);
    if (o.fillPaints)
      bits.push(
        `fills=${o.fillPaints.map((p: any) => (p.type === "SOLID" ? colorStr(p.color) : p.type)).join(",")}`,
      );
    if (o.strokePaints)
      bits.push(
        `strokes=${o.strokePaints.map((p: any) => (p.type === "SOLID" ? colorStr(p.color) : p.type)).join(",")}`,
      );
    if (o.fontName) bits.push(`font=${o.fontName.family} ${o.fontName.style}`);
    if (o.fontSize) bits.push(`size=${o.fontSize}`);
    if (o.visible !== undefined) bits.push(`visible=${o.visible}`);
    if (o.size) bits.push(`sz=${Math.round(o.size.x)}x${Math.round(o.size.y)}`);
    const known = new Set([
      "guidPath",
      "textData",
      "fillPaints",
      "strokePaints",
      "fontName",
      "fontSize",
      "visible",
      "size",
    ]);
    // --full: value-print the otherwise-collapsed fields (lineHeight, letterSpacing
    // with computed px, textCase, cornerRadius, the stack paddings).
    if (full) {
      if (o.lineHeight !== undefined) {
        bits.push(`lineHeight=${lhStr(o.lineHeight)}`);
        known.add("lineHeight");
      }
      if (o.letterSpacing !== undefined) {
        bits.push(`letterSpacing=${letterSpacingStr(o.letterSpacing, o.fontSize)}`);
        known.add("letterSpacing");
      }
      if (o.textCase !== undefined) {
        bits.push(`case=${o.textCase}`);
        known.add("textCase");
      }
      if (o.cornerRadius !== undefined) {
        bits.push(`r=${o.cornerRadius}`);
        known.add("cornerRadius");
      }
      for (const f of [
        "stackSpacing",
        "stackVerticalPadding",
        "stackHorizontalPadding",
        "stackPaddingBottom",
        "stackPaddingRight",
      ]) {
        if (o[f] !== undefined) {
          bits.push(`${f}=${o[f]}`);
          known.add(f);
        }
      }
    }
    const other = Object.keys(o).filter((k2) => !known.has(k2));
    if (other.length) bits.push(`other=[${other.join(",")}]`);
    return bits.join(" ");
  }

  function walk(k: string, depth: number) {
    const n = byKey.get(k);
    if (!n) return;
    if (n.symbolData) {
      const ovr = n.symbolData.symbolOverrides ?? [];
      console.log(
        `${"  ".repeat(depth)}${n.type} "${n.name}" [${k}] instanceOf=${key(n.symbolData.symbolID)}${ovr.length ? "" : "  (NO OVERRIDES — master placeholders shown as-is)"}`,
      );
      for (const o of ovr) console.log(`${"  ".repeat(depth + 1)}- ${summarizeOverride(o)}`);
    }
    for (const c of children.get(k) ?? []) walk(key(c.guid), depth + 1);
  }

  walk(target, 0);
}

// --- variables ---------------------------------------------------------------
function cmdVariables(argv: string[]) {
  const index = load(argv[2]);
  const { nodes } = index;

  const sets = nodes.filter((n: any) => n.type === "VARIABLE_SET" && !n.isSoftDeleted);
  for (const s of sets) {
    const modes = (s.variableSetModes ?? []).map(
      (m: any) => `${m.id?.sessionID}:${m.id?.localID}=${m.name}`,
    );
    console.log(`SET "${s.name}" [${key(s.guid)}] modes=[${modes.join(", ")}]`);
  }

  for (const t of resolveVariables(index)) {
    const entries = Object.entries(t.modes).map(([mode, value]) => {
      const alias = t.aliasOf?.[mode];
      return `${mode} → ${value}${alias ? ` (alias ${alias})` : ""}`;
    });
    console.log(`  ${t.type} "${t.name}" [set ${t.setName}]  ${entries.join("  |  ")}`);
  }
}

// --- components --------------------------------------------------------------
function cmdComponents(argv: string[]) {
  const index = load(argv[2]);
  const filter = argv[3] ? new RegExp(argv[3], "i") : null;

  const sets = findComponentSets(index).filter((s) => !filter || filter.test(s.name));
  if (!sets.length) console.error("(no component sets matched)");

  for (const set of sets) {
    console.log(`${set.name}  (set ${set.guid})  [${set.detectedBy}, ${set.confidence}]`);
    const w = Math.max(0, ...set.variants.map((v) => v.rawName.length));
    for (const v of set.variants) {
      const sz = v.size ? `${Math.round(v.size.x)}x${Math.round(v.size.y)}` : "";
      console.log(`  ${v.rawName.padEnd(w)}   ${v.guid}   ${sz}`);
    }
    const api = proposePropApi(parseVariantMatrix(set));
    if (api) console.log(`  → ${api}`);
  }
}

// --- intent ------------------------------------------------------------------
function cmdIntent(argv: string[]) {
  const msgPath = argv[2];
  const screen = argv[3];
  if (!msgPath || !screen) throw new Error("usage: raw.mts intent <message.json> <screen-guidKey>");

  const index = load(msgPath);
  const root = resolveScreen(index, screen);

  // default-variant map (components-lib; no re-derivation here)
  const defaultVariant = new Map<string, string>(); // variant guid → "Set / Version=Default"
  for (const set of findComponentSets(index)) {
    const { axes } = parseVariantMatrix(set);
    const axisNames = Object.keys(axes);
    if (!axisNames.length) continue;
    const def = set.variants.find((v) =>
      axisNames.every((a) => (axes[a][0] !== undefined ? v.props[a] === axes[a][0] : true)),
    );
    if (def) defaultVariant.set(def.guid, `${set.name} / ${def.rawName}`);
  }

  const allTexts: string[] = [];
  (function collect(n: ResolvedNode) {
    if (n.type === "TEXT") allTexts.push((n as any).textData?.characters ?? "");
    for (const c of n.children ?? []) collect(c);
  })(root);
  const repeats = repeatedStrings(allTexts);

  type Item = { kind: string; line: string };
  const items: Item[] = [];
  const seen = new Set<string>();

  function add(kind: string, line: string) {
    const sig = kind + "|" + line;
    if (seen.has(sig)) return;
    seen.add(sig);
    items.push({ kind, line });
  }

  function walk(n: ResolvedNode) {
    const at = (n as any).path ?? n.guid;

    if (n.type === "TEXT") {
      const chars = (n as any).textData?.characters ?? "";
      const cls = classifyPlaceholderText(
        chars,
        (n as any).hasTextOverride ?? false,
        (n as any).masterDefaultText,
      );
      if (cls.placeholder)
        add(
          "placeholder",
          `[PLACEHOLDER] ${n.name}: ${JSON.stringify(chars)} — un-overridden master default (${cls.reason}) @ ${at}`,
        );

      if (isDenylistedText(chars))
        add(
          "denylist",
          `[DENYLIST] ${n.name}: ${JSON.stringify(chars)} — looks like a stand-in string @ ${at}`,
        );
      else if ((repeats.get((chars ?? "").trim()) ?? 0) > 1 && (chars ?? "").trim())
        add(
          "repeated",
          `[REPEATED] ${JSON.stringify(chars)} appears ${repeats.get(chars.trim())}× — confirm it is intentional, not duplicated placeholder`,
        );

      const rec = reconcileTextSize(n as any);
      for (const c of rec.conflicts)
        add(
          "reconcile",
          `[RECONCILE] ${n.name}: fontSize ${c.declared}→~${c.chosen} (box.y=${c.boxY} can't fit lh=${c.lhPx}) — confirm size @ ${at}`,
        );
    }

    const sid = (n as any).symbolData?.symbolID;
    if (sid) {
      const label = defaultVariant.get(key(sid));
      if (label)
        add(
          "default-variant",
          `[DEFAULT VARIANT] ${n.name} → ${label} — instance targets the default variant; confirm the intended variant @ ${at}`,
        );
    }

    if (isMonoColorIconFill(n))
      add(
        "mono-icon",
        `[MONO ICON] ${n.name}: pure white/black fill — likely recolor-in-consumer, not a literal color @ ${at}`,
      );

    for (const c of n.children ?? []) walk(c);
  }
  walk(root);

  console.log(`# intent gaps for ${root.name} [${screen}] — confirm before shipping`);
  console.log(`# ${items.length} item(s). Each line is a thing to ASK; none is silently resolved.`);
  const order = [
    "placeholder",
    "denylist",
    "repeated",
    "reconcile",
    "default-variant",
    "mono-icon",
  ];
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
}

// --- match-tokens ------------------------------------------------------------
function cmdMatchTokens(argv: string[]) {
  const msgPath = argv[2];
  const themePath = argv[3];
  if (!msgPath || !themePath)
    throw new Error("usage: raw.mts match-tokens <message.json> <theme.(ts|json)> [guidKey]");
  const scope = argv[4]; // optional subtree guidKey

  const index = load(msgPath);
  const { byKey, children } = index;
  const theme = loadTheme(themePath);

  type Use = { kind: ThemeKind; value: string };
  const seen = new Map<string, Use>();
  const add = (kind: ThemeKind, value: string | undefined | null) => {
    if (value === undefined || value === null || value === "") return;
    seen.set(`${kind}|${value}`, { kind, value });
  };

  const PADDING_RE = /^stack(Horizontal|Vertical)Padding$|^stackPadding(Top|Right|Bottom|Left)$/;
  const RADIUS_RE = /^rectangle(TopLeft|TopRight|BottomLeft|BottomRight)CornerRadius$/;

  function collect(n: any) {
    for (const p of n.fillPaints ?? [])
      if (p?.color && p.visible !== false) add("color", colorStr(p.color));
    for (const p of n.strokePaints ?? [])
      if (p?.color && p.visible !== false) add("color", colorStr(p.color));
    if (n.fontSize !== undefined) add("fontSize", `${n.fontSize}px`);
    if (n.stackSpacing !== undefined) add("spacing", `${n.stackSpacing}px`);
    if (n.strokeWeight !== undefined && n.strokeWeight > 0)
      add("strokeWidth", `${n.strokeWeight}px`);
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

  const numeric = (v: string) => v.replace(/px$/, "");

  const KIND_ORDER: ThemeKind[] = [
    "color",
    "fontSize",
    "spacing",
    "radius",
    "strokeWidth",
    "other",
  ];
  const rows = [...seen.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.value.localeCompare(b.value, undefined, { numeric: true }),
  );

  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));

  for (const { kind, value } of rows) {
    const matchVal = kind === "color" ? value : numeric(value);
    const r = matchTokenByValue(matchVal, theme, kind);
    let rhs: string;
    if (r.match === "exact") rhs = `→ theme.${r.token}`;
    else if (r.match === "nearest") rhs = `→ NO EXACT MATCH (nearest ${r.token}, Δ${r.delta})`;
    else rhs = r.delta !== undefined ? `→ NO MATCH (closest Δ${r.delta})` : "→ NO MATCH";
    const tag =
      r.match === "exact"
        ? "[exact]"
        : r.match === "nearest"
          ? "[nearest]"
          : "[none → human decision]";
    console.log(`${pad(kind, 12)} ${pad(value, 9)} ${pad(rhs, 52)} ${tag}`);
  }
}

// --- diff-frames -------------------------------------------------------------
function cmdDiffFrames(argv: string[]) {
  const msgPath = argv[2];
  const a = argv[3];
  const b = argv[4];
  if (!msgPath || !a || !b)
    throw new Error("usage: raw.mts diff-frames <message.json> <guidA> <guidB>");

  const index = load(msgPath);
  const ra = resolveScreen(index, a);
  const rb = resolveScreen(index, b);

  function indexByNamePath(root: ResolvedNode): Map<string, ResolvedNode> {
    const map = new Map<string, ResolvedNode>();
    const counts = new Map<string, number>();
    (function walk(n: ResolvedNode, prefix: string) {
      const base = `${prefix}/${n.type}:${n.name ?? ""}`;
      const k = `${base}#${counts.get(base) ?? 0}`;
      counts.set(base, (counts.get(base) ?? 0) + 1);
      map.set(k, n);
      for (const c of n.children ?? []) walk(c, k);
    })(root, "");
    return map;
  }

  const ia = indexByNamePath(ra);
  const ib = indexByNamePath(rb);

  function props(n: ResolvedNode): Record<string, string> {
    const p: Record<string, string> = {};
    if (n.type === "TEXT") {
      const fn = (n as any).fontName;
      if (fn) p.fontName = `${fn.family} ${fn.style}`;
      const rec = reconcileTextSize(n as any);
      if ((n as any).fontSize !== undefined) p.fontSize = String(rec.size ?? (n as any).fontSize);
      if ((n as any).lineHeight)
        p.lineHeight = `${(n as any).lineHeight.value}${(n as any).lineHeight.units === "PERCENT" ? "%" : "px"}`;
      p.letterSpacing = letterSpacingStr((n as any).letterSpacing, (n as any).fontSize);
      const chars = (n as any).textData?.characters ?? "";
      p.text = JSON.stringify(chars.length > 60 ? chars.slice(0, 60) + "…" : chars);
    }
    const solid = ((n as any).fillPaints ?? []).find(
      (x: any) => x.visible !== false && x.type === "SOLID",
    );
    if (solid) p.color = colorStr(solid.color);
    if ((n as any).size)
      p.size = `${Math.round((n as any).size.x)}x${Math.round((n as any).size.y)}`;
    if ((n as any).stackSpacing !== undefined) p.gap = String((n as any).stackSpacing);
    if ((n as any).cornerRadius) p.radius = String((n as any).cornerRadius);
    return p;
  }

  console.log(`# diff-frames: A=${a}  B=${b}`);
  console.log(`# These are conflicting specs (possible designer drift). NO canonical`);
  console.log(`# winner is chosen — confirm which .fig export / which frame is canonical.`);

  let lines = 0;
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [k, na] of ia) {
    const nb = ib.get(k);
    if (!nb) {
      onlyA.push(`${na.type} "${na.name}"`);
      continue;
    }
    const pa = props(na);
    const pb = props(nb);
    const deltas: string[] = [];
    for (const field of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (pa[field] !== pb[field]) deltas.push(`${field} ${pa[field] ?? "∅"}→${pb[field] ?? "∅"}`);
    }
    if (deltas.length) {
      console.log(`${na.name ?? na.type}: ${deltas.join("  ")}`);
      lines++;
    }
  }
  for (const [k, nb] of ib) if (!ia.has(k)) onlyB.push(`${nb.type} "${nb.name}"`);

  if (onlyA.length)
    console.log(
      `\n# only in A (${onlyA.length}): ${onlyA.slice(0, 20).join(", ")}${onlyA.length > 20 ? " …" : ""}`,
    );
  if (onlyB.length)
    console.log(
      `# only in B (${onlyB.length}): ${onlyB.slice(0, 20).join(", ")}${onlyB.length > 20 ? " …" : ""}`,
    );
  if (!lines && !onlyA.length && !onlyB.length)
    console.log("\n(no per-node property deltas — frames are structurally identical)");
}

// --- dispatch ----------------------------------------------------------------
const COMMANDS: Record<string, (argv: string[]) => void> = {
  dump: cmdDump,
  resolve: cmdResolve,
  overrides: cmdOverrides,
  variables: cmdVariables,
  components: cmdComponents,
  intent: cmdIntent,
  "match-tokens": cmdMatchTokens,
  "diff-frames": cmdDiffFrames,
};

const sub = process.argv[2];
const run = sub ? COMMANDS[sub] : undefined;
if (!run) {
  console.error(
    "usage: raw.mts <cmd> <args…>\n" +
      "  dump | resolve | overrides | variables | components | intent | match-tokens | diff-frames\n" +
      "(run a cmd with no args for its own usage line)",
  );
  process.exit(1);
}
// Shift argv so argv[2] is the cmd's first real arg (matches the original CLIs).
run([process.argv[0], process.argv[1], ...process.argv.slice(3)]);
