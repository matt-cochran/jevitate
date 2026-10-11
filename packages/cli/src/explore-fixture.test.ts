import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  dir = await realpath(await mkdtemp(join(tmpdir(), "jevitate-cli-fixture-")));
  // #498: a project (`.jevitate/`) — the fixture must lie inside it.
  await mkdir(join(dir, ".jevitate"));
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
    const cwd = process.cwd();
    process.chdir(dir); // #498: inside the project, so a missing fixture is reported as missing
    try {
      await program.parseAsync(
        ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fixture", missing, "--json"],
        { from: "user" },
      );
    } finally {
      process.chdir(cwd);
    }
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

  it("an existing fixture inside the project passes validation and the run proceeds to open the browser", async () => {
    const { program, lines, opened } = newProgram();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await program.parseAsync(
        ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fixture", existing, "--json"],
        { from: "user" },
      );
    } finally {
      process.chdir(cwd);
    }
    expect(opened()).toBe(1);
    expect(lines.join("")).toContain("browser must not be opened");
  });

  it("#498: a fixture outside the project root fails fast with E_EXPLORE_FIXTURE before any browser opens", async () => {
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), "jevitate-cli-proj-")));
    await mkdir(join(outsideRoot, ".jevitate"));
    const { program, lines, opened } = newProgram();
    const cwd = process.cwd();
    process.chdir(outsideRoot);
    try {
      await program.parseAsync(
        ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fixture", existing, "--json"],
        { from: "user" },
      );
    } finally {
      process.chdir(cwd);
    }
    expect(JSON.parse(lines.join(""))).toMatchObject({
      ok: false,
      error: { code: "E_EXPLORE_FIXTURE", message: `upload fixture ${existing} is outside the project root ${outsideRoot} — move the fixture into the project` },
    });
    expect(opened()).toBe(0);
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
