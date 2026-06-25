// Headless-Chrome rasterization helper. One implementation, reused by
// export-svg.mts (--png). NO top-level side effects.
//
// GRACEFUL DEGRADATION (phase-05 fallback rule): if no Chrome binary is found, or
// the screenshot subprocess fails, return {ok:false,reason} instead of throwing —
// the caller keeps the .svg/.html it already wrote and prints a note. This is why
// render/png tools never hard-crash on a Chrome-less machine.
import * as fs from "fs";
import { spawnSync } from "child_process";

// Candidate Chrome/Chromium binaries across platforms. The macOS app bundle path
// is the SKILL.md §6 default; the rest cover Linux/CI. First existing wins; a bare
// name (no slash) is trusted to PATH.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "chrome",
].filter(Boolean) as string[];

export function findChrome(): string | null {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes("/")) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    // bare name → probe PATH via `command -v` without throwing
    const r = spawnSync("/bin/sh", ["-c", `command -v ${c}`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return c;
  }
  return null;
}

// Screenshot a local file (SVG or HTML) to PNG at (w×h) × scale. Returns ok/reason
// so the caller degrades gracefully. `bg` "00000000" = transparent (default).
export function rasterizeFile(
  inFile: string,
  pngOut: string,
  w: number,
  h: number,
  scale = 2,
  bg = "00000000"
): { ok: boolean; reason?: string } {
  const chrome = findChrome();
  if (!chrome) return { ok: false, reason: "no Chrome binary found (set CHROME_PATH)" };
  const ww = Math.max(1, Math.ceil(w));
  const hh = Math.max(1, Math.ceil(h));
  const args = [
    "--headless",
    "--disable-gpu",
    `--screenshot=${pngOut}`,
    `--window-size=${ww},${hh}`,
    `--force-device-scale-factor=${scale}`,
    `--default-background-color=${bg}`,
    `file://${fs.realpathSync(inFile)}`,
  ];
  const r = spawnSync(chrome, args, { encoding: "utf8", timeout: 60000 });
  if (r.error) return { ok: false, reason: String(r.error.message ?? r.error) };
  if (!fs.existsSync(pngOut)) return { ok: false, reason: `chrome exit ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}` };
  return { ok: true };
}
