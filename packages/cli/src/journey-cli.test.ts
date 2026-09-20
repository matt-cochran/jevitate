import { expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import type { Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";

/**
 * Separate from `program.test.ts` on purpose — that file has a KNOWN
 * pre-existing full-suite timeout flake, and these tests must stay
 * browser-free and fast in isolation.
 */

function makeJourney(overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id: "login",
      name: "Log in",
      description: "Logs a user in",
      promoted: true,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/login",
          steps: [
            {
              step: {
                kind: "navigate",
                url: "/login",
                expect: { kind: "visible", target: { label: "Username" } },
              },
            },
          ],
        },
      ],
    },
  };
}

async function seedJourneysDir(journeys: Journey[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doit-journeys-"));
  for (const journey of journeys) {
    await writeFile(join(dir, `${journey.metadata.id}.json`), JSON.stringify(journey));
  }
  return dir;
}

function newProgram() {
  const profiles = new ProfileManager("/unused-in-these-tests");
  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines };
}

test("journey find --json lists a promoted journey's capabilities (id, name, description, params)", async () => {
  const journeysDir = await seedJourneysDir([makeJourney()]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "find", "", "--dir", journeysDir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({
    v: 1,
    ok: true,
    data: [{ id: "login", name: "Log in", description: "Logs a user in", params: [] }],
  });
});

test("journey find --json excludes unpromoted journeys", async () => {
  const journeysDir = await seedJourneysDir([makeJourney({ id: "draft", promoted: false })]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "find", "", "--dir", journeysDir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({ v: 1, ok: true, data: [] });
});

test("journey list --json returns ALL journeys' metadata, including unpromoted ones", async () => {
  const journeysDir = await seedJourneysDir([
    makeJourney({ id: "published", promoted: true }),
    makeJourney({ id: "draft", promoted: false }),
  ]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "list", "--dir", journeysDir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  const ids = (parsed.data as Array<{ id: string }>).map((m) => m.id).sort();
  expect(ids).toEqual(["draft", "published"]);
});

test("journey run with an unknown --param fails fast (no browser launch) with E_INVALID_PARAMS and a non-zero exit", async () => {
  const savedExitCode = process.exitCode;
  try {
    const journeysDir = await seedJourneysDir([makeJourney()]);
    const { program, lines } = newProgram();

    await program.parseAsync(
      ["journey", "run", "login", "--param", "bogus=x", "--dir", journeysDir, "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_INVALID_PARAMS");
    expect(parsed.error.message).toMatch(/unknown/i);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("journey run with an unknown journey id fails fast with E_UNKNOWN_JOURNEY and a non-zero exit", async () => {
  const savedExitCode = process.exitCode;
  try {
    const journeysDir = await seedJourneysDir([]);
    const { program, lines } = newProgram();

    await program.parseAsync(
      ["journey", "run", "does-not-exist", "--dir", journeysDir, "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));

    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_UNKNOWN_JOURNEY" } });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
