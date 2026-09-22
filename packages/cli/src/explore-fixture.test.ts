import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { buildProgram } from "./program.js";

/**
 * `explore --fixture <path>`: the upload op's file is validated at mission
 * start — a missing file fails fast (E_EXPLORE_FIXTURE) BEFORE any browser is
 * opened — and the flag is refused on strategies that cannot upload rather
 * than silently ignored.
 */

let dir: string;
let existing: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevitate-cli-fixture-"));
  existing = join(dir, "doc.txt");
  await writeFile(existing, "x", "utf8");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function newProgram(): { program: ReturnType<typeof buildProgram>; lines: string[]; opened: () => number } {
  let opens = 0;
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: {
      judge: new FakeJudgmentGateway({}),
      gen: new FakeGenerationGateway(),
      browserPortFactory: () => {
        opens += 1;
        throw new Error("browser must not be opened");
      },
    },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opened: () => opens };
}

const URL = "http://127.0.0.1:3000/profile";

describe("explore --fixture", () => {
  it("goal strategy: a missing fixture fails fast with `fixture not found` before any browser opens", async () => {
    const missing = join(dir, "missing.png");
    const { program, lines, opened } = newProgram();
    await program.parseAsync(
      ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fixture", missing, "--json"],
      { from: "user" },
    );
    expect(JSON.parse(lines.join(""))).toMatchObject({
      ok: false,
      error: { code: "E_EXPLORE_FIXTURE", message: `fixture not found: ${missing}` },
    });
    expect(opened()).toBe(0);
  });

  it("usability strategy: a missing fixture fails fast before any browser opens", async () => {
    const missing = join(dir, "missing.png");
    const { program, lines, opened } = newProgram();
    await program.parseAsync(
      ["explore", "--strategy", "usability", "--url", URL, "--goal", "g", "--app-class", "admin", "--fixture", missing, "--json"],
      { from: "user" },
    );
    expect(JSON.parse(lines.join(""))).toMatchObject({ ok: false, error: { code: "E_EXPLORE_FIXTURE" } });
    expect(opened()).toBe(0);
  });

  it("an existing fixture passes validation and the run proceeds to open the browser", async () => {
    const { program, lines, opened } = newProgram();
    await program.parseAsync(
      ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fixture", existing, "--json"],
      { from: "user" },
    );
    expect(opened()).toBe(1);
    expect(lines.join("")).toContain("browser must not be opened");
  });

  for (const argv of [
    ["explore", "--strategy", "coverage", "--url", URL],
    ["explore", "--strategy", "adversarial", "--url", URL],
    ["explore", "--feature", "profile", "--url", URL],
  ]) {
    it(`is refused (not silently ignored) for: ${argv.slice(1, 3).join(" ")}`, async () => {
      const { program, lines, opened } = newProgram();
      await program.parseAsync([...argv, "--fixture", existing, "--json"], { from: "user" });
      expect(JSON.parse(lines.join(""))).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
      expect(lines.join("")).toContain("--fixture");
      expect(opened()).toBe(0);
    });
  }
});
