---
name: figma-to-ui
description: Decode binary Figma .fig export files locally — no Figma account, plugin, or REST API. Use when given a .fig file and asked to implement UI 1:1, or to extract design tokens (colors, typography), screen layouts, copy/text, components, icons, SVG vectors, or image/video assets from a Figma design.
---

# Figma `.fig` → 1:1 UI implementation harness

This is a **harness**, not a grab-bag of scripts. You compile a `.fig` into a
**Design IR** once, then drive a fixed sequence to a pixel-faithful app/website:

```
parse → build IR ─┬─▶ theme-gen   (variables → theme: 1:1 mapped tokens)
                  ├─▶ codegen      (components: faithful per-variant scaffold)
                  │      └─▶ ELEVATE (you, as a Staff SWE) → clean components
                  │              guardrail: fidelity.mts + render --ir + ir-validate
                  └─▶ screens      (assemble: locate instances → your components + IR nodes)
```

The foundation is three things, in order: **(1)** real theming derived from the
file's variables, **(2)** 1:1-mapped components built from the designer's
component sets, **(3)** those components located under the screen nodes and the
rest filled from IR node data (size, position, auto-layout, typography, color,
every style property). Get those right and the whole design comes out 1:1.

**Read via the IR, never the blob.** The decoded `message.json` is ~80MB for a
20MB fig — never load it into context. After `build-ir`, read the small
per-screen / per-component JSON **directly** as your source of truth. The raw
scripts (`raw.mts …`, `tree`, `find`, `node`) are the quick-query path and the
verifier the IR is checked against — additive, not the reading default.

**Field-level details live in [`REFERENCE.md`](./REFERENCE.md)** — the `.fig`
binary format, the full node-field mapping tables, the component/override model,
vector→SVG, the IR node schema, the pitfalls checklist, and every script's flags.
Reach for it when you need a specific field; you don't need to read it to follow
this harness.

---

## Operating principles (read before executing)

Implementing a whole design is long and content-intensive. These principles keep
the work faithful and keep you from inventing values. They override any instinct
to "just produce something."

1. **Deterministic by default.** Everything `build-ir` emits is a pure function of
   the `.fig` bytes. You do not guess geometry, color, type, or structure — you
   read it from the IR. If a value isn't in the IR, you find it with a raw query or
   you ask; you never make it up.
2. **Judgment lives in named slots — nowhere else.** Genuine human decisions are
   confined to **`decisions.json`** (everything that changes IR *data* — fonts,
   colors, placeholder copy, canonical pages) plus two **inline codegen choices**
   that don't change the IR: *what to build* (the codegen scope — never blindly
   generate the whole catalog) and *how to handle icons/vectors*. Everything else is
   mechanical.
3. **STOP at every decision point.** The [Decision points](#decision-points--stop-and-ask-the-user)
   table lists every place you must stop and ask the user. An unanswered decision is
   a **blocker, not a default** — do not ship a master default, a bare literal, or a
   guessed answer to skip a question.
4. **Resolve every `// TODO` before a component ships.** The codegen scaffold marks
   every unconfirmed value with a `// TODO`. A component is not done while one
   remains. See [Step 5](#step-5--elevate-the-scaffold-the-core-of-the-harness) for
   the auto-resolve-vs-ask taxonomy.
5. **Prove 1:1, don't assert it.** Fidelity is established by the guardrail
   (`fidelity.mts` contract + `render --ir` diff + `ir-validate.mts` gate), not by
   your judgement that it "looks right."
6. **One named artifact per fig.** Parse each `.fig` into a **named** `msg-<name>.json`
   and compile a matching `ir-<name>/`; never reuse a bare `message.json` (two
   designs collide and you can't tell which decode you're reading).

## Decision points — STOP and ask the user

The harness is deterministic except for genuine judgment calls. At each point below,
STOP, present the options (with the inventory the scripts give you), and get the
user's answer. Rows marked **→ decisions.json** are *data* decisions: record the
answer there and re-build, so the result stays reproducible (see
[Determinism contract](#determinism-contract)). The codegen scope and the icon policy
are the decisions that don't change IR data, so they stay inline.

| When | Decision to ask | Where the answer lives |
|---|---|---|
| Step 1 (after decode) | Which pages are **canonical** vs. scratchpad/wip/notes | `canonicalPages` **→ decisions.json** |
| Steps 2 & 5 | **Placeholder copy** (master defaults like `Test`/`Heirloom`) — what's the real text? | `placeholders` **→ decisions.json** |
| Steps 2 & 5 | **`match:none` / unconfirmed `nearest` colors** — which token, or deliberately new? | `tokenConfirms` / `tokenRejects` **→ decisions.json** |
| Steps 2 & 5 | **Unmapped fonts** (no app-family) — which app font? | `fontMap` **→ decisions.json** |
| Step 4 (before codegen) | **Which components to build** — scope to the task; exclude platform/system & device-chrome sets (iOS/Android keyboards, status bars, home indicators, device frames like `iphone-x-or-newer`) | inline — codegen scope |
| Steps 7 & 5 | **Icon/vector strategy** — library import vs. export-svg vs. hybrid (ask every run) | inline — drives TODO resolution |
| Step 6 (brownfield) | **Token conflicts** — fig value vs. an existing repo token; intentional divergence? | ask before overwriting; `issues.json` is the list |

`ir-validate.mts` (the ship gate) stays red until the `decisions.json` rows are
authored — a red gate **is** the automated "ask, don't ship" list.

---

## Setup

```sh
WORK=/tmp/figparse && mkdir -p $WORK && cd $WORK
cp <repo>/scripts/*.mts .
npm init -y >/dev/null 2>&1 && npm i kiwi-schema   # or pnpm/yarn/bun add
```

Scripts are plain Node-compatible `.mts` — run with `node <script>.mts …`
(Node ≥ 22.18 runs TypeScript directly and ships `zstd`), or `bun` / `npx tsx`.
The only hard floor is **Node ≥ 22.15 or Bun** (for `zlib.zstdDecompressSync`).

---

## Step 1 — Decode & scope

```sh
unzip -o file.fig -d $WORK/ex
node parse.mts $WORK/ex/canvas.fig $WORK/msg-<name>.json
node tree.mts  $WORK/msg-<name>.json          # pages + top-level frames
node find.mts  $WORK/msg-<name>.json "<regex>"
```

Page/frame **names** carry the information architecture. Reject scratchpad pages
(`trial`, `old`, `draft`, `wip`, `-`, or local-language equivalents) and read any
`todo`/notes page — designers leave undecided-content notes there.

> **Decision point —** *Confirm the canonical pages with the user before compiling*
> (the IR build is scoped to them). Record them in `canonicalPages`.

## Step 2 — Build the IR

```sh
node build-ir.mts msg-<name>.json --scope <pages|all> --out ir-<name>
```

This is a **pure function of the bytes**. It emits a small, provenance-stamped
`ir-<name>/`: `manifest.json` + `raw-map.json` + `fonts.json` + `tokens/*` (incl.
`variables.json`, the complete variable catalog) + `components/<set>.json`
(variant matrix + prop API + per-variant bindings) + `screens/<page>/<screen>.json`
(resolved instances, reconciled text with `sizeSource`+`conflicts[]`, placeholder
detection, absolute coords, full `style`/`layout` per node). Read those files
directly — they are KB-scale. **Trust the reconciled `font.size`, not the raw
`fontSize`** (a 28px font whose 20px box can't fit it carries `size:16,
sizeSource:"geometry"`).

**The decisions loop (the only non-deterministic input).** With a code theme,
add `--theme <path>`; the build then also writes **`issues.json`** (the
ask-don't-ship list: unmapped fonts, `match:none`/unconfirmed `nearest` colors,
reconciliation conflicts) and **`intent.json`** (placeholders, repeated/denylisted
strings, default-variant instances, mono-color icons). Read both, resolve them
into a **`decisions.json`** overlay, then re-run with `--decisions decisions.json`.
Same source hash + same decisions hash = a reproducible no-op.

```sh
node ir-validate.mts ir-<name>     # the SHIP GATE — exits non-zero on any
                                   # unresolved token/font/placeholder/conflict.
```

A failing gate **is** the automated "ask, don't ship" list: each line names a
node `guid` and the `decisions.json` entry that resolves it. Drive it to green by
authoring `decisions.json`, then re-build. (See the `decisions.json` schema at
the end.) Detection is deterministic; **resolution is the decision** — the
unmapped-font / `match:none`-color / placeholder rows are all
[decision points](#decision-points--stop-and-ask-the-user): ask, then record.

> **Done when —** `ir-validate.mts` exits **green** (zero unresolved tokens, fonts,
> placeholders, or conflicts).

## Step 3 — Theme from the variables (the foundation)

Variables are the design tokens. Turn the IR's complete catalog into a typed
theme — this is your "1:1 mapped variables":

```sh
node theme-gen.mts ir-<name>                 # → theme.ts (rn) + theme.css (web)
node theme-gen.mts ir-<name> --framework web --out src/theme
```

It mirrors Figma's `/`-hierarchy (`Color/praline/950` → `color.praline['950']` /
`var(--color-praline-950)`), keyed by **mode** (light/dark), and emits **aliases
as code references to their target** (never collapsed), so the token graph stays
intact. Every variable-**bound** value in the IR (`color.var`, `font.vars.*`)
already carries its token as ground truth — the theme makes those references real
in code. Generate the theme first so the next step can point components at it.

## Step 4 — Components: the faithful scaffold

> **Decision point — scope what gets built (before you codegen).** A `.fig` usually
> ships platform/system & device-chrome sets that are NOT your product: iOS/Android
> **keyboards**, **status bars**, **home indicators**, **device frames**
> (`iphone-x-or-newer`), system nav bars, and `time`/battery/signal chrome. Inventory
> the sets first (`ir-<name>/manifest.json` → `components[]`, or `ls ir-<name>/components/`),
> flag the likely-irrelevant ones by name, propose a task-relevant scope, and **confirm
> with the user**. Generate only the in-scope sets — never the whole catalog by default.

For each **in-scope** component set, generate the scaffold from its master:

```sh
node codegen.mts ir-<name> <set> --framework web --out src/components --theme-import ../theme \
  --images <unzipped-fig>/images
```

You get a folder: `index.tsx` (a dispatcher switching on the variant prop),
`types.ts` (`Props` = the variant union + collapsed non-variant props), and **one
`<variant>.tsx` per variant**. Each variant file renders **that variant's own
resolved subtree** as a real JSX tree with reconciled per-node
style/layout/font/text, bound values referencing the theme, and `// TODO`s on
every placeholder/conflict/unmapped value.

**Pass `--images <unzipped-fig>/images` so real raster fills are wired, not
TODO'd.** With it, codegen **extracts** each referenced image fill (product
photos, thumbnails) into `<slug>/assets/` and emits a real reference — web
`backgroundImage: url('./assets/<hash>.png')`, rn `<Image source={require(…)}>`
— so the elevate step sees the actual image instead of a placeholder box. Without
it, image fills stay as `// TODO` (re-run with `--images` to wire them).

**The scaffold marks, it never guesses.** It leaves a clearly-marked `// TODO` on
every placeholder text, unmapped font, open conflict, `match:none` color, and
vector/icon (it *cannot* draw vector paths). It never bakes an unconfirmed value
silently — every TODO is attributed to the variant in its block and aggregated in
the file's `REVIEW` block. Those TODOs are Step 5's worklist.

**Why one file per variant, not CSS conditionals?** On purpose. Figma variants
frequently have **different frame structures** — a `SingleLine` header has no
subtitle node; a `Modal` header adds a close-icon slot; a column in one variant
is a row in another. Collapsing those into conditional styling would break the
structure. The scaffold is **faithful but verbose** — it is *raw material*, not
the finished component.

## Step 5 — Elevate the scaffold (the core of the harness)

Now act as an experienced Staff SWE. Refactor the scaffold into the component you
would actually ship — **without breaking the 1:1 mapping**.

**Elevation is a refactor *of codegen's output*, not a re-derivation from the IR.**
Codegen is the **source of truth**: every value it resolved — geometry, per-side
padding, gaps, radii, colour tokens, typography, and the variant→structure mapping —
is a FIXED input. Never re-measure or re-derive from the `.fig`/IR; a from-scratch
rewrite reliably loses values codegen transcribed correctly. Elevation may change only
*form*: opaque style-key names → semantic names, N near-identical variant files → one
token-driven component, repeated sub-trees → small shared sub-components, variant axes
→ props. It must not change a single resolved value.

> **Precondition — elevate only once the scaffold is DATA-COMPLETE.** Codegen now
> carries the IR's vector/icon data through (size + every fill + token + resolved
> colour), flags every instance-swap default, and renders master-visible content by
> default. If any of that is missing (an un-flagged empty slot, a hidden master node,
> a vector with no fills note), the scaffold isn't yet a trustworthy source of truth —
> fix codegen first; don't elevate against a guess.

The most reliable way to hold this line is to **spawn the elevate subagent once per
component** — `figma-to-ui/agents/elevate.md` — passing the component's paths (slug,
scaffold dir, IR component JSON, out file, theme note, icon note). Its prompt forbids
changing any resolved value, so it refactors for elegance without drifting into
re-derivation (the `skill-creator` ships its agents the same way).

**Do:**
- **Re-bind to the theme.** Every value annotated `// var …` / `// token …`, and
  every bound value, must reference the generated theme (`theme.color.praline[950]`
  / `var(--color-praline-950)`), not a literal.
- **Name things.** Replace opaque style keys (`n_n_5a20…`) with semantic names.
- **Extract shared sub-structure** into small components (a title block, an
  action row) and reuse across variants.
- **Consolidate variants — but only where the subtree structure is genuinely
  identical.** If two variants differ only in a token or a string, merge them and
  drive the difference from a prop. If their node trees differ, **keep them
  separate**. Use the fidelity contract (below) to decide: identical structure =
  identical contract trees.

**Resolve EVERY `// TODO` — a component must not ship with one open.** Two classes:

- **Auto-resolvable by you, deterministically (no user input needed):**
  - *Vector/icon* TODOs (`// TODO: export "<name>" via export-svg`) → resolve per
    the **icon/vector policy** chosen in Step 7: a library-named icon becomes an
    import + `<Icon/>`; an exported vector becomes an inlined `<svg>` / `<Image>`.
    No `export-svg` placeholder box may remain.
  - *Image fills* → already extracted + wired if Step 4 ran with `--images`; if a
    TODO remains, re-run codegen with `--images`.
  - *Color / font* TODOs → once the decision is recorded in `decisions.json` and the
    IR re-built, the value is confirmed; re-bind to the theme.
  - *Interactive-archetype markers* (slider/stepper) → wire `value`/`onChange`.
  - Opaque style-key names → rename (above).
- **Require a user decision first** (these are [decision points](#decision-points--stop-and-ask-the-user)):
  *placeholder copy*, *`match:none`/`nearest` colors*, *unmapped fonts*, *icon
  strategy*. Resolve via `decisions.json` + re-build (the data ones) or the chosen
  icon policy. **Never** ship a `Test`/master default or a bare literal to silence a
  TODO — ask.

**Don't break (the invariants):** per-node geometry (w/h/padding/gap), typography
(family/size/lineHeight/letterSpacing/weight/case), color tokens, per-side
borders, radius, effects, absolute positioning, and the variant→structure mapping.

**The guardrail — prove you didn't break it:**

```sh
# 1. The contract: the per-node invariants your refactor MUST preserve.
node fidelity.mts ir-<name> <set> --variant <v>          # human-readable
node fidelity.mts ir-<name> <set> --variant <v> --json   # machine-readable
```

`fidelity.mts` (contract mode) walks the variant's resolved subtree and prints
every must-preserve invariant, with a `styleKey` that maps 1:1 to the scaffold's
style block. Diff your elevated component against it — every line must still hold.

```sh
# 2. The visual backstop (needs Chrome + a screenshot of your component).
node render.mts --ir ir-<name> <variant-guid> ref.png    # the IR reference render
node fidelity.mts ir-<name> <set> --variant <v> --candidate app.png --out diff.png
```

This renders the IR reference and diffs your app's screenshot against it,
reporting a drift score + the worst regions (+ a heatmap). It **surfaces** drift;
you adjudicate — real copy replacing a placeholder is an expected, legitimate diff.

```sh
# 3. Re-gate.
node ir-validate.mts ir-<name>
```

> **Definition of Done (per component)** — all must hold before assembling screens:
> - [ ] **Zero `// TODO`** left (the `REVIEW` block is empty).
> - [ ] Every bound / `var` / `token` value references the generated theme, not a literal.
> - [ ] No placeholder / master-default copy remains.
> - [ ] Icons & vectors resolved per the chosen policy (no `export-svg` placeholder boxes).
> - [ ] `fidelity.mts` contract holds; `render --ir` matches; `ir-validate.mts` is green.

## Step 6 — Assemble the screens

Read `ir-<name>/screens/<page>/<screen>.json` directly. Walk the node tree and
emit code from each node's IR data — `layout` (flex-direction/gap/padding/
justify/align), `box` (size; `absX/absY` for absolute children), `style` (fills/
strokes/borderWidths/cornerRadius/effects/opacity), and TEXT `font`/`text`. Every
property needed for a 1:1 build is on the node.

**Use the designer's components.** Where a screen node is a component
**instance**, do not re-draw it from scratch — render it through the component you
elevated in Step 5, passing props from the instance's resolved overrides (its
text, its variant, its toggles). The screen IR has already resolved the instance,
so its subtree shows you exactly which variant and which prop values to pass; map
the instance back to its set via `components/<set>.json` (or `raw-map.json`). This
is what makes the screens 1:1 *and* maintainable: shared components, not
copy-pasted node trees.

Eyeball each assembled screen:

```sh
node render.mts --ir ir-<name> <screen-id> out.png
```

**Brownfield?** If the consuming repo already has a theme, switch to **map mode**:
run `build-ir … --theme <path>`, match fig values to code tokens **by value, never
by name**, and **respect intentional divergence** (a deliberate token alias, a
licensed-font substitution).

> **Decision point —** *Prefer asking over overwriting.* `issues.json`'s
> `nearest`/`none` rows are the "ask, don't overwrite" list — confirm a conflicting
> token with the user before changing it.

## Step 7 — Assets

```sh
node icons.mts      msg-<name>.json <screen-guidKey>   # icon instances → library export names (Phosphor …)
node export-svg.mts msg-<name>.json <guidKey> out.svg [--png]   # vector logos/illustrations
```

The scaffold leaves every vector/icon as a `// TODO` (codegen cannot draw paths) but
now carries its resolved data *through* that TODO — size, every fill (hex + token),
and (for a mono-fill icon) the resolved colour (finding #1). With that data, the
**default policy is OWNED icons: export the geometry from the `.fig` and build a local,
recolorable 1:1 icon set.** An icon library is **opt-in** — only when the user asks.

Why owned-by-default: the `.fig` holds the exact paths, fills and per-context colours.
A library can only *approximate* — it can't reproduce a custom `Format`/`Weight` axis,
an off-library glyph, or a brand mark, and it adds a runtime dependency. Exporting
replicates every icon 1:1 with zero external deps.

> **Decision point — confirm the icon/vector strategy (default: owned).**
> Run `icons.mts` first to inventory the icon instances and the `AppIconName` union.
> - **(a) Owned, exported (default).** Export each icon set's geometry via
>   `export-svg.mts` (now faithful to *every* path and *every* fill, finding #4) and
>   elevate it into an owned component that is **recolorable** (`currentColor` / a
>   `color` prop — the `RoastSquare` pattern). The elevation step reads the exported
>   code + the IR and decides the component shape itself — including `Format`/`Weight`
>   variants — exactly as for any other component. A subagent pipeline:
>   *inventory → export each set → elevate into an owned component.*
> - **(b) Existing icon library** (Phosphor / lucide / custom) — **opt-in**, when the
>   user asks and layer names are library exports (`MagnifyingGlass`, `CaretUpDown`).
>   Map each icon-instance layer name to a library import. **Do not export.**
> - **(c) Hybrid** — owned for custom logos / illustrations / brand marks, library for
>   the rest. Reasonable when the user wants a library but some glyphs are off-library.
>
> After the choice, resolve **every** vector `// TODO` per that policy in Step 5 — no
> `export-svg` placeholder box may remain.

**Raster image fills referenced by a component are already extracted + wired** when
Step 4 ran with `--images` (into `<slug>/assets/`); only `export-svg` vectors/logos
and any video fills (from the zip's `videos/` by content hash) remain to wire by
hand.

---

## Determinism contract

Everything `build-ir` emits is a pure function of the `.fig` bytes **except** the
values read from `--decisions <decisions.json>`. That file is the single judgment
slot for **data** — a human/LLM authors it by reading `issues.json` + `intent.json`.
Never let the model "build the IR"; it only writes `decisions.json`. Detection
(conflicts, placeholders) is always deterministic; **resolution** is the decision.
(The judgments that are *not* data — the codegen scope of Step 4 and the icon/vector
policy of Step 7 — stay inline because they shape generated code, not the IR.)

```json
{
  "fontMap":       { "Neulis Sans": "Figtree" },
  "tokenConfirms": { "color:#bda799": "theme.colors.praline300", "fontSize:16": "theme.fontSize.md" },
  "tokenRejects":  ["color:#5a3a2a"],
  "placeholders":  { "1273:19842": { "placeholder": false, "text": "Heirloom" } },
  "canonicalPages": ["Screens", "Components"]
}
```

- `fontMap` → fills each matching node's `font.appFamily` (clears the unmapped-font
  issue). `tokenConfirms` keys are `kind:value` (`color`/`fontSize`/…); only
  `color`/`fontSize` bind into IR nodes — upgrades a `nearest`/`none` to a
  confirmed `exact` + token. `tokenRejects` confirms "deliberately new" (keeps the
  literal, marks `match:"rejected"`, suppresses the issue). `placeholders`
  overrides `text.placeholder`/`value` per guid. Hex is lower-cased 6-digit;
  numbers are unit-less — the build canonicalizes the key and the IR value alike.

## Toolkit

| Stage | Scripts |
|---|---|
| Decode & locate | `parse`, `tree`, `find`, `node` |
| IR spine | `build-ir`, `theme-gen`, `codegen`, **`fidelity`**, `ir-validate`, `render --ir`, `diff-ir`, `ir` |
| Assets | `export-svg`, `icons` |
| Raw query / verify | `raw.mts <dump\|resolve\|overrides\|variables\|components\|intent\|match-tokens\|diff-frames>` |
| Test | `selftest.mts` (`npm test`) |

Full usage, every flag, the `.fig` format, the node-field tables, the IR schema,
and the pitfalls checklist → **[`REFERENCE.md`](./REFERENCE.md)**. Confirm a raw
field before relying on it with `node node.mts msg-<name>.json <guidKey> [field…]`.
