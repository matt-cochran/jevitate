import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The CLI's real published version, resolved at RUNTIME from @jevitate/cli's
 * own package.json — never a hardcoded literal that silently drifts from what
 * npm actually shipped (ticket #27).
 *
 * The CLI ships BUNDLED (a single `dist/bin.js` built by build.mjs/esbuild),
 * and npm always includes package.json alongside `dist/`. This module is
 * inlined INTO that bundle, so at runtime `import.meta.url` points at
 * `dist/bin.js` and `../package.json` resolves to the shipped
 * `packages/cli/package.json`. The SAME `../package.json` also resolves
 * correctly from the un-bundled `tsc` output (`dist/version.js`) and from the
 * TypeScript source under `src/` during tests — every layout keeps this module
 * exactly one directory below the package root.
 *
 * If the file is somehow unreadable (an exotic pack, a broken install) we fall
 * back to a safe constant rather than crashing `--version`. This is a display
 * value, not a safety decision, so a fallback here is benign.
 */
const FALLBACK_VERSION = "0.0.0";

export function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through to the safe display fallback below
  }
  return FALLBACK_VERSION;
}
