import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { renderCliReference } from "./cli-reference.js";

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cli.md");

describe("docs/cli.md", () => {
  it("matches the CLI surface (regenerate with `pnpm docs:cli`)", () => {
    const generated = renderCliReference(buildProgram({ profiles: new ProfileManager("/unused-in-cli-reference") }));
    const committed = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
    expect(
      committed === generated,
      "docs/cli.md is out of date with the CLI surface: run `pnpm docs:cli` and commit the result.",
    ).toBe(true);
  });
});
