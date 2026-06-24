// Brownfield token mapping (Phase 4): resolve Figma variable alias chains to
// concrete values, load a code theme file into flat dotted-path entries, and
// match a fig value to the nearest theme entry BY VALUE (never by name) and
// WITHIN ITS KIND (a 16px font size never matches a 16px gap). No side effects:
// the IR build imports this at build time. CLI entry lives in match-tokens.mts /
// variables.mts.
import * as fs from "fs";
import { load, key, colorStr } from "./lib.mts";

export type Token = {
  name: string;
  setName: string;
  type: string; // variableResolvedType: COLOR | FLOAT | BOOLEAN | STRING
  modes: Record<string, string>; // mode name → concrete value (hex | number-as-string | text)
  guid: string;
  // the variable's collection DEFAULT mode (its set's first variableSetModes entry,
  // by Figma's own ordering) — the canonical mode to resolve a binding against when
  // no mode context is available (e.g. a screen's bound color). Falls back to the
  // first resolved mode name when the set has no declared modes.
  defaultMode: string;
  // alias provenance per mode (mode name → "Numbers/18" chain), present only when aliased
  aliasOf?: Record<string, string>;
  // DIRECT alias target per mode (mode name → target variable guidKey). The first hop
  // of the alias, NOT the collapsed concrete value — lets a consumer express the alias
  // as a CODE REFERENCE to the target token (e.g. var(--numbers-18)) rather than baking
  // the value. Present only on the modes that are aliased. Keyed by guid (never name) so
  // it joins straight onto another Token.guid.
  aliasTargets?: Record<string, string>;
};

// Concrete value of a variableData value (no alias following). Returns null for
// an alias or an unrecognized shape.
function concreteValue(v: any): string | null {
  if (!v) return null;
  if (v.colorValue) return colorStr(v.colorValue);
  if (v.floatValue !== undefined) return String(v.floatValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.textValue !== undefined) return String(v.textValue);
  return null;
}

// Resolve VARIABLE/VARIABLE_SET. Collapse alias chains transitively: when an
// entry's value is an alias, follow alias→…→concrete and record the concrete
// value PLUS the chain (target names joined by " → ") for display. Guards
// against cycles.
export function resolveVariables(index: ReturnType<typeof load>): Token[] {
  const { nodes, byKey } = index;
  const setName = (id: any): string => {
    if (!id) return "?";
    const s = byKey.get(key(id.guid ?? id));
    return s?.name ?? key(id.guid ?? id);
  };
  const modeName = (setId: any, modeID: any): string => {
    const s = setId ? byKey.get(key(setId.guid ?? setId)) : null;
    const m = (s?.variableSetModes ?? []).find(
      (mm: any) => mm.id?.sessionID === modeID?.sessionID && mm.id?.localID === modeID?.localID
    );
    return m?.name ?? (modeID ? key(modeID) : "default");
  };

  // Follow an alias entry to a concrete value. Returns the value and the chain of
  // target variable names visited. Picks the target's matching-mode value, else
  // its first concrete entry.
  const followAlias = (
    aliasGuid: any,
    modeID: any,
    seen: Set<string>
  ): { value: string | null; chain: string[] } => {
    const tk = key(aliasGuid);
    if (seen.has(tk)) return { value: null, chain: ["<cycle>"] };
    seen.add(tk);
    const t = byKey.get(tk);
    if (!t) return { value: null, chain: [tk] };
    const entries = t.variableDataValues?.entries ?? [];
    // prefer an entry whose modeID matches; else the first entry
    const match =
      entries.find(
        (e: any) => e.modeID?.sessionID === modeID?.sessionID && e.modeID?.localID === modeID?.localID
      ) ?? entries[0];
    const vd = match?.variableData?.value;
    if (vd?.alias) {
      const next = followAlias(vd.alias.guid ?? vd.alias, match.modeID, seen);
      return { value: next.value, chain: [t.name ?? tk, ...next.chain] };
    }
    return { value: concreteValue(vd), chain: [t.name ?? tk] };
  };

  // The collection DEFAULT mode name = the set's FIRST variableSetModes entry (Figma's
  // own ordering). Used to resolve a binding when no mode context is available.
  const defaultModeName = (setId: any): string | null => {
    const s = setId ? byKey.get(key(setId.guid ?? setId)) : null;
    const first = (s?.variableSetModes ?? [])[0];
    return first ? modeName(setId, first.id) : null;
  };

  const tokens: Token[] = [];
  for (const n of nodes) {
    // Skip SOFT-DELETED variables: Figma retains deleted variables in the export
    // (isSoftDeleted) for sync/recovery, but they are not part of the live token
    // system — emitting them pollutes every downstream token file. followAlias still
    // traverses byKey (the full node index), so a LIVE alias through a soft-deleted
    // intermediate keeps resolving to a value; only the deleted node's own output row
    // is dropped.
    if (n.type !== "VARIABLE" || n.isSoftDeleted) continue;
    const modes: Record<string, string> = {};
    const aliasOf: Record<string, string> = {};
    const aliasTargets: Record<string, string> = {};
    for (const e of n.variableDataValues?.entries ?? []) {
      const mn = modeName(n.variableSetID, e.modeID);
      const v = e.variableData?.value;
      if (v?.alias) {
        const r = followAlias(v.alias.guid ?? v.alias, e.modeID, new Set([key(n.guid)]));
        modes[mn] = r.value ?? `alias→${key(v.alias.guid ?? v.alias)}`;
        aliasOf[mn] = r.chain.join(" → ");
        aliasTargets[mn] = key(v.alias.guid ?? v.alias); // DIRECT (first-hop) target guid
      } else {
        const c = concreteValue(v);
        modes[mn] = c ?? JSON.stringify(v);
      }
    }
    tokens.push({
      name: n.name,
      setName: setName(n.variableSetID),
      type: n.variableResolvedType ?? "?",
      modes,
      guid: key(n.guid),
      defaultMode: defaultModeName(n.variableSetID) ?? Object.keys(modes)[0] ?? "default",
      ...(Object.keys(aliasOf).length ? { aliasOf } : {}),
      ...(Object.keys(aliasTargets).length ? { aliasTargets } : {}),
    });
  }
  return tokens;
}

// --- code theme loading -----------------------------------------------------

export type ThemeKind = "color" | "fontSize" | "spacing" | "radius" | "strokeWidth" | "other";
export type ThemeEntry = { path: string; value: string; kind: ThemeKind };

const HEX_RE = /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/;
const normHex = (s: string): string => {
  let h = s.trim().replace(/^#/, "").toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h;
};

// Infer the value DOMAIN from a dotted path (and the value itself as a fallback).
// Order matters: stroke/border-width before generic "border", radius before color.
export function inferKind(path: string, value: string): ThemeKind {
  const p = path.toLowerCase();
  if (/color|colour|palette|fill|bg|background|foreground|surface|text|ink|tint|shade/.test(p))
    return "color";
  if (/radius|corner|rounded/.test(p)) return "radius";
  if (/stroke|borderwidth|border-width|outline/.test(p)) return "strokeWidth";
  if (/font.*size|fontsize|text.*size|textsize|type.*size|typesize|leading|lineheight/.test(p))
    return "fontSize";
  if (/space|spacing|gap|pad|padding|inset|margin|size(?!.*font)/.test(p)) return "spacing";
  if (HEX_RE.test(value.trim())) return "color";
  return "other";
}

// Load a code theme file → flat list of dotted-path entries.
//   .json: JSON.parse then walk recursively (arrays index by position).
//   .js/.mjs/.cjs: NOT eval'd (no network, keep deterministic & safe) — treated
//     like .ts via the brace-depth extractor; a strict JSON-ish body still parses.
//   .ts: a tolerant extractor that tracks BRACE DEPTH to reconstruct the dotted
//     path. Reads `key: '#hex'` / `key: <number>` leaves; flags any region whose
//     braces don't balance (throws) instead of guessing. No TS compiler.
// Supported leaf shapes: `surface: '#1a1a1a'`, `md: 16`, `md: 16px` (px stripped),
// quoted or bare keys, single/double-quoted string values.
export function loadTheme(path: string): ThemeEntry[] {
  const text = fs.readFileSync(path, "utf8");
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "json") return walkObject(JSON.parse(text));
  return extractBraceDepth(text);
}

function walkObject(obj: any, prefix = "", out: ThemeEntry[] = []): ThemeEntry[] {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkObject(v, prefix ? `${prefix}.${i}` : String(i), out));
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) walkObject(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  // leaf
  const value = leafValue(obj);
  if (value !== null) out.push({ path: prefix, value, kind: inferKind(prefix, value) });
  return out;
}

function leafValue(v: any): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (HEX_RE.test(s)) return normHex(s);
    const px = s.match(/^(-?\d+(\.\d+)?)\s*px$/);
    if (px) return px[1];
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    return s; // free text token (e.g. a font-family) — kept, will be `other`
  }
  return null;
}

// Tolerant TS/JS extractor. Tracks a path stack as braces open/close; reads
// `key: value` leaves. Strips comments and string contents from brace counting.
function extractBraceDepth(text: string): ThemeEntry[] {
  const out: ThemeEntry[] = [];
  // strip line + block comments (outside strings — best-effort, good enough here)
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const stack: string[] = []; // dotted path components for open braces
  let pendingKey: string | null = null; // key seen before its `{` or value
  let i = 0;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // skip strings
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < n && src[i] !== ch) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") {
      stack.push(pendingKey ?? "");
      pendingKey = null;
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) throw new Error(`loadTheme: unbalanced '}' at offset ${i} (unparseable region — fix or remove it)`);
      stack.pop();
      depth--;
      i++;
      continue;
    }
    // try to read `key: ...`  — key is an identifier, a number (ramp keys like
    // `300:`), or a quoted string.
    const m = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*|\d[\w$-]*))\s*:/.exec(src.slice(i));
    if (m) {
      const k = m[1] ?? m[2] ?? m[3];
      i += m[0].length;
      // peek the value
      const rest = src.slice(i);
      const open = /^\s*[{[]/.test(rest);
      if (open) {
        pendingKey = k; // an object/array follows; remember the key for the brace
        // for arrays we also descend, but positions are messy in TS text — push key now
        // and let the next `{`/`[` use it. Arrays handled below.
      } else {
        // scalar leaf: read until , } newline
        const vm = /^\s*([^,}\n]+)/.exec(rest);
        if (vm) {
          const raw = vm[1].trim().replace(/,+$/, "");
          const path = [...stack.filter(Boolean), k].join(".");
          const value = leafScalar(raw);
          if (value !== null) out.push({ path, value, kind: inferKind(path, value) });
          i += vm[0].length;
        }
      }
      continue;
    }
    // handle array opener tied to pendingKey
    if (ch === "[") {
      stack.push(pendingKey ?? "");
      pendingKey = null;
      depth++;
      i++;
      continue;
    }
    if (ch === "]") {
      if (depth === 0) throw new Error(`loadTheme: unbalanced ']' at offset ${i} (unparseable region)`);
      stack.pop();
      depth--;
      i++;
      continue;
    }
    i++;
  }
  if (depth !== 0)
    throw new Error(`loadTheme: unbalanced braces (depth=${depth}) — flag this region for a human rather than guessing`);
  return out;
}

function leafScalar(raw: string): string | null {
  let s = raw.trim();
  // unquote
  const q = /^(['"`])(.*)\1$/.exec(s);
  if (q) s = q[2];
  s = s.trim();
  if (!s) return null;
  if (HEX_RE.test(s)) return normHex(s);
  const px = s.match(/^(-?\d+(\.\d+)?)\s*px$/);
  if (px) return px[1];
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  // ignore non-leaf junk (booleans/identifiers that aren't tokens)
  if (/^(true|false|null|undefined)$/.test(s)) return null;
  return s; // free text (font family etc.)
}

// --- value matching ---------------------------------------------------------

// Per-kind nearest threshold (labeled knob). color is RGB Euclidean distance on
// 0–255 channels; numeric kinds are absolute px delta. Conservative by default.
const NEAREST: Record<ThemeKind, number> = {
  color: 12, // ~ΔE small; RGB distance units
  fontSize: 1,
  spacing: 1,
  radius: 1,
  strokeWidth: 1,
  other: 0,
};

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(h.trim());
  if (!m) {
    const m3 = /^#?([0-9a-fA-F]{3})$/.exec(h.trim());
    if (!m3) return null;
    const c = m3[1];
    return [parseInt(c[0] + c[0], 16), parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16)];
  }
  const c = m[1];
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function colorDelta(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  return Math.sqrt((ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2);
}

// Match a fig value to the nearest theme entry OF THE SAME KIND (never across
// kinds). exact (Δ==0) | nearest (Δ within per-kind threshold, reports Δ) | none.
// `other` matches nothing. Never rewrites — annotation only.
export function matchTokenByValue(
  value: string,
  theme: ThemeEntry[],
  kind: ThemeKind
): { token?: string; match: "exact" | "nearest" | "none"; delta?: number } {
  if (kind === "other") return { match: "none" };
  const candidates = theme.filter((e) => e.kind === kind);
  const isColor = kind === "color";
  let best: { token: string; delta: number } | null = null;
  for (const e of candidates) {
    let d: number | null;
    if (isColor) {
      d = colorDelta(value, e.value);
    } else {
      const a = parseFloat(value);
      const b = parseFloat(e.value);
      d = Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null;
    }
    if (d === null) continue;
    if (!best || d < best.delta) best = { token: e.path, delta: d };
  }
  if (!best) return { match: "none" };
  if (best.delta === 0) return { token: best.token, match: "exact", delta: 0 };
  if (best.delta <= NEAREST[kind])
    return { token: best.token, match: "nearest", delta: Math.round(best.delta * 100) / 100 };
  return { match: "none", delta: Math.round(best.delta * 100) / 100 };
}
