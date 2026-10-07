import { expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

/** #401: a weak Journey — its only step's expect restates the step's own target, so it proves nothing. */
function weakJourney(overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id: "weak",
      name: "Weak",
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            {
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
            },
          ],
        },
      ],
    },
  };
}

/** #401: a strengthened Journey — a step-request check on its write plus a reloadThen end state. */
function strongJourney(overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id: "strong",
      name: "Strong",
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            {
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/publish", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

async function seedJourneysDir(journeys: Journey[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jevitate-journeys-"));
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
    expect(process.exitCode).toBe(64);
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
    expect(process.exitCode).toBe(64);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("journey run --self-heal hybrid wires a SelfHealer into the JourneyRunner (flag accepted, threaded, fails CLOSED with no AI gateway)", async () => {
  // Flag-plumbing smoke test: the CLI accepts `--self-heal hybrid` and
  // threads it into RunPolicy.selfHeal.mode WITHOUT commander rejecting it as
  // an unknown option and WITHOUT launching a browser. Because no AI gateway
  // is selected (--real/--fake-ai), self-heal fails CLOSED with a clear
  // E_AI_SETUP_REQUIRED — never a silent unhealed run. A full self-heal run
  // is exercised by @jevitate/runtime's tests and self-heal-adapter.test.ts.
  const savedExitCode = process.exitCode;
  try {
    const dir = await seedJourneysDir([makeJourney()]);
    const { program, lines } = newProgram();
    await expect(
      program.parseAsync(["journey", "run", "login", "--dir", dir, "--self-heal", "hybrid", "--json"], { from: "user" }),
    ).resolves.not.toThrow();
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_AI_SETUP_REQUIRED");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("#124: journey promote <id> promotes an unpromoted journey (human-approval gate) and persists it", async () => {
  const journeysDir = await seedJourneysDir([strongJourney({ id: "draft" })]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "promote", "draft", "--dir", journeysDir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({ v: 1, ok: true, data: { id: "draft", promoted: true } });

  // Persisted: a second read via `journey list` shows it promoted.
  const { program: program2, lines: lines2 } = newProgram();
  await program2.parseAsync(["journey", "list", "--dir", journeysDir, "--json"], { from: "user" });
  const listed = JSON.parse(lines2.join(""));
  expect(listed.data).toContainEqual(expect.objectContaining({ id: "draft", promoted: true }));
});

test("journey promote with an unknown id fails fast with E_UNKNOWN_JOURNEY and a non-zero exit", async () => {
  const savedExitCode = process.exitCode;
  try {
    const journeysDir = await seedJourneysDir([]);
    const { program, lines } = newProgram();

    await program.parseAsync(["journey", "promote", "does-not-exist", "--dir", journeysDir, "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));

    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_UNKNOWN_JOURNEY" } });
    expect(process.exitCode).toBe(64);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("journey run with no --self-heal is unchanged: default fail-closed, no AI setup demanded", async () => {
  // The additive flag must not change existing behavior. With no --self-heal,
  // an unknown journey still fails fast the same way (no AI-setup gate).
  const savedExitCode = process.exitCode;
  try {
    const dir = await seedJourneysDir([]);
    const { program, lines } = newProgram();
    await program.parseAsync(["journey", "run", "nope", "--dir", dir, "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.error.code).toBe("E_UNKNOWN_JOURNEY");
  } finally {
    process.exitCode = savedExitCode;
  }
});

// #401 — `journey lint` and the promote gate.

test("#401: journey lint reports an own-target-visible error for a weak Journey", async () => {
  const dir = await seedJourneysDir([weakJourney()]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "lint", "weak", "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.data.findings).toContainEqual(expect.objectContaining({ rule: "own-target-visible", level: "error" }));
});

test("#401: journey lint exits 1 when a Journey has an error finding", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await seedJourneysDir([weakJourney()]);
    const { program } = newProgram();

    await program.parseAsync(["journey", "lint", "weak", "--dir", dir, "--json"], { from: "user" });

    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("#401: journey lint reports no errors for a strengthened Journey", async () => {
  const dir = await seedJourneysDir([strongJourney()]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "lint", "strong", "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.data.errors).toBe(0);
});

test("#401: journey lint exits 0 when a Journey has no error findings", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await seedJourneysDir([strongJourney()]);
    const { program } = newProgram();

    await program.parseAsync(["journey", "lint", "strong", "--dir", dir, "--json"], { from: "user" });

    expect(process.exitCode).toBe(0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("#401: journey lint on an unknown id fails with E_UNKNOWN_JOURNEY", async () => {
  const dir = await seedJourneysDir([]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "lint", "does-not-exist", "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_UNKNOWN_JOURNEY" } });
});

test("#401: journey promote of a weak Journey without --accept-weak fails with E_JOURNEY_WEAK", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await seedJourneysDir([weakJourney({ id: "weak" })]);
    const { program, lines } = newProgram();

    await program.parseAsync(["journey", "promote", "weak", "--dir", dir, "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));

    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_JOURNEY_WEAK" } });
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("#401: journey promote of a weak Journey without --accept-weak leaves it unpromoted", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await seedJourneysDir([weakJourney({ id: "weak" })]);
    const { program } = newProgram();
    await program.parseAsync(["journey", "promote", "weak", "--dir", dir, "--json"], { from: "user" });

    const { program: program2, lines: lines2 } = newProgram();
    await program2.parseAsync(["journey", "list", "--dir", dir, "--json"], { from: "user" });
    const listed = JSON.parse(lines2.join(""));

    expect(listed.data).toContainEqual(expect.objectContaining({ id: "weak", promoted: false }));
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("#401: journey promote --accept-weak promotes a weak Journey", async () => {
  const dir = await seedJourneysDir([weakJourney({ id: "weak" })]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "promote", "weak", "--accept-weak", "demo only", "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({ v: 1, ok: true, data: { id: "weak", promoted: true } });
});

test("#401: journey promote --accept-weak records the acceptance reason in the Journey's metadata", async () => {
  const dir = await seedJourneysDir([weakJourney({ id: "weak" })]);
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "promote", "weak", "--accept-weak", "demo only", "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.data.acceptedWeak).toEqual({ reason: "demo only", rules: ["own-target-visible", "visibility-only"] });
});

test("#401: journey lint --sarif writes one result per finding", async () => {
  const dir = await seedJourneysDir([weakJourney({ id: "weak" })]);
  const sarifPath = join(await mkdtemp(join(tmpdir(), "jevitate-lint-")), "lint.sarif");
  const { program, lines } = newProgram();

  await program.parseAsync(["journey", "lint", "weak", "--sarif", sarifPath, "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));
  const sarif = JSON.parse(await readFile(sarifPath, "utf8"));

  expect(sarif.runs[0].results).toHaveLength(parsed.data.findings.length);
});
