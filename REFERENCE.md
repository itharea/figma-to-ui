# `.fig` format & field reference

Companion to [`SKILL.md`](./SKILL.md). **SKILL.md is the harness** — the
build-IR → theme → components → elevate → screens procedure. **This file is the
encyclopedia** the harness points to: the binary `.fig` format, the node-field
mapping tables, the component/instance/override model, vector→SVG handling, the
IR node schema, the pitfalls checklist, and the complete script reference. Read a
section here when you need a field-level detail; you do not need to read it
front-to-back.

Verified against fig-kiwi format version 106 (2026). Colors throughout are 0–1
floats `{r,g,b,a}` (×255 → hex).

---

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
node parse.mts $WORK/ex/canvas.fig $WORK/msg-<name>.json
```

`parse.mts` handles both compressions, serializes BigInts as strings, and
Uint8Arrays as byte arrays (hashes get hex-encoded later; geometry blobs in §6).

## 3. The node graph

`message.nodeChanges` is a **flat array** of every node (tens of thousands).
There is no nested tree — `lib.mts` rebuilds it:

- Identity: `node.guid = {sessionID, localID}` → string key
  `"${sessionID}:${localID}"`.
- Parent: `node.parentIndex.guid`; `parentIndex.position` is a
  fractional-index string — sort children lexically by it.
- Roots: `type === "DOCUMENT"` → children are `CANVAS` (pages) → children are
  top-level frames/sections.

```sh
node tree.mts $WORK/msg-<name>.json                 # pages + top-level frames with guid keys
node find.mts $WORK/msg-<name>.json "tab.?bar"      # search nodes by name regex
node find.mts $WORK/msg-<name>.json "." SYMBOL      # list all component masters
node find.mts $WORK/msg-<name>.json "Version=" SYMBOL --under Header  # scope to a subtree
```

Page and frame *names* carry the information architecture. Watch for scratchpad
pages (`trial`, `old`, `draft`, `wip`, `-`, or local-language equivalents) —
those are rejected explorations; ask the user which pages are canonical if naming
isn't obvious. Also look for a `todo`/notes page: designers leave notes there
about undecided content.

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
| `cornerRadius` or `rectangleTopLeftCornerRadius` (×4) | border radius (uniform or per-corner) |
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
| `stackPrimarySizing` / `stackCounterSizing` | container self-sizing on main/cross axis: `FIXED` → fixed `width`/`height`; `RESIZE_TO_FIT…` → **hug** (auto, content-driven). IR `layout.primarySizing`/`counterSizing` = `fixed`\|`hug` |
| `stackWrap: "WRAP"` | `flexWrap: wrap`. IR `layout.wrap = true` |
| absent/`NONE` | absolute positioning via child `transform` |

**Per-child sizing & constraints** (on the child node, not the container):

| fig field | CSS / RN equivalent |
|---|---|
| `stackChildPrimaryGrow` (number) | `flexGrow` (`1` → `flex: 1`). IR node `grow` |
| `stackChildAlignSelf` (`MIN`/`CENTER`/`MAX`/`STRETCH`) | `alignSelf` (`flex-start`/`center`/`flex-end`/`stretch`). IR node `alignSelf` |
| `stackPositioning: "ABSOLUTE"` | child absolutely positioned **inside** an auto-layout parent (out of flow, placed by `transform`/abs coords). IR node `positioning: "absolute"`. Codegen emits `position:'absolute'` + `left`/`top` (parent `position:'relative'`) for BOTH this flag AND the **absent-`stackMode`** (non-auto-layout frame) case, with `z-index` by child order for overlapping siblings |
| `horizontalConstraint` / `verticalConstraint` (`MIN`/`MAX`/`CENTER`/`STRETCH`/`SCALE`) | resize constraints for absolute layouts → pin/stretch/scale on resize. IR node `constraints: {h, v}` |
| `minSize: {value:{x,y}}` | `minWidth`/`minHeight` (emit when > 0). IR node `minW`/`minH` (`maxSize`→`maxW`/`maxH`, absent in current decodes) |
| `targetAspectRatio: {value:{x,y}}` | `aspectRatio = x / y`. IR node `aspectRatio` |

**Text** (`type: "TEXT"`):

- `textData.characters` — the actual string (this is how you get all copy).
- `fontName: {family, style}`, `fontSize`, `lineHeight: {value, units}`
  (`PIXELS` or `PERCENT`), `letterSpacing: {value, units}`, `textAlignHorizontal`.
- **Text transform & alignment** (IR `text.case` / `text.align` /
  `text.alignVertical` / `text.leadingTrim`; emitted only when non-default):

  | fig field | IR field | CSS |
  |---|---|---|
  | `textCase` (`UPPER`/`LOWER`/`TITLE`/`SMALL_CAPS`/`ORIGINAL`) | `text.case` | `text-transform` — UPPER→`uppercase`, LOWER→`lowercase`, TITLE→`capitalize`, SMALL_CAPS→`uppercase`, ORIGINAL/absent→omitted |
  | `textAlignHorizontal` (`LEFT`/`CENTER`/`RIGHT`/`JUSTIFIED`) | `text.align` | `text-align` — CENTER→`center`, RIGHT→`right`, JUSTIFIED→`justify`, LEFT/absent→omitted |
  | `textAlignVertical` (`TOP`/`CENTER`/`BOTTOM`) | `text.alignVertical` | no single CSS prop — center via flex; TOP/absent→omitted |
  | `leadingTrim` (`CAP_HEIGHT`/`NONE`) | `text.leadingTrim` | optional; NONE/absent→omitted |

- Mixed-style runs live in `textData.styleOverrideTable` — rare in app UI; flag
  if styling looks inconsistent within one string (it is invisible to the tools).

**Four-source reconciliation (for every text value).** Cross-check four sources;
on conflict prefer in this order:

1. **Rendered geometry** — `size.y` of an auto-height text node (a 20px box ≈
   16px font; it rarely lies).
2. **Instance override** values (resolved, incl. `styleOverrideTable` runs).
3. **Node-level** `fontSize`/`lineHeight`/`fontName`.
4. **Layer-name label** ("• 28px") — weakest; routinely stale.

If geometry (1) and the node font (3) disagree, **stop and flag** — do not
silently pick. The IR's `reconcileText` does this for you, emitting `font.size`
with `sizeSource` + a `conflicts[]` entry (a 28px `fontSize` whose box says 16
carries `size:16, sizeSource:"geometry"`). `raw.mts dump` prints `⚠ stale-style?
box.y=20 < lh=36 → size likely ~16` when a declared line-height cannot fit the box.

## 5. Components, instances, and overrides

- Masters are `type: "SYMBOL"` nodes; their subtree is regular nodes.
- `type: "INSTANCE"` nodes have **no children in the tree**. They point to the
  master via `symbolData.symbolID` (a guid). To render an instance, walk the
  master's subtree…
- …then apply `symbolData.symbolOverrides[]`: each entry has `guidPath.guids`
  (path of guids into the master, possibly nested through inner instances) plus
  the overridden fields (`textData`, `fillPaints`, `size`, `visible`, …). This is
  where per-instance text lives.

```sh
node raw.mts overrides $WORK/msg-<name>.json <screen-guidKey>          # raw override list
node raw.mts overrides $WORK/msg-<name>.json <screen-guidKey> --full   # value-print lineHeight/letterSpacing(px)/textCase/cornerRadius/paddings
node raw.mts resolve   $WORK/msg-<name>.json <instance-guidKey>        # composed master + overrides = the rendered tree
```

`raw.mts resolve` composes `master subtree + symbolOverrides` into the rendered
tree, so instances no longer dead-end at `instanceOf=`; it tags overridden text
`[overridden]` and un-overridden text `[MASTER DEFAULT ⚠ likely placeholder]`.
`raw.mts dump --resolve` does the same in the per-screen dump (the default dump
stays raw/fast).

**Designer-intent signal:** an instance with *no* `textData` override renders the
master's placeholder text (e.g. every CTA showing the master's default label =
copy never decided). Detect this and **ask the user instead of shipping
placeholders**.

**Component sets** group variant masters of one component. `raw.mts components`
lists them and derives a typed prop API:

```sh
node raw.mts components $WORK/msg-<name>.json [nameRegex]   # list sets + variants + proposed prop type
```

Detection is **structural first**: a frame whose visible direct children are all
`type: "SYMBOL"` named `prop=value[, prop2=value2]` sharing one axis set is a set
(`[structural, high]`). The `#9747ff` dashed stroke is only a **labeled fallback**
(`[stroke-hint, medium]`) — an editor render hint, not a format guarantee, so
never rely on it alone. A single-axis set proposes a prop named `variant`
regardless of the axis's own name; multi-axis sets get one prop per axis.
`raw.mts components` lists only component *sets*; a standalone master (a lone
SYMBOL with no variant siblings) is found via `find … SYMBOL` (§3).

**Non-variant props (text / boolean / instance-swap).** Beyond the variant axes,
a set frame's `componentPropDefs` declare props that toggle a child node's
`visible`, swap its `TEXT_DATA`, or swap an instance's master. `build-ir.mts`
emits these as `components/<set>.json` `props[]` (`{name (camelCase), rawName,
kind, default, bindings:[{node,field}]}`) + `propGroups[]` (props binding the same
node). The namespace join is the trap: a child's `componentPropRefs.defID` is in
the **master** def namespace, each master def is a stub `{id, parentPropDefId}`,
and `parentPropDefId` points at the **set** def (which carries the human
`name`/`type`/`varValue`). Resolve `ref.defID` → master def → `parentPropDefId` →
set def → name; never match `ref.defID` against a set def id directly (different
id namespaces — it silently fails). Fields normalize `TEXT_DATA`→`characters`,
`VISIBLE`→`visible`, `OVERRIDDEN_SYMBOL_ID`→`symbolId`. Each `props[]` entry also
carries a stable `defKey` (the set-def id key) — the collision-proof identity
codegen joins on (two props can camelCase to the same `name`). For the multi-file
codegen, each `variants[].bindings[]` resolves the SAME set props onto THAT
variant's OWN node guids (`{defKey, rawName, kind, node, field}`, `[]` when the
variant exposes none), so every variant renders its own subtree with its own
bound nodes.

## 6. Vector geometry → SVG (logos, illustrations, custom icons)

The geometry walker lives in `svg-lib.mts` (`extractGeometry`/`toSvgString`/`emitIconComponent`),
shared by `codegen.mts` (component icons, internal) and `export-svg.mts` (standalone CLI).
Component icons are handled inside codegen (`--svg`) — this section is the CLI path for
standalone logos/illustrations. Vector shapes index into `message.blobs`:

- `node.fillGeometry[] = {windingRule, commandsBlob}`; likewise `strokeGeometry`
  (already stroke-outlined — render it as a **fill**).
- `blobs[i].bytes` is `[uint8 opcode][float32 LE args…]` with opcodes `0=Z`,
  `1=M x y`, `2=L x y`, `3=Q cx cy x y`, `4=C c1x c1y c2x c2y x y`.
- Compose each node's `transform` down the tree
  (`matrix(m00 m10 m01 m11 m02 m12)` in SVG argument order); the export root's own
  transform is dropped (it becomes the viewBox origin).
- `windingRule: "ODD"` → `fill-rule="evenodd"`, else `nonzero`.
- Fill color from `fillPaints[0].color`; multiply node × paint opacities.

```sh
node export-svg.mts $WORK/msg-<name>.json <guidKey> out.svg [--png] [--recolor=currentColor]
```

`export-svg.mts` (and `extractGeometry`) follow `symbolData.symbolID` into masters, so
icons/logos that wrap component instances export correctly. The master's baked paints are
emitted; per-instance colour overrides are NOT applied to the geometry — `--recolor=currentColor`
makes fills inherit a `color`, and for component icons codegen drives that `color` from the IR's
override-aware resolved value (so a recoloured icon ships its real colour, not the master default).

Small results (logos, icons) → inline `<svg>` / `react-native-svg` components.
Large hand-drawn ones (100+ paths) → rasterize for runtime performance. Headless
Chrome rasterizes SVG perfectly, no ImageMagick:

```sh
"Google Chrome" --headless --disable-gpu --screenshot=out.png \
  --window-size=286,300 --force-device-scale-factor=3 \
  --default-background-color=00000000 "file:///abs/path/in.svg"
# window-size = SVG's natural px size; scale-factor 3 → @3x; 00000000 = transparent
```

(The same trick composes full-bleed splash images: a tiny HTML page centering the
SVG on the brand background, screenshotted at 3×.)

## 7. Raster and video assets

- Image fills: `paint.image.hash` (byte array) → hex string → filename in the
  zip's `images/`. Copy + downscale (`sips -Z 800` on macOS) into app assets.
- Video fills: `paint.video.hash` → file in `videos/`. Check the codec before
  bundling (H.264 `avc1` is safe cross-platform; the `mvhd` box gives duration —
  useful for splash-animation timing).
- A screen-sized PNG in `images/` may be a *reference screenshot* of another app,
  not an asset — view it before using.

## 8. IR node schema (what `screens/<…>.json` carries)

Every IR node is resolved + reconciled + provenance-stamped, so the IR alone
suffices for a 1:1 implementation (parity with §4). Fields are emitted only when
present so files stay lean.

- **Identity:** `id` (path-derived, stable across re-builds), `path` (unique
  composite address), `guid` (raw master key — NOT unique in a resolved tree),
  `type`, `name`. `raw-map.json` drops any `id` back to its raw `{guid, path}`.
- **Color (`color`)** — the node's primary fill. A fill **bound to a Figma
  variable** carries the token **directly as GROUND TRUTH** (no `--theme` needed):
  `color.var` = the variable's token name (`"Color/praline/950"`),
  `color.varGuid` = the variable guidKey, `color.match = "bound"`, and
  `color.hex` is the variable's RESOLVED value (never the stale cached
  `paint.color`). A literal (unbound) fill keeps `var:null`, `hex = paint.color`.
  One shared resolver (`resolvePaintColor`) drives `color`, `style.fills[]`, and
  `style.strokes[]` so all three stay consistent.
- **`style?`** `{ fills?, cornerRadius?, strokes?, borderWidths?, effects?,
  opacity? }`:
  - `fills[]` — the COMPLETE paint list: each `{type:"solid"|"gradient"|"image",
    hex?, var?, varGuid?, stops?:[{position,hex}], imageHash?, opacity?}`.
    Gradients keep `stops`; images keep `imageHash` (bytes→hex, the `images/`
    filename); solids keep the bound `var`/`varGuid`.
  - `cornerRadius` — a bare number (uniform) or `{tl,tr,br,bl}` (per-corner).
  - `strokes[]` — `{weight, align, hex, var?, varGuid?, cap?, join?, dash?}`
    (`cap`/`join` lower-cased, default `MITER` join omitted; `dash` non-empty ⇒
    dashed).
  - `borderWidths? {top,right,bottom,left}` — emitted ONLY when
    `borderStrokeWeightsIndependent`; then the **per-side** weights apply INSTEAD
    of `strokes[].weight` (absent side = 0). Otherwise the single
    `strokes[].weight` is kept.
  - `effects[]` — `{type, hex, offsetX, offsetY, radius, spread?}`
    (DROP_SHADOW/INNER_SHADOW/*_BLUR). `opacity` only when < 1.
- **`layout?`** `{mode:"row"|"column", gap?, paddingTop?, paddingRight?,
  paddingBottom?, paddingLeft?, justify?, align?, primarySizing?, counterSizing?,
  wrap?}` — emitted only on a real auto-layout frame; absent ⇒ children are
  absolutely positioned (use `box.absX/absY`).
- **Responsive child fields:** `grow`, `alignSelf`, `positioning:"absolute"`,
  `constraints {h,v}`, `minW`/`minH`/`maxW`/`maxH`, `aspectRatio`.
- **`box`** `{x,y,w,h,absX,absY}` — `x/y` relative to parent; `absX/absY`
  absolute from the page origin.
- **`text?`** `{value, placeholder, …}` and **`font?`** — reconciled
  `{family, appFamily, weight, size, sizeSource, sizeToken?, sizeMatch?,
  styleName?, vars?, lineHeightPx, letterSpacingPx, conflicts[]}`. **Trust the
  reconciled `font.size` + `sizeSource`, not the raw `fontSize`.** `vars` carries
  per-property variable bindings (family/weight/size/lineHeight/letterSpacing) so
  codegen references the theme, not literals.

This extraction is a pure function of the bytes and always runs (no `--theme`).
With `--theme <p>`, each **unbound** `color.hex`/`font.size` also gets a code
token **by value, within kind** (`color.{token,match}`,
`font.{sizeToken,sizeMatch}` = `exact`/`nearest(Δ)`/`none`; bound colors stay
`"bound"`). `issues.json`/`intent.json` are informational review notes (never a gate; there is no `decisions.json`).

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
      box means ~16px. Flag, don't assume.
- [ ] `letterSpacing`/`lineHeight` carry a **unit** and are **font-size-relative**
      (`PERCENT → value/100 × fontSize`); px differs per font size and platform
      (CSS `em` scales, RN bakes px). Never read the raw value as px.
- [ ] `styleOverrideTable` is usually rare but **invisible to the tools** when
      present — node-level font can be wrong; flag non-empty tables.
- [ ] Un-overridden instance text = **placeholder** — flag it; confirm copy, don't
      ship `Test`/`Placeholder`/master defaults (`raw.mts resolve` /
      `raw.mts dump --resolve` tag these `[MASTER DEFAULT ⚠ likely placeholder]`).
- [ ] Hidden nodes (`visible: false`) and trial pages must be excluded.
- [ ] `strokeGeometry` is pre-outlined: render as a **fill** with the stroke paint.
- [ ] Fonts in the file may be commercial — check licensing before bundling;
      substitute behind a single token if absent.
- [ ] Match design tokens to code tokens by **value, not name** — variable sets
      can share a name (`praline`) with a different ramp, so a by-name sync
      silently overwrites a deliberately-different value. Match by resolved hex/px
      **within the same domain** (a 16px font ≠ a 16px gap); treat `nearest`/`none`
      as "ask, don't overwrite" (`raw.mts match-tokens`).
- [ ] A screen drawn in **multiple frames** (own page + a consistency-test page)
      may carry **conflicting specs** (designer drift). Diff them
      (`raw.mts diff-frames` raw, or `diff-ir` over two IRs); they **surface** the
      conflict — they do **not** pick silently.
- [ ] Auto-layout `SPACE_EVENLY` vs `SPACE_BETWEEN` **read alike on a 2-item row**
      — check a 3+-item row. Codegen/render run `disambiguateJustify` over resolved
      child geometry and emit `'space-between'` when in-flow children sit flush at
      both main-axis ends.
- [ ] Borders need an explicit **border-style** — CSS defaults to `'none'`
      (invisible even with a width/color); codegen emits `borderStyle`
      `'solid'`/`'dashed'`.
- [ ] `lineHeight` is **framework-conditional**: web emits a `'<n>px'` **string**
      (a bare unitless number is a *multiplier* in React), rn emits a bare px
      **number**.
- [ ] Non-auto-layout frames and `positioning:'absolute'` children get
      `position:'absolute'` + `left`/`top` with the parent `position:'relative'`.
      Icon wrappers **center** their content; image fills emit a `// TODO: image`
      marker + placeholder.
- [ ] **Font substitution is the app's job** — codegen emits each node's Figma family
      name as-is (the faithful default); fig families are often commercial/unavailable, so
      register the face under that name in the app, or swap it (e.g. `Neulis Sans → Figtree`,
      keep `Geist Mono`, keep `Lora`) during elevation. A missing font silently falls back,
      so a wrong substitution shows up in the running app.

## 10. Complete script reference

Runtime: plain Node-compatible `.mts` (Node ≥ 22.18 runs them directly; Bun and
`npx tsx` also work). One dependency: `kiwi-schema`. All scripts import `lib.mts`
(tree index + color helpers) — copy the whole `scripts/` directory together.

### Decode & locate (pre-IR)

| Script | Usage | Purpose |
|---|---|---|
| `parse.mts` | `node parse.mts <canvas.fig> <out.json>` | fig-kiwi → message.json |
| `tree.mts` | `node tree.mts <msg.json>` | page/frame skeleton with guid keys |
| `find.mts` | `node find.mts <msg.json> <regex> [type] [--under <name>]` | locate nodes by name (`--under` scopes to a subtree) |
| `node.mts` | `node node.mts <msg.json> <guidKey> [field …]` | raw single-node JSON (confirm a field before relying on it) |

### IR pipeline (the harness spine)

| Script | Usage | Purpose |
|---|---|---|
| `build-ir.mts` | `node build-ir.mts <msg.json> --scope <pages\|all> [--theme <p>] [--mode <name>] [--out ir-<name>] [--force]` | compile the scoped, provenance-stamped IR: `manifest.json` (incl. `modes` + the resolved `activeMode`) + `raw-map.json` + `fonts.json` + `tokens/*` (incl. `variables.json` = the COMPLETE soft-delete-filtered catalog) + `components/*` (variant matrix + prop API + non-variant `props`/`propGroups` + per-variant `bindings`) + `screens/<page>/<screen>.json` (resolved, reconciled, placeholder-detected, abs-coordinated, full `style`/`layout`). `--mode <name>` pins every variable-bound value to one mode (default: the catalog's primary). With `--theme`: value-maps each unbound color/size to a code token and writes informational `issues.json` + `intent.json` (review notes, never a gate). Faithful defaults: unmapped font → its Figma family; unmatched colour → its literal hex. Re-runs with same source+mode are a no-op; refuses to overwrite an IR built from different bytes without `--force`. Imports only `*-lib.mts` |
| `theme-gen.mts` | `node theme-gen.mts <ir-dir> [--framework web\|rn] [--mode <name>] [--out <dir>]` • `node theme-gen.mts <ir-dir> --list-modes` | the IR's complete variable catalog → a typed theme. No `--framework` → both `theme.ts` (rn) + `theme.css` (web). Mirrors Figma's `/`-hierarchy (`Color/praline/950` → `color.praline['950']`), emitting EVERY mode but making `--mode <name>` (default: `manifest.activeMode`) the active block — web `:root`, RN `defaultMode`. `--list-modes` prints the catalog's modes (the active one marked). **Aliases emitted as CODE REFERENCES to the direct target** (CSS `var(--…)`; RN per-mode IIFE in topological order). Pure logic in `theme-lib.mts` (shared with `codegen.mts`) |
| `codegen.mts` | `node codegen.mts <ir-dir> <set> [--out <dir>] [--framework rn\|web] [--theme-import <module>] [--mode <name>] [--svg <msg.json>] [--images <dir>]` | multi-file component **scaffold** from `components/<set>.json`: `<out>/<slug>/` = `index.tsx` (variant dispatcher) + `types.ts` (`Props` = variant union + COLLAPSED non-variant props) + one `<variant>.tsx` per variant (each renders THAT variant's OWN resolved subtree as JSX — rn View/Text + StyleSheet, web div/span + style objects — with reconciled style/layout/font/text). A value **bound to a Figma variable** is emitted as a **reference into the theme-gen theme**; unbound values keep the reconciled literal + a `// TODO` adjudication. **`--svg <msg.json>`** exports each icon's geometry into a deduplicated owned, recolorable component under `<out>/icons/` (geometry via `svg-lib.mts`; colour from the IR's override-aware resolved value — mono icons use `currentColor` + the token), and renders instance-swap slots as `{slot ?? <Default/>}`. **`--images <dir>`** extracts raster fills into `<slug>/assets/`. PROP COLLAPSE: TEXT→`name?: string`, BOOL-visible→conditional render, BOOL ⊕ TEXT on one node→ONE optional string, INSTANCE_SWAP→`React.ReactNode` slot. Default framework React Native |
| `diff-ir.mts` | `node diff-ir.mts <ir-old> <ir-new>` | design-version diff over two emitted IRs (no decode): added/removed screens & components, changed tokens per mode, drifted type specs, per-screen node/color drift (aligned by `path`, never `guid`). Compares reconciled **truth vs truth**; refuses to diff an IR against itself |
| `ir.mts` | `node ir.mts <ir-dir> <query>` | dumb reader over an emitted IR (no decode): `"fonts where appFamily is empty"`, `"colors with match=none"`, `"nodes with conflicts"`. Otherwise read the small per-screen JSON directly |
| `export-svg.mts` | `node export-svg.mts <msg.json> <guidKey> <out.svg> [--png] [--recolor=currentColor]` | a STANDALONE vector → SVG (logos/illustrations; codegen does component icons internally via the same core). Geometry from `svg-lib.mts`. `--recolor=currentColor` emits recolorable fills; `--png` rasterizes via headless Chrome @3× (degrades gracefully if Chrome is absent) |
| `icons.mts` | `node icons.mts <msg.json> <screen-guidKey>` | inventory icon instances under a screen, resolve each to its library export name (Phosphor `MagnifyingGlass`…), emit the exact `AppIconName` union additions |

### Raw query / verify multiplexer

`raw.mts` is the IR-superseded raw path: the quick query before an IR exists, the
field-confirmation escape hatch, and the **verifier the IR is checked against**.
It reads `message.json` (not the IR).

| Subcommand | Usage | Purpose |
|---|---|---|
| `dump` | `node raw.mts dump <msg.json> <guidKey> [depth] [--abs] [--resolve]` | per-screen implementation dump (`--abs` absolute coords; `--resolve` composes instances + tags placeholders) |
| `resolve` | `node raw.mts resolve <msg.json> <guidKey> [depth]` | compose master + symbolOverrides → the rendered instance tree |
| `overrides` | `node raw.mts overrides <msg.json> <guidKey> [--full]` | instance text/color overrides (`--full` value-prints lineHeight/letterSpacing(px)/textCase/cornerRadius/paddings) |
| `variables` | `node raw.mts variables <msg.json>` | design tokens from Figma variables (alias chains resolved transitively → concrete value; **skips soft-deleted**) |
| `components` | `node raw.mts components <msg.json> [nameRegex]` | list component sets + variant masters + proposed TS prop API |
| `intent` | `node raw.mts intent <msg.json> <screen-guidKey>` | one copy-pasteable designer-intent gap checklist (placeholders, denylisted/repeated strings, reconciliation conflicts, default-variant instances, mono-color icons) |
| `match-tokens` | `node raw.mts match-tokens <msg.json> <theme.(ts\|json)> [guidKey]` | brownfield map mode: annotate fig values vs a code theme **by value, within kind** (`exact`/`nearest(Δ)`/`none`); never rewrites |
| `diff-frames` | `node raw.mts diff-frames <msg.json> <guidA> <guidB>` | resolve both frames, align by name-path, report per-node property deltas. **Surfaces** drift; does **not** pick a canonical winner |

### Libraries & test

Pure modules imported by the CLIs (no top-level side effects), so deterministic
logic is written once and never drifts: `lib.mts`, `resolve-lib.mts`,
`screens-lib.mts`, `components-lib.mts`, `reconcile-lib.mts`, `tokens-lib.mts`,
`mapping-lib.mts`, `theme-lib.mts`, `intent-lib.mts`, `ir-lib.mts`,
`raster-lib.mts`, `describe-lib.mts`, `svg-lib.mts`. Run the regression
suite with `npm test` (`selftest.mts`).
