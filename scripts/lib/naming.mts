// Name munging — turn an arbitrary Figma name into a slug, kebab token, camelCase
// prop name, or PascalCase identifier. Centralized so the rules never drift across
// build-ir, theme-gen, codegen, and components (the analogue of theme-lib's
// cssVarName/tsAccessor for component/file naming). No import-time side effects.

// slug — lower-case, keep [a-z0-9], collapse any other run → "-", trim "-".
// On collision the caller appends "-2","-3",… (use uniqueSlug).
export function slugify(name: string): string {
  return name
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

// kebab — split camelCase / snake / spaces into a "-"-joined lower-case token.
export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w-]/g, "")
    .toLowerCase();
}

// Latin diacritics + Turkish specials → ASCII, so camel() yields plain identifiers.
const TR_MAP: Record<string, string> = {
  ı: "i",
  İ: "i",
  ş: "s",
  Ş: "s",
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ü: "u",
  Ü: "u",
  ö: "o",
  Ö: "o",
};

// camelCase from an arbitrary prop name (transliterates Latin letters with
// diacritics + Turkish specials to ASCII, then splits on non-word / case
// boundaries). "Başlık" → "baslik"; "actionText" → "actionText"; "Icon" → "icon".
export function camel(s: string): string {
  const ascii = [...s]
    .map((ch) => TR_MAP[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
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

// PascalCase identifier from a Figma name — the meta component name AND the
// JSX/import name used for nested-component references (parity across both).
// "" → "Component".
export function compIdent(name: string): string {
  return (
    (name ?? "")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .replace(/(?:^|\s)(\w)/g, (_: string, ch: string) => ch.toUpperCase())
      .replace(/\s/g, "") || "Component"
  );
}
