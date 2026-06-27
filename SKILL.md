---
name: figma-to-ui
description: Decode binary Figma .fig export files locally — no Figma account, plugin, or REST API. Use when given a .fig file and asked to implement UI 1:1, or to extract design tokens (colors, typography), screen layouts, copy/text, components, icons, SVG vectors, or image/video assets from a Figma design.
---

# Figma `.fig` → 1:1 UI implementation harness

A **harness**, not a grab-bag of scripts. Compile a `.fig` into a **Design IR** once, then
drive a fixed sequence to a pixel-faithful app/website:

```
parse → build IR → theme (pick mode) → codegen (faithful scaffold + owned icons)
                                              └─▶ GROUP (propose batches → confirm → groups-<kind>.json)
                                                      └─▶ ELEVATE (one subagent per GROUP — REQUIRED)
                                                              └─▶ assemble screens (one subagent per screen GROUP)
```

The foundation, in order: **(1)** real theming from the file's variables, **(2)** 1:1
components built from the designer's sets (codegen now wires icons + images itself), **(3)**
those components composed under the screen nodes, the rest filled from IR node data. Get
those right and the whole design comes out 1:1.

**Read via the IR, never the blob.** The decoded `message.json` is ~80MB for a 20MB fig —
never load it into context. After `build-ir`, read the small per-screen / per-component JSON
**directly**. The raw scripts (`cli/raw.mts …`, `cli/tree`, `cli/find`, `cli/node`) are the quick-query path.

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

| When     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 1/4 | **Scope** — which pages are canonical, and which component sets to build. **Read the set inventory and identify platform/device chrome yourself** (judgment, not a script — set names are often non-English), then propose a keep/exclude split for the user to confirm.                                                                                                                                                                                              |
| Step 3   | **Mode** — when the catalog has >1 variable mode, which one to style at. Skip the question when there's only one.                                                                                                                                                                                                                                                                                                                                                     |
| Step 5   | **Grouping** — how to batch the in-scope components into subagent calls (and screens, Step 6). Score each unit's complexity, propose batches that keep related units together and isolate high-complexity ones, each packed as large as one subagent's context allows (fewest calls wins; a homogeneous low-complexity family collapses to a single subagent regardless of count). Confirm membership and granularity with the user, then write `groups-<kind>.json`. |

---

## Setup

```sh
WORK=/tmp/figparse && mkdir -p $WORK && cd $WORK
cp -r <repo>/scripts/. .          # keeps the cli/ + lib/ layout (relative imports + bare kiwi resolve)
npm init -y >/dev/null 2>&1 && npm i kiwi-schema
```

Run with `node cli/<script>.mts …` (Node ≥ 22.15 / Bun — for `zstd`). For React Native, generated
owned icons import `react-native-svg` (a peer dep of the consuming app); web needs no dep.

## Step 1 — Decode & scope

```sh
unzip -o file.fig -d $WORK/ex
node cli/parse.mts $WORK/ex/canvas.fig $WORK/msg-<name>.json
node cli/tree.mts  $WORK/msg-<name>.json          # pages + top-level frames
```

Page/frame names carry the IA. Reject scratchpad pages (`trial`, `old`, `wip`, `-`, local
equivalents). **Confirm the canonical pages with the user** before compiling.

## Step 2 — Build the IR

```sh
node cli/build-ir.mts msg-<name>.json --scope <pages|all> --out ir-<name>
```

A **pure function of the bytes**. Emits a small, provenance-stamped `ir-<name>/`: `manifest.json`
(now carries `modes` + `activeMode`), `tokens/*` (incl. `variables.json`), `components/<set>.json`,
and `screens/<page>/<screen>.json` (resolved instances, reconciled text, absolute coords, full
`style`/`layout` per node). Read those files directly. **Trust the reconciled `font.size`**, not the
raw `fontSize`. Faithful defaults: an unmapped font uses its Figma family; an unmatched colour keeps
its literal hex; placeholder/denylisted copy renders the master text with a `// TODO`. Nothing blocks.

## Step 3 — Theme from the variables (+ pick the mode)

```sh
node cli/theme-gen.mts ir-<name> --list-modes              # the catalog's variable modes
node cli/theme-gen.mts ir-<name> --framework web --mode <M> --out src/theme
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
> axes (`manifest.json` / `components/<set>.json`). Identify chrome by what each set _is_ — a keyboard,
> a status bar, a device frame, or a set whose variant axis is a device (`Size=iPhone 14`). Use
> judgment, not pattern-matching: names are often non-English (a keyboard may be "klavye"), and a
> device-width size alone doesn't make a set chrome. Propose a keep/exclude split, confirm with the
> user, and generate only the in-scope sets — never the whole catalog by default.

For each in-scope set:

```sh
node cli/codegen.mts ir-<name> <set> --framework web --out src/components --theme-import ../theme \
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

## Step 5 — Group, then elevate the scaffold (REQUIRED — the deliverable)

The scaffold is never shipped. Every in-scope component is still elevated — grouping changes only
**how many subagent calls** do it (fewer, larger calls amortize the fixed per-call overhead and
flatten the rate-limit spike), never the coverage.

### Group into subagent batches

A harness judgment call (like Scope and Mode), confirmed with the user before any subagent runs.
It operates **only on the in-scope set** — grouping never re-opens the Scope decision.

1. **Inventory** the in-scope units: variant count per set (`raw.mts components`) and node count
   (the IR component JSON).
2. **Score complexity** with a simple signal — e.g. `variants × nodes × structural-group count`.
   This separates the high-complexity units from the rest.
3. **Propose batches.** Keep related/similar units together so shared sub-structure is extracted
   once; isolate a high-complexity unit in its own batch; collapse a homogeneous low-complexity
   family into a single batch regardless of member count; pack each batch as large as one
   subagent's context reliably handles (read-footprint of the grouped scaffolds + headroom for the
   output it writes + reasoning). **No count caps — the ceiling is context capacity, and the fewest
   batches wins.**
4. **Confirm with the user.** Present the proposed batches; let them adjust **membership** and
   **granularity** (coarser = fewer/larger batches, bigger blast radius; finer = more/smaller
   batches, smaller blast radius). Granularity is the user's lever in place of any hardcoded cap.
5. **Record** the confirmed plan to `$WORK/groups-elevate.json`, then spawn one subagent per group
   from it.

```jsonc
{
  "kind": "elevate", // or "assemble" (Step 6)
  "irDir": "ir-<name>",
  "themeNote": "<the theme import + how bound values reference it>",
  "componentsDir": "<assemble only: where the elevated components live>",
  "groups": [
    {
      "id": "<stable id>",
      "rationale": "<why these are together / why solo>",
      "members": [
        // elevate:  { slug, scaffoldDir, irComponentJson, outFile }
        // assemble: { slug, screenJson, outFile }
      ],
    },
  ],
}
```

### Elevate

**Spawn the elevate subagent once per group in `groups-elevate.json`** —
`figma-to-ui/agents/elevate.md` — passing the group's member list (each member's slug, scaffold
dir, IR component JSON, out file) and the shared theme note. The codegen scaffold is its FIXED
source of truth: it refactors form (opaque keys → semantic names, N near-identical variant files →
one prop-driven component, repeated subtrees → shared sub-components, variant axes → props)
**without changing a single resolved value** (geometry, padding, gap, radius, colour token,
typography, borders, effects, absolute position, the variant→structure map). It resolves every
`// TODO` and ships zero. Icons already arrive wired as `<NameIcon size color/>` — it preserves
them. When the same subtree recurs across members of a group, it is extracted once and shared —
this changes only where the code lives, never a resolved value.

This is unconditional: codegen makes the scaffold data-complete (icons + images wired), so there is
no precondition to wait on and no reason to skip. A raw scaffold presented as finished is a defect.

## Step 6 — Assemble the screens

**Group the in-scope screens with the same mechanism as Step 5** (`raw.mts`/screen IR inventory →
score `nodes × instances` → propose batches that keep related screens together, isolate
high-complexity screens, and pack each to context capacity → confirm membership & granularity →
write `$WORK/groups-assemble.json` with `kind: "assemble"`).

**Spawn the assemble-screen subagent once per screen group in `groups-assemble.json`** —
`figma-to-ui/agents/assemble-screen.md` — passing the group's member list (each member's slug,
screen IR path, and out file), the shared elevated components dir, and the theme note. It walks
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
node cli/export-svg.mts msg-<name>.json <guidKey> out.svg [--png] [--recolor=currentColor]
```

Video fills (from the zip's `videos/` by content hash) are the only assets left to wire by hand.

---

## Verification

All deterministic — no visual-diff/fidelity step:

- `npm test` (`selftest.mts`) — the unit suite (IR, theme, svg-lib, prop model).
- TypeScript: the generated components + screens must typecheck in the consuming app.
- Re-read the elevated component / assembled screen against the IR: every resolved value traces back.

## Toolkit

| Stage           | Scripts                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Decode & locate | `parse`, `tree`, `find`, `node`                                                                    |
| IR spine        | `build-ir`, `theme-gen`, `codegen`, `diff-ir`, `ir`                                                |
| Assets          | `export-svg`, `icons`, `svg-lib` (shared geometry core)                                            |
| Raw query       | `cli/raw.mts <dump\|resolve\|overrides\|variables\|components\|intent\|match-tokens\|diff-frames>` |
| Test            | `selftest.mts` (`npm test`)                                                                        |

Full usage, every flag, the `.fig` format, the node-field tables, and the IR schema →
**[`REFERENCE.md`](./REFERENCE.md)**.
