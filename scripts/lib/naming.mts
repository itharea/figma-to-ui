// Name munging — turn an arbitrary Figma name into a slug, kebab token, camelCase
// prop name, or PascalCase identifier. Centralized so the rules never drift across
// build-ir, theme-gen, codegen, and components (the analogue of theme-lib's
// cssVarName/tsAccessor for component/file naming). No import-time side effects.

// Latin letters whose modification lives INSIDE the codepoint — strokes (ø, ł, đ),
// ligatures (æ, œ, ß) and the dotless ı — and therefore have no canonical or
// compatibility decomposition for NFKD to peel off. Everything else (ç, ü, ş, ğ, é, å,
// …) carries its mark as a combining codepoint, so NFKD + stripping \p{M} recovers the
// base letter without a table. General Latin: no per-language or per-file rules.
const LATIN_FOLD: Record<string, string> = {
  ı: "i",
  İ: "I",
  ø: "o",
  Ø: "O",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ß: "ss",
  ẞ: "SS",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ł: "l",
  Ł: "L",
  ħ: "h",
  Ħ: "H",
  ŧ: "t",
  Ŧ: "T",
  ŋ: "n",
  Ŋ: "N",
  ə: "e",
  Ə: "E",
  ĸ: "k",
};

// Fold an arbitrary name to ASCII. EVERY munger below starts here, because the ones
// that don't lose whole words rather than a diacritic: the old `[^a-z0-9]` slug of
// "öğütücü" was "tc" and the old kebab of it was "" outright, and those slugs are not
// internal — they become the public value union of a generated component. Case is
// preserved (compIdent and camel both key off it).
export function asciiFold(s: string): string {
  return [...(s ?? "")]
    .map((ch) => LATIN_FOLD[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

// slug — transliterate, lower-case, keep [a-z0-9], collapse any other run → "-", trim "-".
// On collision the caller appends "-2","-3",… (use uniqueSlug).
export function slugify(name: string): string {
  return asciiFold(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name) || "set";
  let slug = base;
  let i = 2;
  while (taken.has(slug)) slug = `${base}-${i++}`;
  taken.add(slug);
  return slug;
}

// kebab — transliterate, then split camelCase / snake / spaces into a "-"-joined
// lower-case token. NOT an identifier (it contains "-"): use propIdent for anything
// emitted into a type literal, a destructuring pattern or a switch key.
export function kebab(s: string): string {
  return asciiFold(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w-]/g, "")
    .toLowerCase();
}

// camelCase from an arbitrary prop name (transliterates Latin letters with diacritics,
// strokes and ligatures to ASCII, then splits on non-word / case boundaries).
// "Başlık" → "baslik"; "actionText" → "actionText"; "Icon" → "icon".
export function camel(s: string): string {
  const ascii = asciiFold(s);
  const words = ascii
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return "prop";
  return words
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toLowerCase() + w.slice(1)
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}

// Every ECMAScript reserved word, plus the strict-mode-only ones (modules are always
// strict), the module-only `await`, and the two names a module may not bind at all
// (`eval`, `arguments`). A Figma prop or variant axis can be named ANY of these — "in",
// "class", "default", "new" are ordinary UI words — and the name is emitted verbatim
// into a destructuring pattern, so `function X({ header, in })` is a SyntaxError: the
// whole scaffold fails to PARSE, not merely to type-check.
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// True when `s` can be written bare as a binding / property shorthand / member name.
export const isSafeIdent = (s: string): boolean => IDENT_RE.test(s) && !RESERVED_WORDS.has(s);

// A safe TS identifier from an arbitrary Figma prop or variant-axis name. camel() does
// the transliteration and drops the spaces, hyphens and punctuation kebab() would leave
// behind ("item count" → "itemCount", never "item-count"); this adds the two guards
// camel() has no reason to apply on its own — a reserved word is suffixed, and a name
// that cannot START an identifier ("941") is prefixed. Deterministic and total: the
// Props type, the destructure, the switch key and the attribute a PARENT component
// passes are emitted from separate call sites and must agree character-for-character.
// Callers emitting several identifiers into ONE scope must also de-dupe — two distinct
// names can sanitise to the same identifier; see axisPropNames.
export function propIdent(name: string): string {
  const base = camel(name);
  if (RESERVED_WORDS.has(base)) return `${base}Prop`;
  if (IDENT_RE.test(base)) return base;
  return `prop${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

// Variant-axis names → the prop identifiers a generated component exposes, de-duped.
// Two distinct axes CAN sanitise to one identifier ("item count" and "item-count", or
// "in" and "in "), and silently merging them would drop a whole axis from the type AND
// from the dispatcher key while the switch cases still composed both values — so the
// later one takes a numeric suffix. Order is the caller's axis order, which is the IR's
// (JSON key order, stable), so every emitter derives the SAME map from the same record.
export function axisPropNames(axisNames: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const axis of axisNames) {
    const base = propIdent(axis);
    let name = base;
    let i = 2;
    while (taken.has(name)) name = `${base}${i++}`;
    taken.add(name);
    out.set(axis, name);
  }
  return out;
}

// PascalCase identifier from a Figma name — the meta component name AND the
// JSX/import name used for nested-component references (parity across both).
// "" → "Component".
export function compIdent(name: string): string {
  return (
    asciiFold(name ?? "")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .replace(/(?:^|\s)(\w)/g, (_: string, ch: string) => ch.toUpperCase())
      .replace(/\s/g, "") || "Component"
  );
}
