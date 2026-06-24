// theme-gen.mts — emit a typed theme from a compiled IR's variable catalog.
// Reads <ir-dir>/tokens/variables.json (the complete, soft-delete-clean catalog) and
// writes a CSS custom-property sheet (web) and/or a typed TS const tree (rn). Aliases
// are emitted as code references to their target variable, mirroring Figma's `/`
// hierarchy. All logic lives in the pure theme-lib.mts; this file is just IO + argv.
//
// Usage:
//   node theme-gen.mts <ir-dir> [--framework web|rn] [--out <dir>]
//   - no --framework → emit BOTH theme.ts (rn) + theme.css (web)
//   - --out <dir>    → write the file(s) into <dir>; without --out → print to stdout
import * as fs from "fs";
import * as path from "path";
import { emitTheme, type Framework, type ThemeVar } from "./theme-lib.mts";

const argv = process.argv.slice(2);
const dir = argv[0];
if (!dir || dir.startsWith("--"))
  throw new Error("usage: theme-gen.mts <ir-dir> [--framework web|rn] [--out <dir>]");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const fwArg = flag("--framework")?.toLowerCase();
if (fwArg && fwArg !== "web" && fwArg !== "rn")
  throw new Error(`--framework must be web|rn (got "${fwArg}")`);
const frameworks: Framework[] = fwArg ? [fwArg as Framework] : ["rn", "web"];
const outDir = flag("--out");

const varsPath = path.join(dir, "tokens", "variables.json");
if (!fs.existsSync(varsPath)) {
  console.error(`theme-gen: ${varsPath} not found — is "${dir}" a compiled IR (build-ir.mts) with the variable catalog?`);
  process.exit(2);
}
const vars: ThemeVar[] = JSON.parse(fs.readFileSync(varsPath, "utf8"));
if (!Array.isArray(vars)) {
  console.error(`theme-gen: ${varsPath} is not an array`);
  process.exit(2);
}
if (vars.length === 0) console.error("theme-gen: variable catalog is empty — emitting an empty theme");

const fileFor: Record<Framework, string> = { web: "theme.css", rn: "theme.ts" };
const allWarnings: string[] = [];
const written: string[] = [];
const stdoutParts: string[] = [];

for (const framework of frameworks) {
  const { code, warnings } = emitTheme(vars, { framework });
  for (const w of warnings) allWarnings.push(`[${framework}] ${w}`);
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
  console.error(`wrote ${outDir}/ (${written.length} file(s)): ${written.join(", ")}  [${vars.length} variables]`);
} else {
  console.log(stdoutParts.join("\n\n"));
}

if (allWarnings.length) {
  console.error(`theme-gen: ${allWarnings.length} warning(s):`);
  for (const w of allWarnings) console.error(`  - ${w}`);
}
