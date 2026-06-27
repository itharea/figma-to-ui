# figma-to-ui

Decode binary Figma `.fig` export files locally. No Figma account, no plugin, no REST
API, no cloud. It's a small set of TypeScript scripts plus a **harness** that turns a
`.fig` file into authoritative design data (exact colors, font sizes, line heights,
paddings, auto-layout rules, text content, components, SVG vectors, and image/video
assets) so an AI coding agent has a pixel-perfect reference to implement the design as
code, 1:1.

The harness compiles the `.fig` into a **Design IR** once, then drives a fixed sequence:
build IR → generate a theme from the file's variables (pick the mode) → scaffold each
component set with its icons and image fills wired in → elevate the scaffolds into clean
components → assemble the screens by locating the designer's component instances under the
screen nodes. Elevate and assemble are grouped into subagent batches — one subagent per
group — so a large design system stays affordable. `SKILL.md` is that harness; `REFERENCE.md`
is the `.fig` format and node-field encyclopedia it points to.

It's model-, company-, and toolchain-agnostic. The scripts are plain Node-compatible
TypeScript (run them with Node, Bun, or tsx; install with npm, pnpm, yarn, or bun), and
`SKILL.md` is a vendor-neutral spec. Use it with any AI coding agent: Claude Code,
Cursor, Codex, Zed, and others.

## Why decode the .fig instead of working from a screenshot?

A screenshot is just pixels. Every color, font size, line height, padding, corner
radius, and gap has to be eyeballed and guessed, so the result drifts a bit everywhere
and almost never matches. The decoded `.fig` carries the exact values the designer set
(the real numbers, hex codes, auto-layout rules, and text), so the UI comes out
pixel-perfect instead of approximated.

## Requirements

The scripts are plain Node-compatible TypeScript, so they run on whatever the host
project already uses:

- A runtime, any one of:
  - Node >= 22.18, which runs the `.mts` files directly with no transpiler (recommended).
  - [Bun](https://bun.sh): `bun <script>.mts`.
  - Older Node plus [tsx](https://www.npmjs.com/package/tsx): `npx tsx <script>.mts`.
  - The hard floor is Node >= 22.15 or Bun, for `zlib.zstdDecompressSync`.

- One dependency, [kiwi-schema](https://www.npmjs.com/package/kiwi-schema). Install it
  with the project's package manager (`npm i`, `pnpm add`, `yarn add`, or `bun add`);
  it's declared in `package.json`.

## Install

Install it as a skill: clone the repo into your agent's skills directory. The folder
name becomes the skill name (`figma-to-ui`), and the agent picks up `SKILL.md` (the
harness procedure) on its own, with `REFERENCE.md` alongside for field-level detail.

| Agent       | Clone into                     |
| ----------- | ------------------------------ |
| Claude Code | `~/.claude/skills/figma-to-ui` |
| Codex       | `~/.agents/skills/figma-to-ui` |
| Zed         | `~/.agents/skills/figma-to-ui` |
| Cursor      | `~/cursor/skills/figma-to-ui`  |

```sh
# example for Claude Code; swap the path for your agent from the table above
git clone https://github.com/itharea/figma-to-ui.git ~/.claude/skills/figma-to-ui
```

Using a different agent? Clone the repo anywhere and point it at `SKILL.md`.

### Standalone / CLI

Clone and install the one dependency so the scripts can run directly on a `.fig`, for
example from an agent's shell, a CI step, or a pipeline:

```sh
git clone https://github.com/itharea/figma-to-ui.git
cd figma-to-ui
npm install        # or pnpm install, yarn, bun install
```

## Usage

With the skill installed, hand your agent the `.fig` file and ask it to implement the
design, or to pull specific pieces: the design tokens, one screen, an icon set, the copy.
Following `SKILL.md`, it unzips the export, decodes `canvas.fig` into queryable JSON,
walks the node graph, and turns the exact node values into code.

`SKILL.md` is the operational harness; `REFERENCE.md` is the reference it links to (the
`.fig` format, the node-field tables, the component/override model, vector-to-SVG, the
IR node schema, the pitfalls checklist, and every script's flags).

## What's in the toolkit

| Stage              | Scripts                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| Decode & locate    | `parse`, `tree`, `find`, `node`                                         |
| IR spine           | `build-ir`, `theme-gen`, `codegen`, `diff-ir`, `ir`                     |
| Assets             | `export-svg`, `icons`, `svg-lib`                                         |
| Raw query / verify | `raw.mts <dump\|resolve\|overrides\|variables\|components\|intent\|match-tokens\|diff-frames>` |
| Test               | `selftest.mts` (`npm test`)                                             |

`build-ir.mts` is the centerpiece — it compiles the decoded message into the IR every
other step reads. `theme-gen.mts` turns the file's variables into a typed theme, and
`codegen.mts` scaffolds each component set — wiring its icons (geometry via `svg-lib.mts`,
recoloured from the IR) and image fills in deterministically, so the scaffold is
data-complete before an elevate subagent refactors it into the shipped component. All
scripts share `scripts/lib.mts` (the node-tree index and color helpers) and the pure
`*-lib.mts` modules, so keep the `scripts/` directory together. Exact invocation for each
lives in `SKILL.md` / `REFERENCE.md`.

## How it works

`parse.mts` reads the `fig-kiwi` binary container: bytes 0-7 are the magic, then a uint32
version, then length-prefixed chunks. The embedded [kiwi](https://github.com/evanw/kiwi)
schema (chunk 0) decodes the document message (chunk 1), which is decompressed (zstd in
modern files, raw deflate in older ones) into a flat array of nodes. The other scripts
rebuild the node tree from parent pointers and read out tokens, layout, copy, components,
and vector geometry.

## License

[MIT](./LICENSE.md), (c) 2026 itharea
