// theme-gen.mts — emit a typed theme from a compiled IR's variable catalog.
// Reads <ir-dir>/tokens/variables.json (the complete, soft-delete-clean catalog) and
// writes a CSS custom-property sheet (web) and/or a typed TS const tree (rn). Aliases
// are emitted as code references to their target variable, mirroring Figma's `/`
// hierarchy. All logic lives in the pure theme-lib.mts; this file is just IO + argv.
//
// Usage:
//   node theme-gen.mts <ir-dir> [--framework web|rn] [--mode <name>] [--out <dir>]
//                               [--census <message.json>] [--no-census]
//   node theme-gen.mts <ir-dir> --list-modes     # list the catalog's variable modes
//   - no --framework → emit BOTH theme.ts (rn) + theme.css (web)
//   - --mode <name>  → that mode is ROOTED (:root / defaultMode) and the others emit as
//                      .mode-<slug> classes after it (default: manifest.activeMode). A name
//                      that matches no mode is a hard error, never a silent fallback.
//   - --census/--no-census → where to take the live-use census from (default: the decode
//                      recorded in manifest.source.path); it settles duplicate names.
//   - --out <dir>    → write the file(s) into <dir>; without --out → print to stdout
import * as fs from "fs";
import * as path from "path";
import { load } from "../lib/figma-index.mts";
import {
  emitTheme,
  unionModes,
  primaryMode,
  resolveMode,
  variableUseCensus,
  type Framework,
  type ThemeVar,
  type UseCensus,
} from "../lib/theme-lib.mts";

const argv = process.argv.slice(2);
const dir = argv[0];
if (!dir || dir.startsWith("--"))
  throw new Error(
    "usage: theme-gen.mts <ir-dir> [--framework web|rn] [--mode <name>] [--out <dir>] [--census <message.json>] [--no-census] | --list-modes",
  );
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (n: string) => argv.includes(n);

const fwArg = flag("--framework")?.toLowerCase();
if (fwArg && fwArg !== "web" && fwArg !== "rn")
  throw new Error(`--framework must be web|rn (got "${fwArg}")`);
const frameworks: Framework[] = fwArg ? [fwArg as Framework] : ["rn", "web"];
const outDir = flag("--out");

const varsPath = path.join(dir, "tokens", "variables.json");
if (!fs.existsSync(varsPath)) {
  console.error(
    `theme-gen: ${varsPath} not found — is "${dir}" a compiled IR (build-ir.mts) with the variable catalog?`,
  );
  process.exit(2);
}
const vars: ThemeVar[] = JSON.parse(fs.readFileSync(varsPath, "utf8"));
if (!Array.isArray(vars)) {
  console.error(`theme-gen: ${varsPath} is not an array`);
  process.exit(2);
}
if (vars.length === 0)
  console.error("theme-gen: variable catalog is empty — emitting an empty theme");

// Modes: --list-modes prints them (the harness asks the user which to use when >1); the
// chosen --mode (default: manifest.activeMode) is ROOTED as :root / defaultMode.
const modes = unionModes(vars);
const manifest = (() => {
  const p = path.join(dir, "manifest.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
})();
if (hasFlag("--list-modes")) {
  const requested = manifest.activeMode;
  const primary = (requested && resolveMode(modes, requested).mode) || primaryMode(vars);
  for (const m of modes) console.log(m === primary ? `${m} (active)` : m);
  process.exit(0);
}

// Resolving --mode HERE (not silently inside the emitter) is the contract: an explicit flag
// that names no real mode is a usage error, because falling back would emit the collection's
// default under :root while the caller believes it built at the mode it asked for. A stale
// manifest.activeMode is only a warning — the IR, not this invocation, is what is out of date.
const modeArg = flag("--mode");
let activeMode: string | undefined;
if (modeArg !== undefined) {
  const match = resolveMode(modes, modeArg);
  if (match.mode === null) {
    console.error(
      `theme-gen: --mode "${modeArg}" is ${match.reason} — the catalog's modes are [${match.candidates.join(", ")}]`,
    );
    process.exit(2);
  }
  activeMode = match.mode;
} else if (manifest.activeMode) {
  const match = resolveMode(modes, manifest.activeMode);
  if (match.mode !== null) activeMode = match.mode;
  else
    console.error(
      `theme-gen: manifest.activeMode "${manifest.activeMode}" is ${match.reason} in this catalog — rooting the primary mode instead`,
    );
}

// Live-use census: reference counts per variable guid, read from the DECODE (the IR keeps
// bindings as resolved names, which is exactly the information a duplicate-name collision
// destroys). Default source is the decode this IR was built from; --census overrides it and
// --no-census opts out. Missing/unreadable is not fatal — without counts the emitter simply
// falls back to its order-independent guid tie-break and drops nothing.
const uses: UseCensus | undefined = (() => {
  if (hasFlag("--no-census")) return undefined;
  const src = flag("--census") ?? manifest.source?.path;
  if (!src) return undefined;
  if (!fs.existsSync(src)) {
    console.error(
      `theme-gen: no use census — ${src} not found; duplicate names fall back to guid order`,
    );
    return undefined;
  }
  try {
    return variableUseCensus(load(src).nodes);
  } catch (e) {
    console.error(`theme-gen: use census failed on ${src} (${(e as Error).message}) — skipping`);
    return undefined;
  }
})();

const fileFor: Record<Framework, string> = { web: "theme.css", rn: "theme.ts" };
const allWarnings: string[] = [];
const allDropped = new Map<string, string>(); // guid → report line (identical across frameworks)
const written: string[] = [];
const stdoutParts: string[] = [];

for (const framework of frameworks) {
  const { code, warnings, dropped } = emitTheme(vars, { framework, activeMode, uses });
  for (const w of warnings) allWarnings.push(`[${framework}] ${w}`);
  for (const d of dropped)
    allDropped.set(
      d.guid,
      `"${d.name}" ${d.guid} (0 references) — superseded by ${d.keptGuid} (${uses?.get(d.keptGuid) ?? 0} reference(s))`,
    );
  const file = fileFor[framework];
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, file), code);
    written.push(file);
  } else {
    stdoutParts.push(`// ==== ${file} ====\n${code}`);
  }
}

if (outDir) {
  console.error(
    `wrote ${outDir}/ (${written.length} file(s)): ${written.join(", ")}  [${vars.length} variables]`,
  );
} else {
  console.log(stdoutParts.join("\n\n"));
}

// Dropping a variable is never silent: a consumer binding the dropped name gets the surviving
// variable's value now, and the reader has to be able to see that trade happened.
if (allDropped.size) {
  console.error(
    `theme-gen: dropped ${allDropped.size} duplicate-named variable(s) with no live references:`,
  );
  for (const line of allDropped.values()) console.error(`  - ${line}`);
}

if (allWarnings.length) {
  console.error(`theme-gen: ${allWarnings.length} warning(s):`);
  for (const w of allWarnings) console.error(`  - ${w}`);
}
