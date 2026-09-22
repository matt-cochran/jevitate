import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { readCliVersion } from "./version.js";

/** The single source of truth: @jevitate/cli's own package.json, read the same
 * way the shipped CLI resolves it (../package.json relative to this module). */
function packageJsonVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("readCliVersion", () => {
  test("returns the real published version, never the hardcoded 0.0.0", () => {
    const version = readCliVersion();
    expect(version).toBe(packageJsonVersion());
    expect(version).not.toBe("0.0.0");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
