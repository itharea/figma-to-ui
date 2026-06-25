---
name: figma-to-ui
description: Decode binary Figma .fig export files locally — no Figma account, plugin, or REST API. Use when given a .fig file and asked to implement UI 1:1, or to extract design tokens (colors, typography), screen layouts, copy/text, components, icons, SVG vectors, or image/video assets from a Figma design.
---

# Figma `.fig` → 1:1 UI implementation harness

A **harness**, not a grab-bag of scripts. Compile a `.fig` into a **Design IR** once, then
drive a fixed sequence to a pixel-faithful app/website:

```
parse → build IR → theme (pick mode) → codegen (faithful scaffold + owned icons)
                                              └─▶ ELEVATE  (one subagent per component — REQUIRED)
                                                      └─▶ assemble screens (one subagent per screen)
```

The foundation, in order: **(1)** real theming from the file's variables, **(2)** 1:1
components built from the designer's sets (codegen now wires icons + images itself), **(3)**
those components composed under the screen nodes, the rest filled from IR node data. Get
those right and the whole design comes out 1:1.

**Read via the IR, never the blob.** The decoded `message.json` is ~80MB for a 20MB fig —
never load it into context. After `build-ir`, read the small per-screen / per-component JSON
**directly**. The raw scripts (`raw.mts …`, `tree`, `find`, `node`) are the quick-query path.

**Field-level details live in [`REFERENCE.md`](./REFERENCE.md)** — the binary format, the
node-field tables, the IR schema, and every script's flags. You don't need it to follow this
harness; reach for it for a specific field.

---

## Operating principles

1. **Deterministic with faithful defaults.** Everything `build-ir` and `codegen` emit is a
   pure function of the bytes. You never guess geometry, colour, type, or structure — you read
   it from the IR. When a value isn't confirmable, the faithful default ships (the Figma
   family, the resolved hex, the master copy) with a `// TODO` for the human — never a blank.
2. **Exactly two human touchpoints.** (a) **Scope** — which pages/components to build; (b)
   **Mode** — which variable mode (Light/Dark/brand) to style at, asked only when there's more
   than one. Everything else is mechanical. There is no `decisions.json` and no ship-gate.
3. **The scaffold is raw material; the elevated component is the deliverable.** `codegen`
   output is a faithful but verbose SCAFFOLD — never shipped as-is. **Every in-scope component
   is elevated** (Step 5). This is not optional.
4. **Resolve every `// TODO` during elevation.** A component is not done while one remains.

## Decision points — STOP and ask the user

| When | Decision |
|---|---|
| Step 1/4 | **Scope** — which pages are canonical, and which component sets to build. **Read the set inventory and identify platform/device chrome yourself** (judgment, not a script — set names are often non-English), then propose a keep/exclude split for the user to confirm. |
| Step 3 | **Mode** — when the catalog has >1 variable mode, which one to style at. Skip the question when there's only one. |

---

## Setup

```sh
WORK=/tmp/figparse && mkdir -p $WORK && cd $WORK
cp <repo>/scripts/*.mts .
npm init -y >/dev/null 2>&1 && npm i kiwi-schema
```

Run with `node <script>.mts …` (Node ≥ 22.15 / Bun — for `zstd`). For React Native, generated
owned icons import `react-native-svg` (a peer dep of the consuming app); web needs no dep.

## Step 1 — Decode & scope

```sh
unzip -o file.fig -d $WORK/ex
node parse.mts $WORK/ex/canvas.fig $WORK/msg-<name>.json
node tree.mts  $WORK/msg-<name>.json          # pages + top-level frames
```

Page/frame names carry the IA. Reject scratchpad pages (`trial`, `old`, `wip`, `-`, local
equivalents). **Confirm the canonical pages with the user** before compiling.

## Step 2 — Build the IR

```sh
node build-ir.mts msg-<name>.json --scope <pages|all> --out ir-<name>
```

A **pure function of the bytes**. Emits a small, provenance-stamped `ir-<name>/`: `manifest.json`
(now carries `modes` + `activeMode`) + `tokens/*` (incl. `variables.json`) + `components/<set>.json`
+ `screens/<page>/<screen>.json` (resolved instances, reconciled text, absolute coords, full
`style`/`layout` per node). Read those files directly. **Trust the reconciled `font.size`**, not
the raw `fontSize`. Faithful defaults: an unmapped font uses its Figma family; an unmatched colour
keeps its literal hex; placeholder/denylisted copy renders the master text with a `// TODO`. Nothing
blocks.

## Step 3 — Theme from the variables (+ pick the mode)

```sh
node theme-gen.mts ir-<name> --list-modes              # the catalog's variable modes
node theme-gen.mts ir-<name> --framework web --mode <M> --out src/theme
```

Variables are the design tokens — turn the catalog into a typed theme (`theme.css` web /
`theme.ts` rn), mirroring Figma's `/`-hierarchy (`Color/praline/950` → `var(--color-praline-950)`
/ `theme.color.praline['950']`), aliases preserved as code references.

> **Decision point — mode.** If `--list-modes` shows more than one mode, **ask the user which
> mode to style at**, then thread that one mode through everything:
> `build-ir … --mode <M>` (re-build), `theme-gen … --mode <M>`, and `codegen … --mode <M>`. The
> chosen mode becomes `:root` / `defaultMode`. One mode ⇒ no question; just proceed.

## Step 4 — Components: the faithful scaffold (+ owned icons)

> **Scope first (your judgment, no script).** A `.fig` ships platform/device chrome that is NOT
> your product (iOS/Android keyboards, status bars, home indicators, device frames). Inventory the
> sets and **read them yourself**: list `ir-<name>/components/` and check each set's name and variant
> axes (`manifest.json` / `components/<set>.json`). Identify chrome by what each set *is* — a keyboard,
> a status bar, a device frame, or a set whose variant axis is a device (`Size=iPhone 14`). Use
> judgment, not pattern-matching: names are often non-English (a keyboard may be "klavye"), and a
> device-width size alone doesn't make a set chrome. Propose a keep/exclude split, confirm with the
> user, and generate only the in-scope sets — never the whole catalog by default.

For each in-scope set:

```sh
node codegen.mts ir-<name> <set> --framework web --out src/components --theme-import ../theme \
  --mode <M> --svg msg-<name>.json --images $WORK/ex/images
```

You get a folder: `index.tsx` (variant dispatcher), `types.ts`, and **one `<variant>.tsx` per
variant** (each renders that variant's own resolved subtree with reconciled style/layout/font/
text, theme-bound values, and `// TODO`s on every unconfirmed value).

- **`--svg msg-<name>.json` makes icons an internal, deterministic step.** Codegen exports each
  vector's geometry into a **deduplicated owned icon component** under `<out>/icons/` (the
  `RoastSquare` pattern) and wires its colour from the IR's resolved (override-aware) value — a
  mono icon gets `currentColor` + the resolved token, so it recolours correctly. Instance-swap
  slots render `{icon ?? <DefaultGlyph/>}`. No `export-svg` placeholder boxes, no manual re-map.
  (Default source is `manifest.source.path`, but that decode is usually gone from `/tmp` — pass
  `--svg` explicitly.)
- **`--images $WORK/ex/images`** extracts raster fills into `<slug>/assets/` and wires real
  references (web `backgroundImage` / rn `<Image>`).

The scaffold is **faithful but verbose — raw material, not the finished component.** One file per
variant on purpose: Figma variants often have different frame structures; collapsing them to CSS
conditionals would break structure.

## Step 5 — Elevate the scaffold (REQUIRED — the deliverable)

The scaffold is never shipped. **Spawn the elevate subagent once per in-scope component** —
`figma-to-ui/agents/elevate.md` — passing the component's paths (slug, scaffold dir, IR component
JSON, out file, theme note). The codegen scaffold is its FIXED source of truth: it refactors form
(opaque keys → semantic names, N near-identical variant files → one prop-driven component, repeated
subtrees → shared sub-components, variant axes → props) **without changing a single resolved value**
(geometry, padding, gap, radius, colour token, typography, borders, effects, absolute position, the
variant→structure map). It resolves every `// TODO` and ships zero. Icons already arrive wired as
`<NameIcon size color/>` — it preserves them.

This is unconditional: codegen makes the scaffold data-complete (icons + images wired), so there is
no precondition to wait on and no reason to skip. A raw scaffold presented as finished is a defect.

## Step 6 — Assemble the screens

**Spawn the assemble-screen subagent once per screen** — `figma-to-ui/agents/assemble-screen.md` —
passing the screen IR path, the elevated components dir, the theme note, and the out file. It walks
`ir-<name>/screens/<page>/<screen>.json`, renders every component **instance through the elevated
component** (variant + props from the instance's resolved values — never re-drawn), and fills the
rest from IR node data (`layout`/`box`/`style`/`font`/`text`, `absX/absY` for absolute children). It
binds variable-backed values to the theme and changes no resolved value.

**Brownfield?** Build with `build-ir … --theme <path>` and map fig values to repo tokens **by value,
never by name**; respect intentional divergence. A by-value mismatch is surfaced as a `// REVIEW`
note — confirm with the user before overwriting.

## Step 7 — Standalone assets

Icons are handled inside codegen (Step 4). `export-svg.mts` remains for **standalone** logos /
illustrations and for raw SVG export:

```sh
node export-svg.mts msg-<name>.json <guidKey> out.svg [--png] [--recolor=currentColor]
```

Video fills (from the zip's `videos/` by content hash) are the only assets left to wire by hand.

---

## Verification

All deterministic — no visual-diff/fidelity step:
- `npm test` (`selftest.mts`) — the unit suite (IR, theme, svg-lib, prop model).
- TypeScript: the generated components + screens must typecheck in the consuming app.
- Re-read the elevated component / assembled screen against the IR: every resolved value traces back.

## Toolkit

| Stage | Scripts |
|---|---|
| Decode & locate | `parse`, `tree`, `find`, `node` |
| IR spine | `build-ir`, `theme-gen`, `codegen`, `diff-ir`, `ir` |
| Assets | `export-svg`, `icons`, `svg-lib` (shared geometry core) |
| Raw query | `raw.mts <dump\|resolve\|overrides\|variables\|components\|intent\|match-tokens\|diff-frames>` |
| Test | `selftest.mts` (`npm test`) |

Full usage, every flag, the `.fig` format, the node-field tables, and the IR schema →
**[`REFERENCE.md`](./REFERENCE.md)**.
