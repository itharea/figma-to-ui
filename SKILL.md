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

**Read via the Design IR by default:** for any real task, compile the scoped,
reconciled, provenance-stamped IR (§8 step 2.5) and read its per-screen JSON as
your source of truth — the raw scripts are the quick-query path and the verifier
it is checked against.

## 0. Setup

```sh
WORK=/tmp/figparse && mkdir -p $WORK && cd $WORK
cp <repo>/scripts/*.mts .
npm init -y >/dev/null 2>&1 && npm i kiwi-schema   # or: pnpm add / yarn add / bun add kiwi-schema
```

**Runtime is your choice** — the scripts are plain Node-compatible code (no
Bun-only APIs), so run them with whatever the host project uses:

- `node <script>.mts …` — Node ≥ 22.18 runs TypeScript directly (and ships
  `zstd`); the default below.
- `bun <script>.mts …` — works as-is.
- `npx tsx <script>.mts …` (or `pnpm dlx tsx` / `yarn dlx tsx`) — for older Node.

The scripts use the **`.mts`** extension on purpose: `.mts` is unconditionally
an ES module, so `import` works regardless of the surrounding `package.json`
(the `npm init -y` above writes a CommonJS one — a plain `.ts` would die with
*"Cannot use import statement outside a module"*; `.mts` does not need
`"type": "module"` anywhere). This is what makes `node` work out of the box and
keeps `bun`/`tsx` working unchanged.

Install the single dependency (`kiwi-schema`) with the project's package
manager (`npm i` / `pnpm add` / `yarn add` / `bun add`). The only hard floor is
**Node ≥ 22.15 or Bun** for `zlib.zstdDecompressSync`. Keep all intermediates in
the work dir; **never load `message.json` into context** (~80MB for a 20MB fig)
— query it with the scripts.

**Work-dir hygiene (one named file per fig).** Parse each `.fig` into a
**named** message — `msg-<name>.json` — and compile it into a matching
`ir-<name>/` directory; **never reuse a bare `message.json` across files** (two
designs collide and you can't tell which decode you're reading). The IR build
derives `ir-<name>` from the message filename, so `parse … msg-checkout.json`
→ `build-ir msg-checkout.json … --out ir-checkout/`.

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
node parse.mts $WORK/ex/canvas.fig $WORK/message.json
```

`parse.mts` handles both compressions, serializes BigInts as strings, and
Uint8Arrays as byte arrays (hashes get hex-encoded later; geometry blobs are
parsed in §6).

## 3. The node graph

`message.nodeChanges` is a **flat array** of every node (tens of thousands).
There is no nested tree — `lib.mts` rebuilds it:

- Identity: `node.guid = {sessionID, localID}` → string key
  `"${sessionID}:${localID}"`.
- Parent: `node.parentIndex.guid`; `parentIndex.position` is a
  fractional-index string — sort children lexically by it.
- Roots: `type === "DOCUMENT"` → children are `CANVAS` (pages) → children are
  top-level frames/sections.

**First move — print the skeleton, then locate things by name:**

```sh
node tree.mts $WORK/message.json                      # pages + top-level frames with guid keys
node find.mts $WORK/message.json "tab.?bar"           # search nodes by name regex
node find.mts $WORK/message.json "." SYMBOL           # list all component masters
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
| `borderStrokeWeightsIndependent` + `borderTop/Right/Bottom/LeftWeight` | **per-side** border widths (when independent these apply INSTEAD of `strokeWeight`; absent side = 0). Lets a **bottom-only divider** survive. IR `style.borderWidths {top,right,bottom,left}` → `border-<side>-width` |
| `strokeCap`, `strokeJoin`, `dashPattern` | optional stroke detail: `cap`/`join` lower-cased (`join:MITER` is default → omitted), `dashPattern` (`number[]`, e.g. `[10,5]`) → **dashed** stroke (`border-style:dashed` / SVG `stroke-dasharray`). IR per-stroke `cap?`/`join?`/`dash?` |
| `cornerRadius` or `rectangleTopLeftCornerRadius` (×4) | border radius |
| `effects[]` | shadows/blurs (`type`, `color`, `offset`, `radius`) |
| `opacity` | layer opacity |

**Auto-layout** (flexbox, on frames):

| fig field | CSS / RN equivalent |
|---|---|
| `stackMode: "HORIZONTAL" \| "VERTICAL"` | `flexDirection: row \| column` |
| `stackSpacing` | `gap` |
| `stackVerticalPadding`, `stackHorizontalPadding`, `stackPaddingBottom`, `stackPaddingRight` | `paddingTop`, `paddingLeft`, `paddingBottom`, `paddingRight` (yes — the first two are **top/left**) |
| `stackPrimaryAlignItems` | `justifyContent` (`MIN`/`CENTER`/`MAX`/`SPACE_EVENLY`/`SPACE_BETWEEN`). Codegen/render disambiguate `SPACE_EVENLY`→`SPACE_BETWEEN` by **resolved child geometry** (in-flow children flush at both main-axis ends → `space-between`) |
| `stackCounterAlignItems` | `alignItems` |
| `stackPrimarySizing` / `stackCounterSizing` | container self-sizing on the main/cross axis: `FIXED` → fixed `width`/`height`; `RESIZE_TO_FIT…` → **hug** (`width`/`height: auto`, content-driven). IR `layout.primarySizing`/`counterSizing` = `fixed`\|`hug` |
| `stackWrap: "WRAP"` | `flexWrap: wrap`. IR `layout.wrap = true` |
| absent/`NONE` | absolute positioning via child `transform` |

**Per-child sizing & constraints** (on the child node, not the container):

| fig field | CSS / RN equivalent |
|---|---|
| `stackChildPrimaryGrow` (number) | `flexGrow` (`1` → `flex: 1`). IR node `grow` |
| `stackChildAlignSelf` (`MIN`/`CENTER`/`MAX`/`STRETCH`) | `alignSelf` (`flex-start`/`center`/`flex-end`/`stretch`). IR node `alignSelf` |
| `stackPositioning: "ABSOLUTE"` | child absolutely positioned **inside** an auto-layout parent (out of flow, placed by `transform`/abs coords). IR node `positioning: "absolute"`. Codegen emits `position:'absolute'` + `left`/`top` (parent `position:'relative'`) for BOTH this explicit flag AND the **absent-`stackMode`** (non-auto-layout frame) case, with `z-index` by child order for overlapping siblings |
| `horizontalConstraint` / `verticalConstraint` (`MIN`/`MAX`/`CENTER`/`STRETCH`/`SCALE`) | resize constraints for non-auto (absolute) layouts → pin/stretch/scale on resize. IR node `constraints: {h, v}` (lower-cased) |
| `minSize: {value:{x,y}}` | `minWidth`/`minHeight` (emit when > 0). IR node `minW`/`minH` (`maxSize`→`maxW`/`maxH`, absent in current decodes) |
| `targetAspectRatio: {value:{x,y}}` | `aspectRatio = x / y`. IR node `aspectRatio` |

**Text** (`type: "TEXT"`):

- `textData.characters` — the actual string (this is how you get all copy).
- `fontName: {family, style}`, `fontSize`, `lineHeight: {value, units}`
  (`PIXELS` or `PERCENT`), `letterSpacing: {value, units}`,
  `textAlignHorizontal`.
- **Text transform & alignment** (IR `text.case` / `text.align` /
  `text.alignVertical` / `text.leadingTrim`; emitted only when non-default).
  Pure pass-throughs of the resolved bytes, mapped fig→CSS:

  | fig field | value(s) (this decode) | IR field | CSS |
  |---|---|---|---|
  | `textCase` | `UPPER`/`LOWER`/`TITLE`/`SMALL_CAPS`/`ORIGINAL` (here: `TITLE`, `UPPER`) | `text.case` | `text-transform` — UPPER→`uppercase`, LOWER→`lowercase`, TITLE→`capitalize`, SMALL_CAPS→`uppercase` (no exact CSS; TODO `font-variant`), ORIGINAL/absent→omitted |
  | `textAlignHorizontal` | `LEFT`/`CENTER`/`RIGHT`/`JUSTIFIED` (here: `CENTER`) | `text.align` | `text-align` — CENTER→`center`, RIGHT→`right`, JUSTIFIED→`justify`, LEFT/absent→omitted (default) |
  | `textAlignVertical` | `TOP`/`CENTER`/`BOTTOM` (here: `TOP`, `CENTER`) | `text.alignVertical` | vertical alignment (no single CSS prop — center via flex); raw enum lower-cased, TOP/absent→omitted |
  | `leadingTrim` | `CAP_HEIGHT`/`NONE` (here: `CAP_HEIGHT`) | `text.leadingTrim` | optional; raw enum lower-cased, NONE/absent→omitted |

  `render.mts --ir` applies `text.case`→`text-transform` and `text.align`→`text-align`.
- Mixed-style runs live in `textData.styleOverrideTable` — rare in app UI;
  flag if styling looks inconsistent within one string.

**Four-source reconciliation (encode for every text value).** Cross-check four
sources; on conflict prefer in this order:

1. **Rendered geometry** — `size.y` of an auto-height text node (a 20px box ≈
   16px font; it rarely lies).
2. **Instance override** values (resolved, incl. `styleOverrideTable` runs).
3. **Node-level** `fontSize`/`lineHeight`/`fontName`.
4. **Layer-name label** ("• 28px") — weakest; routinely stale.

If geometry (1) and the node font (3) disagree, **stop and flag** — do not
silently pick. `dump.mts` does this for you: it prints `⚠ stale-style? box.y=20
< lh=36 → size likely ~16` when a declared line-height cannot fit the box.

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
node overrides.mts $WORK/message.json <screen-guidKey>          # raw override list
node overrides.mts $WORK/message.json <screen-guidKey> --full   # value-print lineHeight/letterSpacing(px)/textCase/cornerRadius/paddings
node resolve.mts   $WORK/message.json <instance-guidKey>        # composed master + overrides = the rendered tree
```

`resolve.mts` composes `master subtree + symbolOverrides` into the rendered tree
(the algorithm above), so instances no longer dead-end at `instanceOf=`; it tags
overridden text `[overridden]` and un-overridden text
`[MASTER DEFAULT ⚠ likely placeholder]`. `dump.mts --resolve` does the same in the
per-screen dump (the default dump stays raw/fast).

**Designer-intent signal:** an instance with *no* `textData` override renders
the master's placeholder text (e.g. every CTA button on a screen showing the
master's default label = copy never decided). Detect this and **ask the user
instead of shipping placeholders**.

**Component sets** group variant masters of one component. `components.mts` lists
them and derives a typed prop API:

```sh
node components.mts $WORK/message.json [nameRegex]   # list sets + variants + proposed prop type
node find.mts $WORK/message.json "Version=" SYMBOL --under Header   # scope a search to one subtree
```

Detection is **structural first**: a frame whose visible direct children are all
`type: "SYMBOL"` named `prop=value[, prop2=value2]` sharing one axis set is a set
(`[structural, high]`). The `#9747ff` dashed stroke is only a **labeled fallback**
(`[stroke-hint, medium]`) — it is an editor render hint, not a format guarantee,
so never rely on it alone. A single-axis set proposes a prop named `variant`
regardless of the axis's own name; multi-axis sets get one prop per axis.
`components.mts` lists only component *sets*; a standalone master (a lone SYMBOL
with no variant siblings) is still found via `find … SYMBOL` (§3).

**Non-variant props (text / boolean / instance-swap).** Beyond the variant axes,
a set frame's `componentPropDefs` declare props that toggle a child node's
`visible`, swap its `TEXT_DATA`, or swap an instance's master. `build-ir.mts`
emits these as `components/<set>.json` `props[]` (`{name (camelCase), rawName,
kind, default, bindings:[{node,field}]}`) + `propGroups[]` (props binding the
same node). The namespace join is the trap: a child's `componentPropRefs.defID`
is in the **master** def namespace, each master def is a stub
`{id, parentPropDefId}`, and `parentPropDefId` points at the **set** def (which
carries the human `name`/`type`/`varValue`). Resolve `ref.defID` → master def →
`parentPropDefId` → set def → name; never match `ref.defID` against a set def id
directly (different id namespaces — it silently fails). Fields normalize
`TEXT_DATA`→`characters`, `VISIBLE`→`visible`, `OVERRIDDEN_SYMBOL_ID`→`symbolId`.
Extraction is facts-only; the idiomatic collapse (a `visible` bool + a `characters`
text on one node → one optional prop) is a codegen transform over `propGroups`.
Each `props[]` entry also carries a stable `defKey` (the set-def id key) — the
collision-proof identity codegen joins on (two props can camelCase to the same
`name`). For the multi-file codegen, each `variants[].bindings[]` resolves the SAME
set props onto THAT variant's OWN node guids (`{defKey, rawName, kind, node, field}`,
`[]` when the variant exposes none), so every variant renders its own subtree with
its own bound nodes.

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
node export-svg.mts $WORK/message.json <guidKey> out.svg
```

`export-svg.mts` follows `symbolData.symbolID` into masters, so icons/logos
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

**Default to the IR as your context source.** Beyond a one- or two-query lookup
(a single color, one node's fields), compile the Design IR (step 2.5) and read
its per-screen JSON **directly** as the source of truth — resolved, reconciled,
provenance-stamped, KB-scale. The raw printers (§3–§7, steps 3–8 below) stay
essential as the **quick-query path**, the **field-confirmation escape hatch**,
and the **verifier the IR is checked against** — but for loading whole screens
into implementation context, read the IR, not raw dumps.

0.5. **Detect an existing design system first.** Before implementing anything,
   look for a `theme`/`tokens`/`design-system` module in the consuming repo. If
   one exists, switch to **map mode**: the job is **diff-and-reconcile, respect
   intentional divergence** — not implement-from-scratch. Map fig values to the
   code's tokens **by value, never by name** (`match-tokens.mts`). Before changing
   existing code to match the fig, check whether the divergence is intentional (a
   comment, a token alias, a repo-wide pattern) — **prefer asking over
   overwriting**. `match-tokens.mts` annotates `exact`/`nearest(Δ)`/`none` and
   never rewrites; the `nearest`/`none` rows are the "ask, don't overwrite" list.

1. **Unzip + parse** (§1–2); build the index. Query with scripts; never load
   `message.json` into context.
2. **Print the skeleton** (`tree.mts`). Identify canonical pages vs trials;
   confirm scope with the user. Read any `todo`/notes page.
2.5. **Compile the IR — the default context surface** once scope is confirmed:
   `node build-ir.mts msg-<name>.json --scope <pages> --out ir-<name>` emits a
   small, provenance-stamped `ir-<name>/` (manifest + raw-map + fonts + tokens/* +
   components/* + **`screens/<page>/<screen>.json`** — resolved, reconciled,
   placeholder-detected, absolute-coordinated). Read those per-screen IR files
   **directly** — they are ~2–500KB (vs the 80MB blob), so load them into context
   instead of re-querying the blob; **trust the IR's reconciled `font.size` +
   `sizeSource`, not the raw `fontSize`** (a 28px `fontSize` whose box says 16
   carries `size:16, sizeSource:"geometry"` + a `conflicts[]` entry). After
   compiling, **render-and-eyeball over the IR** (Phase 9's render consumes the
   resolved screen directly). `ir.mts ir-<name> "nodes with conflicts"` /
   `"fonts where appFamily is empty"` answer cross-cutting questions. The IR is the
   **primary reading surface** for implementation; the raw tools
   (`find`/`tree`/`dump`/`overrides`/`node`/`export-svg`) remain **additive** —
   the **verifier and escape hatch** (the IR is checked *against* them, never the
   reverse) and the quick-query path for one-off questions — and `raw-map.json`
   drops any IR node id back to its raw `{guid, path}`.

   A fill **bound to a Figma variable** carries the design token **directly** as
   GROUND TRUTH (no theme needed): `color.var` = the variable's token name (e.g.
   `"Color/praline/950"`), `color.varGuid` = the variable guidKey, and
   `color.match = "bound"`. This is a pure function of the bytes (reads
   `paint.colorVar`), always runs, and is never a value-matching guess. **`color.hex`
   FOLLOWS the binding:** for a bound fill it is the bound variable's RESOLVED value
   (e.g. `"#2a1e1e"` for `Color/praline/950`), NOT the cached `paint.color` literal —
   which can be STALE on instance-override paints. So `hex` and `var` can never
   disagree. A literal (unbound) fill keeps `var:null` and `hex` = `paint.color`.
   One shared resolver (`resolvePaintColor`) drives `color`, `style.fills[]`, and
   `style.strokes[]` so all three stay consistent.

   Every IR node also carries the **full box-styling + auto-layout** so the IR alone
   suffices for a 1:1 implementation (parity with the raw dump / §4) — emitted only
   when present so files stay lean:
   - `style?`: `{ fills?, cornerRadius?, strokes?, borderWidths?, effects?, opacity? }`.
     `fills[]` is the COMPLETE paint list (`color.hex` stays the single-hex
     convenience): each is `{type:"solid"|"gradient"|"image", hex?, var?, varGuid?,
     stops?:[{position,hex}], imageHash?, opacity?}` — gradients keep their `stops`,
     images their `imageHash` (bytes→hex, the `images/` filename, §7), and solids
     their bound `var`/`varGuid` (GROUND TRUTH, same resolver as `color`).
     `cornerRadius` is a bare number (uniform) or `{tl,tr,br,bl}` (per-corner).
     `strokes[]` = `{weight, align, hex, var?, varGuid?, cap?, join?, dash?}` —
     `cap`/`join` lower-cased pass-throughs (default `MITER` join omitted), `dash`
     = `dashPattern` verbatim (non-empty ⇒ a dashed stroke). `borderWidths?
     {top,right,bottom,left}` is emitted ONLY when the node sets
     `borderStrokeWeightsIndependent` — then the **per-side** weights apply INSTEAD
     of the single `strokes[].weight` (absent side = 0), so a bottom-only divider
     survives; consumers map it to `border-<side>-width`. When NOT independent the
     IR keeps the single `strokes[].weight` only (no `borderWidths`). `effects[]` =
     `{type, hex, offsetX, offsetY, radius, spread?}` (DROP_SHADOW/INNER_SHADOW/
     *_BLUR). `opacity` only when < 1.
   - `layout?`: `{mode:"row"|"column", gap?, paddingTop?, paddingRight?,
     paddingBottom?, paddingLeft?, justify?, align?}` — emitted only on a real
     auto-layout frame (`stackMode` HORIZONTAL/VERTICAL → row/column, per the §4
     table); absent ⇒ children are absolutely positioned (use `box.absX/absY`).
   This extraction is a pure function of the bytes and always runs (no `--theme`).

   **If a code theme exists**, run `build-ir … --theme <path>`: it maps every IR
   **unbound** `color.hex` and text `font.size` to a code token **by value, within
   its own kind** (`color.{token,match}`, `font.{sizeToken,sizeMatch}` = `exact` /
   `nearest(Δ)` / `none` — never name-matched, never cross-kind, so a 16px font
   never binds a `spacing` token). Value-matching never touches a bound color — its
   `match` stays `"bound"`. The build then writes two small review files:
   **`issues.json`** (the automated *ask, don't ship* list — unmapped fonts,
   `match:none`/unconfirmed `nearest` colors, reconciliation conflicts, the
   token name-collision trap) and **`intent.json`** (placeholders, repeated/
   denylisted strings, default-variant instances, mono-color icon fills,
   aggregated across all scoped screens). Read both, then resolve them into a
   **`decisions.json`** overlay and re-run `build-ir … --theme … --decisions
   decisions.json` — the IR is now reproducible (same source hash + same
   decisions hash = a no-op). Keep the diff-and-reconcile, **respect intentional
   divergence** framing: `decisions.json` is where you say "yes, same token"
   (`tokenConfirms`), "deliberately new, stop warning" (`tokenRejects`), map a
   font (`fontMap`), or correct a placeholder — **never overwrite by name**.
3. **Extract tokens first.** Check for Figma variables (`variables.mts`) —
   `type: "VARIABLE"` nodes carry exact values per mode (light/dark) under
   `variableDataValues.entries`, grouped by `VARIABLE_SET`; when present they
   are the canonical token source. Otherwise scrape the colors/typography
   pages: colors often live in swatch-component instances → read
   `symbolOverrides` text (name + hex pairs). Typography pages give the full
   ramp — node properties are the **starting point**, but box geometry can
   override them: reconcile (see §4's four-source heuristic). A label saying
   "28px" is the weakest source; the node `fontSize` is stronger, yet a 36px
   line-height in a 20px auto-height box means the real size is ~16 — geometry
   wins. Labels go stale; resized boxes make node `fontSize` stale too.
4. **Dump each canonical screen** (`dump.mts`) — a 50–150-line indented
   summary, complete and unambiguous unlike a screenshot. **Once the IR is
   compiled (2.5), its `screens/<page>/<screen>.json` is the artifact that goes
   into implementation context** (already resolved + reconciled); use the raw
   `dump.mts` here as the fast cross-check and for screens outside the IR scope.
5. **Build the component library first.** For "build a component", enumerate the
   component *sets* with `components.mts` and derive the prop API *before*
   dumping screens — mirror the SYMBOL masters into reusable components, then
   compose screens from them. `components.mts` lists only sets (variant groups);
   standalone masters (a lone SYMBOL, no variant siblings) are still enumerated
   via `find … SYMBOL` (§3) — it complements, not replaces, that. Then **dump
   the masters** referenced by instances (cards, tab bars, buttons, checkboxes);
   variant names (`Style=Filled, State=Active`) document the API. **Resolve
   instances, then render-and-eyeball** (`render.mts`) **before trusting any
   derived text value** (`resolve.mts` / `dump.mts --resolve` tag placeholders;
   `render.mts` rasterizes the resolved frame so an obviously-wrong size/font/
   position is caught visually, with the **reconciled** size baked into the
   inspectable `<out>.html`). Dump deep + `overrides --full` on the first pass
   (depth 8–10) so placeholder copy and overridden styles are both visible. Run
   `intent.mts` for a single copy-pasteable gap checklist (placeholders, stale
   sizes, default-variant instances, mono-color icons).
6. **Map the icon set**: icon layer names usually identify a public library
   (e.g. Phosphor: `MagnifyingGlass`, `CaretUpDown`, `HouseSimple`) — use the
   library package instead of exporting every icon.
7. **Export vectors** (§6); copy rasters/videos (§7).
8. **Diff duplicated frames** (screens often appear both on a consistency-
   test page and their own page) — duplicates with the highest `sessionID`s
   are usually newest.
9. **Map masters ↔ code components** (P2-10). Before editing, write the explicit
   **master ↔ existing-code-component map** plus the two **no-counterpart lists**:
   fig masters with no code component (to build) and code components with no fig
   master (leave alone / confirm). This scopes codegen and prevents re-building
   what already exists.
10. **Run the IR ship gate, then implement.** When an IR exists (step 2.5):
   - `node ir-validate.mts ir-<name>` — the **ship gate** (exits non-zero on any
     unresolved token/font/placeholder/conflict/provenance). A failing gate *is*
     the automated "ask, don't ship" list: each line names the node `guid` (drop
     back to `node.mts`) and the `decisions.json` entry that resolves it. Drive it
     to green by authoring `decisions.json`, then re-build.
   - `node render.mts --ir ir-<name> <screen-id> <out.png>` — **eyeball** the
     resolved IR in one step (no re-resolve, no blob re-decode); the reconciled
     `font.size`/`appFamily`/`letterSpacingPx`/`lineHeightPx` are baked into the
     inspectable `<out>.html`.
   - `node codegen.mts ir-<name> <set> [--out <dir>] [--framework rn|web]` — scaffold
     a component FOLDER from its SYMBOL master: `<dir>/<slug>/index.tsx` (meta
     dispatcher), `types.ts` (shared `Props` = variant union + the COLLAPSED
     non-variant props), and one `<variant>.tsx` PER variant (each renders that
     variant's OWN resolved subtree as a JSX tree — rn View/Text + StyleSheet, web
     div/span + style objects — with reconciled per-node style/layout/font/text).
     `--out` is now an output DIRECTORY (was a single file). Bound nodes consume
     props via the idiomatic collapse (TEXT→string prop w/ default fallback,
     BOOL-visible→conditional render, BOOL-visible ⊕ TEXT on the same node→ONE
     optional `name?: string`, INSTANCE_SWAP→a `React.ReactNode` slot). Both
     frameworks emit the SAME folder shape; variant-attributed `// TODO`s on every
     placeholder/conflict/unmapped-font/match:none value.
   - `node diff-ir.mts ir-old ir-new` — when a **new `.fig` export arrives**, diff
     the two IRs (added/removed screens & components, changed tokens per mode,
     drifted type specs, per-screen node/color drift). It compares reconciled
     **truth vs truth** and *surfaces* drift — it never picks a canonical export,
     and refuses to diff an IR against itself.
11. **Implement** against the dumps, mapping auto-layout per the §4 table and
   theme-tokenizing every color/size from step 3 — no hardcoded values.

## 9. Pitfalls checklist

- [ ] Chunk 1 is **zstd** in modern files; raw-deflate only as fallback.
- [ ] `JSON.stringify` throws on **BigInt** — use a replacer.
- [ ] Instance children are **not** in the tree — resolve masters + overrides.
- [ ] Colors are 0–1 floats; alpha may be a separate `opacity` on the paint.
- [ ] `stackVerticalPadding`/`stackHorizontalPadding` are **top/left**, with
      separate `stackPaddingBottom`/`stackPaddingRight`.
- [ ] Label text in design-system pages can be stale; node properties are the
      **starting point** — but box geometry can override them, so reconcile (§4).
- [ ] Declared `fontSize`/`lineHeight` can be **stale on a resized box**: under
      `textAutoResize`, geometry beats the font property — a 36px line in a 20px
      box means ~16px. Flag, don't assume (`dump.mts` prints `⚠ stale-style?`).
- [ ] `letterSpacing`/`lineHeight` carry a **unit** and are **font-size-relative**
      (`PERCENT → value/100 × fontSize`); px differs per font size and platform
      (CSS `em` scales, RN bakes px). Never read the raw value as px — `dump.mts`
      prints both (`ls=4%→0.64px@16`).
- [ ] `styleOverrideTable` is usually rare but **invisible to the tools** when
      present — node-level font can be wrong; flag non-empty tables.
- [ ] Un-overridden instance text = **placeholder** — flag it; confirm copy,
      don't ship `Test`/`Placeholder`/master defaults. `resolve.mts` (and
      `dump.mts --resolve`) tag these `[MASTER DEFAULT ⚠ likely placeholder]`.
- [ ] Hidden nodes (`visible: false`) and trial pages must be excluded.
- [ ] `strokeGeometry` is pre-outlined: render as a **fill** with the stroke paint.
- [ ] Fonts in the file may be commercial — check licensing before bundling;
      substitute behind a single token if absent.
- [ ] Match design tokens to code tokens by **value, not name** — variable sets
      can share a name (`praline`) with a different ramp, so a by-name sync
      silently overwrites a deliberately-different value. Match by resolved
      hex/px **within the same domain** (a 16px font size ≠ a 16px gap), and
      treat `nearest`/`none` as "ask, don't overwrite" (`match-tokens.mts`).
- [ ] A screen drawn in **multiple frames** (own page + a consistency-test page)
      may carry **conflicting specs** (designer drift — `cart total` is `Regular
      16` in one, `Medium 20` in another). Diff them (`diff-frames.mts`); it
      **surfaces** the conflict and reminds you to confirm which export/frame is
      canonical — it does **not** pick silently.
- [ ] Auto-layout `SPACE_EVENLY` vs `SPACE_BETWEEN` **read alike on a 2-item row**
      (both push the two items apart), so a 2-item sample can't tell them apart —
      check a 3+-item row. In RN they differ: `justifyContent: 'space-evenly'`
      adds equal space *around* every item (incl. the ends), `'space-between'`
      pins the ends and only spaces the gaps. **Resolved:** codegen and render now
      run reconcile-lib's `disambiguateJustify` over resolved child geometry and emit
      `'space-between'` when in-flow children sit flush at both main-axis ends.
- [ ] Borders need an explicit **border-style** — CSS defaults to `'none'`
      (invisible even with a width/color); codegen now emits `borderStyle` `'solid'`/`'dashed'`.
- [ ] `lineHeight` is **framework-conditional**: web emits a `'<n>px'` **string**
      (a bare unitless number is a *multiplier* in React), rn emits a bare px **number**.
- [ ] Non-auto-layout frames and `positioning:'absolute'` children now get
      `position:'absolute'` + `left`/`top` with the parent set `position:'relative'`
      (previously only the explicit `ABSOLUTE` flag was honored, and even then ignored).
      Icon wrappers now **center** their content (`display:flex` + center), and image
      fills emit a `// TODO: image` marker + placeholder.
- [ ] **State the font-substitution map up front** — fig families are often
      commercial/unavailable; pick the app-family per fig-family before coding so
      sizes/line-heights stay consistent (e.g. `Neulis Sans → Figtree`, keep
      `Geist Mono`, keep `Lora`). `render.mts` renders the fig family name as-is —
      a missing font silently falls back, so a wrong substitution shows up there.

## Scripts reference

| Script | Usage | Purpose |
|---|---|---|
| `parse.mts` | `node parse.mts <canvas.fig> <out.json>` | fig-kiwi → message.json |
| `tree.mts` | `node tree.mts <msg.json>` | page/frame skeleton with guid keys |
| `find.mts` | `node find.mts <msg.json> <regex> [type] [--under <name>]` | locate nodes by name (`--under <name>` scopes to a subtree whose ancestor matches) |
| `components.mts` | `node components.mts <msg.json> [nameRegex]` | list component sets + variant masters + proposed TS prop API |
| `node.mts` | `node node.mts <msg.json> <guidKey> [field …]` | raw single-node JSON (confirm a field exists before relying on it) |
| `variables.mts` | `node variables.mts <msg.json>` | design tokens from Figma variables (resolves alias chains transitively → concrete value inline, e.g. `→ 18 (alias Numbers/18)`) |
| `dump.mts` | `node dump.mts <msg.json> <guidKey> [depth] [--abs] [--resolve]` | per-screen implementation dump (`--abs` adds absolute coords; `--resolve` composes instances + tags placeholder/overridden text) |
| `overrides.mts` | `node overrides.mts <msg.json> <guidKey> [--full]` | instance text/color overrides (`--full` value-prints lineHeight/letterSpacing(px)/textCase/cornerRadius/paddings) |
| `resolve.mts` | `node resolve.mts <msg.json> <guidKey> [depth]` | compose master + symbolOverrides → the rendered instance tree |
| `export-svg.mts` | `node export-svg.mts <msg.json> <guidKey> <out.svg> [--png]` | vector → SVG (`--png` also rasterizes via headless Chrome @3×; degrades gracefully if Chrome is absent) |
| `match-tokens.mts` | `node match-tokens.mts <msg.json> <theme.(ts\|json)> [guidKey]` | brownfield map mode: annotate fig values vs an existing code theme **by value, within kind** (`exact`/`nearest(Δ)`/`none`); never rewrites |
| `render.mts` | `node render.mts <msg.json> <frame-guidKey> <out.png> [--images <dir>]`  •  **`--ir`:** `node render.mts --ir <ir-dir> <screen-id> <out.png> [--images <dir>]` | resolved frame → self-contained `<out>.html` + screenshot PNG; text uses the **reconciled** size; missing image → labeled placeholder, not a broken `<img>`. Not pixel-perfect — catches "obviously wrong". Writes the HTML even if Chrome is absent. **`--ir` mode** renders OVER an emitted IR (`screens/<…>.json`) in one step — **no re-resolve, no re-reconcile, no blob re-decode**; `<screen-id>` is a screen-file slug, a node `id`, or a `guid`; it USES the node's `style` (solid/gradient background, `cornerRadius`→border-radius, `strokes`→border (per-side `borderWidths`→`border-<side>-width`, `dash`→`border-style:dashed`), `effects`→box-shadow, `opacity`), `layout` (flex-direction/gap/padding/justify/align), and TEXT `text.case`→`text-transform` / `text.align`→`text-align` for a faithful render; sidecar asset bytes (images via `--images`/sibling `images/`; pre-exported `vectors/<id>.svg`) fill image/vector slots, a missing asset → labeled placeholder |
| `intent.mts` | `node intent.mts <msg.json> <screen-guidKey>` | one copy-pasteable designer-intent gap checklist: placeholders, denylisted/repeated strings, geometry/fontSize reconciliation conflicts, default-variant instances, mono-color icon fills |
| `diff-frames.mts` | `node diff-frames.mts <msg.json> <guidA> <guidB>` | resolve both frames, align by name-path, report per-node property deltas (font/size/color/spacing/text). **Surfaces** drift; does **not** pick a canonical winner |
| `icons.mts` | `node icons.mts <msg.json> <screen-guidKey>` | inventory icon instances under a screen, resolve each to its library export name (Phosphor `MagnifyingGlass`…), emit the exact `AppIconName` union additions so no name is imported unmapped |
| `build-ir.mts` | `node build-ir.mts <msg.json> --scope <pages\|all> [--theme <p>] [--decisions <p>] [--out ir-<name>] [--force]` | compile the scoped, provenance-stamped IR: `manifest.json` (source hash/path + scope + counts) + `raw-map.json` (IR id → raw guidKey) + `fonts.json` (families + empty `appFamily` substitution slots) + `tokens/*` (alias chains collapsed) + `components/*` (variant matrix + proposed TS prop API, **plus `props`/`propGroups`** = the NON-VARIANT component property API: each `props[]` entry = `{name (camelCase), rawName, kind ("text"\|"boolean"\|"instanceSwap"), defKey (stable set-def id key — codegen joins on this, never `name`), default, bindings:[{node:guidKey, field:"characters"\|"visible"\|"symbolId"}]}` resolved by walking a representative master subtree's `componentPropRefs` (`defID`→master def `parentPropDefId`→set def, NEVER id-matched across namespaces; field-normalized `TEXT_DATA`→characters / `VISIBLE`→visible / `OVERRIDDEN_SYMBOL_ID`→symbolId); `propGroups[]` = props that bind the SAME node, so codegen can collapse a bool-visible + text pair; **plus per-variant** `variants[].bindings[]` = `{defKey, rawName, kind, node, field}` resolving the SAME set props onto EACH variant's OWN node guids (`[]` when a variant exposes none) so the multi-file codegen renders each variant's own subtree with its own bound nodes) + `screens/<page>/<screen>.json` (resolved instances, reconciled `font.size`+`sizeSource`+`conflicts[]`, `letterSpacingPx`, placeholder detection, `box.absX/absY`, path-derived `id` + `guid` per node, plus per-node **`style`** (fills incl. gradient `stops`/image `imageHash`, `cornerRadius`, `strokes` incl. `cap`/`join`/`dash`, per-side `borderWidths {top,right,bottom,left}` when `borderStrokeWeightsIndependent`, `effects`, `opacity`) + **`layout`** (auto-layout flex: `mode`/`gap`/paddings/`justify`/`align`, plus `primarySizing`/`counterSizing` = `fixed`\|`hug` and `wrap`) plus per-node responsive fields (`grow`, `alignSelf`, `positioning:"absolute"`, `constraints {h,v}`, `minW`/`minH`/`maxW`/`maxH`, `aspectRatio`) for full box-styling parity with §4, plus TEXT transform/alignment (`text.case`→`text-transform`, `text.align`→`text-align`, `text.alignVertical`, `text.leadingTrim` — pass-throughs, emitted only when non-default; fig→CSS map in §4 Text)). Fills **bound to a Figma variable** carry the design token directly (GROUND TRUTH, always — no `--theme` needed): `color.var` = token name, `color.varGuid` = variable guidKey, `color.match = "bound"`; `color.hex` stays the concrete value. With `--theme <p>`: maps each **unbound** `color.hex`/`font.size` to a code token **by value, within kind** (`color.{token,match}`, `font.{sizeToken,sizeMatch}` = `exact`/`nearest(Δ)`/`none`; bound colors are left as `"bound"`) and emits **`issues.json`** (ask-don't-ship: unmapped fonts, `match:none`/unconfirmed `nearest`, reconciliation conflicts, token name-collisions) + **`intent.json`** (placeholders/repeated/denylist/default-variant/mono-icon, aggregated). `--decisions <p>` folds a `decisions.json` overlay back in (`fontMap`/`tokenConfirms`/`tokenRejects`/`placeholders`) and suppresses the resolved issues. Re-runs with the same source+decisions are a no-op; refuses to overwrite an IR built from different bytes without `--force`. Imports only `*-lib.mts` |
| `diff-ir.mts` | `node diff-ir.mts <ir-old> <ir-new>` | design-version diff over two emitted IRs (no decode): added/removed screens & components, changed tokens per mode, drifted type specs (family/size/weight/lineHeight/letterSpacing), per-screen node + color drift (aligned by `path`, never `guid`). Compares reconciled **truth vs truth** and **surfaces** drift — never picks a canonical export; refuses to diff an IR against itself (same dir / equal `sourceHash`); re-hashes each manifest's recorded source if still present and **warns** on staleness, else skips |
| `ir-validate.mts` | `node ir-validate.mts <ir-dir>` | the **ship gate** (exits non-zero on failure — CI/pre-ship). Asserts from the IR alone: every color adjudicated against the theme (`exact`/confirmed/rejected; skipped when greenfield — every `match:null`; a variable-**bound** color `match:"bound"` is ground truth and ALWAYS passes), every font has a non-null `appFamily` (always), no unresolved `placeholder:true`, no open `conflicts[]`, no missing `source`/`match` provenance. Each failure names the node `guid` + the `decisions.json` entry that resolves it |
| `codegen.mts` | `node codegen.mts <ir-dir> <set-name> [--out <dir>] [--framework rn\|web]` | multi-file component **scaffold** from `components/<set>.json`. `--out` is an output **DIRECTORY** (was a single file): writes a FOLDER `<out>/<slug>/` = `index.tsx` (the meta **dispatcher** — switches on the variant prop to the per-variant component, forwarding props) + `types.ts` (shared `Props` = the variant union (`proposePropApi`) **&** the COLLAPSED non-variant props, type-only import to avoid an index↔variant runtime cycle) + **one `<variant>.tsx` per variant** (`default.tsx`/`single-line.tsx`/`modal.tsx`/… — each renders THAT variant's OWN resolved subtree located in the screens IR by guid, as a JSX tree: **rn** `View`/`Text` + `StyleSheet`, **web** `div`/`span` + `React.CSSProperties` style objects, using the reconciled per-node `style`/`layout`/`font`/`text` — cornerRadius, strokes incl. per-side `borderWidths`, effects, opacity, flex layout via `layout`, `fontSize`/`lineHeight` (web `'<n>px'` string, rn bare px number)/`letterSpacing`, text `case`/`align`; emits an explicit `borderStyle` `'solid'`/`'dashed'` so borders are visible; gives TEXT nodes their flex-child props; centers **icon** wrappers (`display:flex` + center); leaves a `// TODO: image` marker + placeholder for image fills; emits `position:'absolute'` + `left`/`top` (parent `position:'relative'`) for absolute and non-auto-layout children with `z-index` by child order for overlaps; runs `disambiguateJustify` to resolve `SPACE_EVENLY`→`SPACE_BETWEEN` by resolved geometry; drops interactive-archetype markers). **PROP COLLAPSE** (idiomatic, driven by Phase A `props`/`propGroups` + per-variant `variants[].bindings`): TEXT-bound→`name?: string` (prop ?? reconciled default), BOOL-visible→conditional render, BOOL-visible ⊕ TEXT on the SAME node→ONE optional `name?: string` (present→render w/ text, absent→omit), INSTANCE_SWAP→`name?: React.ReactNode` slot; camelCase names (collisions de-duped), each with a `/** Figma: <name> */` comment. Both frameworks emit the SAME folder shape; prints a written-files summary to stderr; leaves variant-attributed `// TODO` on every `placeholder:true` text, open conflict, unmapped font, or `match:none` — never bakes an unconfirmed value silently. Default framework React Native. (Joins variant bindings to props by the STABLE `defKey`, never by `name`.) |
| `ir.mts` | `node ir.mts <ir-dir> <query>` | dumb reader over an emitted IR (no decode) for cross-cutting questions: `"fonts where appFamily is empty"`, `"colors with match=none"` (token-level `tokens/colors.json`; node-level `match:none` lives in `issues.json`), `"nodes with conflicts"` (walks `screens/<page>/*.json` for reconciled `font.conflicts`). Default access is a direct read of the small per-screen JSON |

All scripts import `lib.mts` (tree index + color helpers) — copy the whole
`scripts/` directory together.

### `decisions.json` — the only non-deterministic IR input

Everything `build-ir.mts` emits is a **pure function of the `.fig` bytes** except
the values it reads from a `--decisions <decisions.json>` overlay. That file is
the single judgment slot: a human/LLM authors it by reading `issues.json` +
`intent.json`, and once authored the build is reproducible — **same source hash +
same decisions hash = a no-op** (the manifest records both hashes). Never let the
LLM build the IR; it only writes `decisions.json`. Schema:

```json
{
  "fontMap":       { "Neulis Sans": "Figtree" },
  "tokenConfirms": { "color:#bda799": "theme.colors.praline300", "fontSize:16": "theme.fontSize.md" },
  "tokenRejects":  ["color:#5a3a2a"],
  "placeholders":  { "1273:19842": { "placeholder": false, "text": "Heirloom" } },
  "canonicalPages": ["Screens", "Components"]
}
```

- `fontMap` → fills every matching node's `font.appFamily` (and clears its
  unmapped-font issue). `tokenConfirms` keys are **`kind:value`** (one of
  `color|fontSize|spacing|radius|strokeWidth|other`) — only `color`/`fontSize`
  bind into IR nodes (the kinds the IR carries a token field for); it upgrades a
  `nearest`/`none` to a confirmed `exact` + token. `tokenRejects` (same key
  shape) confirms "deliberately new" — keeps the literal, marks `match:"rejected"`,
  suppresses the issue. `placeholders` overrides `text.placeholder`/`value` per
  guid. **Value normalization:** hex is lower-cased 6-digit `#rrggbb`; numbers are
  bare/unit-less — the build canonicalizes the key and the IR value the same way.
