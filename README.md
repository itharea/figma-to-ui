# figma-to-ui

Decode binary Figma `.fig` export files locally. No Figma account, no plugin, no REST
API, no cloud. It's a small set of TypeScript scripts that turn a `.fig` file into
authoritative design data (exact colors, font sizes, line heights, paddings, auto-layout
rules, text content, components, SVG vectors, and image/video assets) so an AI coding
agent has a pixel-perfect reference to implement the design as code, 1:1.

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
  - Node >= 22.18, which runs the `.ts` files directly with no transpiler (recommended).
  - [Bun](https://bun.sh): `bun <script>.ts`.
  - Older Node plus [tsx](https://www.npmjs.com/package/tsx): `npx tsx <script>.ts`.
  - The hard floor is Node >= 22.15 or Bun, for `zlib.zstdDecompressSync`.
- One dependency, [kiwi-schema](https://www.npmjs.com/package/kiwi-schema). Install it
  with the project's package manager (`npm i`, `pnpm add`, `yarn add`, or `bun add`);
  it's declared in `package.json`.

## Install

Install it as a skill: clone the repo into your agent's skills directory. The folder
name becomes the skill name (`figma-to-ui`), and the agent picks up `SKILL.md` (the full
`.fig` format spec and workflow) on its own.

| Agent       | Clone into                     |
| ----------- | ------------------------------ |
| Claude Code | `~/.claude/skills/figma-to-ui` |
| Codex       | `~/.agents/skills/figma-to-ui` |
| Zed         | `~/.agents/skills/figma-to-ui` |
| Cursor      | `~/cursor/skills/figma-to-ui`  |

```sh
# example for Claude Code; swap the path for your agent from the table above
git clone <your-repo-url> ~/.claude/skills/figma-to-ui
```

Using a different agent? Clone the repo anywhere and point it at `SKILL.md`.

### Standalone / CLI

Clone and install the one dependency so the scripts can run directly on a `.fig`, for
example from an agent's shell, a CI step, or a pipeline:

```sh
git clone <your-repo-url> figma-to-ui
cd figma-to-ui
npm install        # or pnpm install, yarn, bun install
```

## Usage

With the skill installed, hand your agent the `.fig` file and ask it to implement the
design, or to pull specific pieces: the design tokens, one screen, an icon set, the copy.
Following `SKILL.md`, it unzips the export, decodes `canvas.fig` into queryable JSON,
walks the node graph, and turns the exact node values into code.

`SKILL.md` is the operational spec: the `.fig` format, the node-field reference, the
component and override model, vector-to-SVG handling, and the step-by-step extraction
workflow the agent follows.

## What's in the toolkit

| Script          | What it does                              |
| --------------- | ----------------------------------------- |
| `parse.ts`      | decodes `canvas.fig` (fig-kiwi) to JSON   |
| `tree.ts`       | page/frame skeleton with node keys        |
| `find.ts`       | locates nodes by name                     |
| `variables.ts`  | design tokens from Figma variables        |
| `dump.ts`       | per-screen implementation dump            |
| `overrides.ts`  | per-instance text/color overrides         |
| `export-svg.ts` | vector nodes to SVG                       |

All scripts share `scripts/lib.ts` (the node-tree index and color helpers), so keep the
`scripts/` directory together. Exact invocation for each one lives in `SKILL.md`.

## How it works

`parse.ts` reads the `fig-kiwi` binary container: bytes 0-7 are the magic, then a uint32
version, then length-prefixed chunks. The embedded [kiwi](https://github.com/evanw/kiwi)
schema (chunk 0) decodes the document message (chunk 1), which is decompressed (zstd in
modern files, raw deflate in older ones) into a flat array of nodes. The other scripts
rebuild the node tree from parent pointers and read out tokens, layout, copy, components,
and vector geometry.

## License

[MIT](./LICENSE.md), (c) 2026 itharea
