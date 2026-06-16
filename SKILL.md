---
name: figma-to-ui
description: Decode binary Figma .fig export files locally — no Figma account, plugin, or REST API. Use when given a .fig file and asked to implement UI 1:1, or to extract design tokens (colors, typography), screen layouts, copy/text, components, icons, SVG vectors, or image/video assets from a Figma design.
---

# Decoding `.fig` files for 1:1 frontend implementation

Extract **authoritative design data** from a binary Figma `.fig` export. The
node data contains exact colors, font sizes, line heights, paddings,
auto-layout rules, and text content — implementing from it is pixel-faithful,
unlike guessing from screenshots, and it surfaces *designer-intent gaps*
(e.g. component instances whose text was never overridden = copy not decided
yet).

Ready-to-run scripts live in the `scripts/` directory. Verified
against fig-kiwi format version 106 (2026).

## 0. Setup

```sh
WORK=/tmp/figparse && mkdir -p $WORK && cd $WORK
cp <repo>/scripts/*.ts .
npm init -y >/dev/null 2>&1 && npm i kiwi-schema   # or: pnpm add / yarn add / bun add kiwi-schema
```

**Runtime is your choice** — the scripts are plain Node-compatible code (no
Bun-only APIs), so run them with whatever the host project uses:

- `node <script>.ts …` — Node ≥ 22.18 runs TypeScript directly (and ships
  `zstd`); the default below.
- `bun <script>.ts …` — works as-is.
- `npx tsx <script>.ts …` (or `pnpm dlx tsx` / `yarn dlx tsx`) — for older Node.

Install the single dependency (`kiwi-schema`) with the project's package
manager (`npm i` / `pnpm add` / `yarn add` / `bun add`). The only hard floor is
**Node ≥ 22.15 or Bun** for `zlib.zstdDecompressSync`. Keep all intermediates in
the work dir; **never load `message.json` into context** (~80MB for a 20MB fig)
— query it with the scripts.

## 1. Container format

A `.fig` file is a **ZIP archive** (first bytes `PK\x03\x04`):

```
file.fig (zip)
├── canvas.fig        # the document — binary "fig-kiwi" format (§2)
├── images/           # raster assets, filenames = SHA-1 of content (no extension)
├── videos/           # video assets, same naming
├── meta.json         # file name, thumbnail size, export timestamp
└── thumbnail.png     # small render of the last-viewed page
```

```sh
unzip -o file.fig -d $WORK/ex && file $WORK/ex/images/* | head
```

## 2. `canvas.fig`: fig-kiwi binary → JSON

```
bytes 0–7    magic "fig-kiwi"
bytes 8–11   uint32 LE version
then chunks: [uint32 LE byteLength][data] repeated
```

- **Chunk 0** = the [kiwi](https://github.com/evanw/kiwi) binary schema,
  raw-deflate compressed. Because the schema is embedded, decoding survives
  format evolution.
- **Chunk 1** = the document message, **zstd** in modern files (magic
  `28 B5 2F FD`), raw deflate in older ones.

```sh
node parse.ts $WORK/ex/canvas.fig $WORK/message.json
```

`parse.ts` handles both compressions, serializes BigInts as strings, and
Uint8Arrays as byte arrays (hashes get hex-encoded later; geometry blobs are
parsed in §6).

## 3. The node graph

`message.nodeChanges` is a **flat array** of every node (tens of thousands).
There is no nested tree — `lib.ts` rebuilds it:

- Identity: `node.guid = {sessionID, localID}` → string key
  `"${sessionID}:${localID}"`.
- Parent: `node.parentIndex.guid`; `parentIndex.position` is a
  fractional-index string — sort children lexically by it.
- Roots: `type === "DOCUMENT"` → children are `CANVAS` (pages) → children are
  top-level frames/sections.

**First move — print the skeleton, then locate things by name:**

```sh
node tree.ts $WORK/message.json                      # pages + top-level frames with guid keys
node find.ts $WORK/message.json "tab.?bar"           # search nodes by name regex
node find.ts $WORK/message.json "." SYMBOL           # list all component masters
```

Page and frame *names* carry the information architecture. Watch for
scratchpad pages (`trial`, `old`, `draft`, `wip`, `-`, or local-language
equivalents) — those are rejected explorations; ask the user which pages are
canonical if naming doesn't make it obvious. Also look for a `todo`/notes
page: designers leave notes there about undecided content.

## 4. Node fields that matter for UI code

| Field | Meaning / mapping |
|---|---|
| `type` | `FRAME`, `TEXT`, `INSTANCE`, `SYMBOL` (component master), `CANVAS`, `SECTION`, `VECTOR`, `ROUNDED_RECTANGLE`, … |
| `name` | layer name — semantic gold (`product-card`, `tab-bar`, `icons/Nav/Home`) |
| `visible` | absent = visible; `false` = hidden (skip it) |
| `size` | `{x: width, y: height}` |
| `transform` | 2×3 matrix `{m00,m01,m02,m10,m11,m12}`; `m02`,`m12` = x,y relative to parent |
| `fillPaints[]` / `strokePaints[]` | `type: "SOLID"` with `color` as **0–1 floats** `{r,g,b,a}` (×255 → hex); `type: "IMAGE"` with `image.hash` (bytes → hex = filename in `images/`, §7); gradients carry `stops[]` |
| `strokeWeight`, `strokeAlign` | border width / position |
| `cornerRadius` or `rectangleTopLeftCornerRadius` (×4) | border radius |
| `effects[]` | shadows/blurs (`type`, `color`, `offset`, `radius`) |
| `opacity` | layer opacity |

**Auto-layout** (flexbox, on frames):

| fig field | CSS / RN equivalent |
|---|---|
| `stackMode: "HORIZONTAL" \| "VERTICAL"` | `flexDirection: row \| column` |
| `stackSpacing` | `gap` |
| `stackVerticalPadding`, `stackHorizontalPadding`, `stackPaddingBottom`, `stackPaddingRight` | `paddingTop`, `paddingLeft`, `paddingBottom`, `paddingRight` (yes — the first two are **top/left**) |
| `stackPrimaryAlignItems` | `justifyContent` (`MIN`/`CENTER`/`MAX`/`SPACE_EVENLY`/`SPACE_BETWEEN`) |
| `stackCounterAlignItems` | `alignItems` |
| absent/`NONE` | absolute positioning via child `transform` |

**Text** (`type: "TEXT"`):

- `textData.characters` — the actual string (this is how you get all copy).
- `fontName: {family, style}`, `fontSize`, `lineHeight: {value, units}`
  (`PIXELS` or `PERCENT`), `letterSpacing: {value, units}`,
  `textAlignHorizontal`.
- Mixed-style runs live in `textData.styleOverrideTable` — rare in app UI;
  flag if styling looks inconsistent within one string.

## 5. Components, instances, and overrides

- Masters are `type: "SYMBOL"` nodes; their subtree is regular nodes.
- `type: "INSTANCE"` nodes have **no children in the tree**. They point to
  the master via `symbolData.symbolID` (a guid). To render an instance, walk
  the master's subtree…
- …then apply `symbolData.symbolOverrides[]`: each entry has
  `guidPath.guids` (path of guids into the master, possibly nested through
  inner instances) plus the overridden fields (`textData`, `fillPaints`,
  `size`, `visible`, …). This is where per-instance text lives.

```sh
node overrides.ts $WORK/message.json <screen-guidKey>
```

**Designer-intent signal:** an instance with *no* `textData` override renders
the master's placeholder text (e.g. every CTA button on a screen showing the
master's default label = copy never decided). Detect this and **ask the user
instead of shipping placeholders**.

## 6. Vector geometry → SVG (logos, illustrations, custom icons)

Vector shapes index into `message.blobs`:

- `node.fillGeometry[] = {windingRule, commandsBlob}`; likewise
  `strokeGeometry` (already stroke-outlined — render it as a **fill**).
- `blobs[i].bytes` is `[uint8 opcode][float32 LE args…]` with opcodes
  `0=Z`, `1=M x y`, `2=L x y`, `3=Q cx cy x y`, `4=C c1x c1y c2x c2y x y`.
- Compose each node's `transform` down the tree
  (`matrix(m00 m10 m01 m11 m02 m12)` in SVG argument order); the export
  root's own transform is dropped (it becomes the viewBox origin).
- `windingRule: "ODD"` → `fill-rule="evenodd"`, else `nonzero`.
- Fill color from `fillPaints[0].color`; multiply node × paint opacities.

```sh
node export-svg.ts $WORK/message.json <guidKey> out.svg
```

`export-svg.ts` follows `symbolData.symbolID` into masters, so icons/logos
that wrap component instances export correctly (per-instance fill overrides
are not applied — recolor in the consuming component).

Small results (logos, icons) → inline `<svg>` / `react-native-svg`
components. Large hand-drawn ones (100+ paths) → rasterize for runtime
performance. Headless Chrome rasterizes SVG perfectly, no ImageMagick:

```sh
"Google Chrome" --headless --disable-gpu --screenshot=out.png \
  --window-size=286,300 --force-device-scale-factor=3 \
  --default-background-color=00000000 "file:///abs/path/in.svg"
# window-size = SVG's natural px size; scale-factor 3 → @3x; 00000000 = transparent
```

(The same trick composes full-bleed splash images: a tiny HTML page that
centers the SVG on the brand background, screenshotted at 3×.)

## 7. Raster and video assets

- Image fills: `paint.image.hash` (byte array) → hex string → filename in the
  zip's `images/`. Copy + downscale (`sips -Z 800` on macOS) into app assets.
- Video fills: `paint.video.hash` → file in `videos/`. Check the codec before
  bundling (H.264 `avc1` is safe cross-platform; the `mvhd` box gives
  duration — useful for splash-animation timing).
- A screen-sized PNG in `images/` may be a *reference screenshot* of another
  app, not an asset — view it before using.

## 8. Recommended extraction workflow

1. **Unzip + parse** (§1–2); build the index. Query with scripts; never load
   `message.json` into context.
2. **Print the skeleton** (`tree.ts`). Identify canonical pages vs trials;
   confirm scope with the user. Read any `todo`/notes page.
3. **Extract tokens first.** Check for Figma variables (`variables.ts`) —
   `type: "VARIABLE"` nodes carry exact values per mode (light/dark) under
   `variableDataValues.entries`, grouped by `VARIABLE_SET`; when present they
   are the canonical token source. Otherwise scrape the colors/typography
   pages: colors often live in swatch-component instances → read
   `symbolOverrides` text (name + hex pairs). Typography pages give the full
   ramp — *trust node values over label text*; labels go stale (a label
   saying "28px" on a 36px node is real).
4. **Dump each canonical screen** (`dump.ts`) — a 50–150-line indented
   summary. This per-screen dump is the artifact that goes into
   implementation context; it is complete and unambiguous, unlike a
   screenshot.
5. **Dump component masters** referenced by instances (cards, tab bars,
   buttons, checkboxes) — these become the reusable components; variant
   names (`Style=Filled, State=Active`) document the API.
6. **Map the icon set**: icon layer names usually identify a public library
   (e.g. Phosphor: `MagnifyingGlass`, `CaretUpDown`, `HouseSimple`) — use the
   library package instead of exporting every icon.
7. **Export vectors** (§6); copy rasters/videos (§7).
8. **Diff duplicated frames** (screens often appear both on a consistency-
   test page and their own page) — duplicates with the highest `sessionID`s
   are usually newest.
9. **Implement** against the dumps, mapping auto-layout per the §4 table and
   theme-tokenizing every color/size from step 3 — no hardcoded values.

## 9. Pitfalls checklist

- [ ] Chunk 1 is **zstd** in modern files; raw-deflate only as fallback.
- [ ] `JSON.stringify` throws on **BigInt** — use a replacer.
- [ ] Instance children are **not** in the tree — resolve masters + overrides.
- [ ] Colors are 0–1 floats; alpha may be a separate `opacity` on the paint.
- [ ] `stackVerticalPadding`/`stackHorizontalPadding` are **top/left**, with
      separate `stackPaddingBottom`/`stackPaddingRight`.
- [ ] Label text in design-system pages can be stale; node properties are truth.
- [ ] Un-overridden instance text = placeholder copy → ask, don't ship.
- [ ] Hidden nodes (`visible: false`) and trial pages must be excluded.
- [ ] `strokeGeometry` is pre-outlined: render as a **fill** with the stroke paint.
- [ ] Fonts in the file may be commercial — check licensing before bundling;
      substitute behind a single token if absent.

## Scripts reference

| Script | Usage | Purpose |
|---|---|---|
| `parse.ts` | `node parse.ts <canvas.fig> <out.json>` | fig-kiwi → message.json |
| `tree.ts` | `node tree.ts <msg.json>` | page/frame skeleton with guid keys |
| `find.ts` | `node find.ts <msg.json> <regex> [type]` | locate nodes by name |
| `variables.ts` | `node variables.ts <msg.json>` | design tokens from Figma variables |
| `dump.ts` | `node dump.ts <msg.json> <guidKey> [depth]` | per-screen implementation dump |
| `overrides.ts` | `node overrides.ts <msg.json> <guidKey>` | instance text/color overrides |
| `export-svg.ts` | `node export-svg.ts <msg.json> <guidKey> <out.svg>` | vector → SVG |

All scripts import `lib.ts` (tree index + color helpers) — copy the whole
`scripts/` directory together.
