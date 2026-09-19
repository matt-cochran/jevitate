import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@doit/daemon";
import { SitePolicySchema } from "@doit/domain";
import type { Recording, Step, AuthoringRecording, PostdocDecision } from "@doit/recording";
import { AuthoringTakeSchema, diffTakes, applyPostdoc } from "@doit/recording";
import { buildProgram } from "./program.js";

// === recording command fixture helpers ===

function fillStep(testId: string, value: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: false, value },
    expect: { kind: "visible", target: { testId } },
  };
}

function clickStep(testId: string): Step {
  return {
    kind: "click",
    target: { testId },
    expect: { kind: "visible", target: { testId } },
  };
}

/**
 * Builds a local `{recording, values}` authoring-take JSON object (the
 * shape `recording diff` reads from disk) from a flat list of steps (single
 * page), auto-populating `values` (a plain object, NOT a Map — see
 * `recording diff`'s doc) for fill/select steps from their captured
 * (non-redacted) `value`, keyed `"page:stepInPage"` per Task 1's convention.
 *
 * Validated against `AuthoringTakeSchema` — the ONE canonical take-file
 * shape (`@doit/recording`'s `diff.ts`) — before being returned, so this
 * fixture builder can never silently drift from what `recording diff`
 * actually accepts.
 */
function authoringTakeJson(steps: Step[]): { recording: Recording; values: Record<string, string> } {
  const values: Record<string, string> = {};
  steps.forEach((step, i) => {
    if ((step.kind === "fill" || step.kind === "select") && step.value && "value" in step.value) {
      values[`0:${i}`] = step.value.value;
    }
  });
  const recording: Recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "https://example.test/login",
        steps: steps.map((step) => ({ step })),
      },
    ],
  };
  return AuthoringTakeSchema.parse({ recording, values });
}

test("profile create prints a success envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["profile", "create", "main", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: { name: "main", exists: true } });
});

test("profile create prints a failure envelope and sets exit code 1 when the action throws", async () => {
  const savedExitCode = process.exitCode;
  try {
    const profiles = {
      create: async () => {
        throw new Error("boom");
      },
      status: async () => {
        throw new Error("not used");
      },
    } as unknown as ProfileManager;
    const lines: string[] = [];
    const program = buildProgram({ profiles });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(["profile", "create", "x", "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({
      v: 1,
      ok: false,
      error: { code: "E_PROFILE_CREATE", message: expect.stringContaining("boom") },
    });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("site policy set then site policy get --json round-trips via a temp --db", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const dbPath = join(root, "db.sqlite");
  const policyPath = join(root, "policy.json");
  const policy = {
    version: "1",
    interaction: { typing: { charsPerSecond: 5, perKeyJitter: 0.1 } },
  };
  await writeFile(policyPath, JSON.stringify(policy));

  const setLines: string[] = [];
  const setProgram = buildProgram({ profiles });
  setProgram.configureOutput({ writeOut: (s) => setLines.push(s) });
  setProgram.exitOverride();
  await setProgram.parseAsync(
    ["site", "policy", "set", "example.com", "--file", policyPath, "--db", dbPath, "--json"],
    { from: "user" }
  );
  const setParsed = JSON.parse(setLines.join(""));
  expect(setParsed).toMatchObject({ v: 1, ok: true, data: { site: "example.com", version: "1" } });

  const getLines: string[] = [];
  const getProgram = buildProgram({ profiles });
  getProgram.configureOutput({ writeOut: (s) => getLines.push(s) });
  getProgram.exitOverride();
  await getProgram.parseAsync(
    ["site", "policy", "get", "example.com", "--db", dbPath, "--json"],
    { from: "user" }
  );
  const getParsed = JSON.parse(getLines.join(""));
  expect(getParsed).toMatchObject({ v: 1, ok: true, data: { version: "1" } });
});

test("site policy get --json succeeds when the --db parent directory does not yet exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  // Only `root` exists; `nested/subdir` must be created by the command itself,
  // matching ProfileManager.create()'s mkdir(dir, { recursive: true }) pattern.
  const dbPath = join(root, "nested", "subdir", "db.sqlite");

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["site", "policy", "get", "example.com", "--db", dbPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: null });
});

test("site policy get --json reports null data when no policy is stored", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const dbPath = join(root, "db.sqlite");

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["site", "policy", "get", "nosite.com", "--db", dbPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: null });
});

test("site simulate prints a timing profile with totalMs, using an empty interaction when no policy is stored", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const dbPath = join(root, "db.sqlite");
  const scriptPath = join(root, "script.json");
  const script = [
    { kind: "click", label: "open menu" },
    { kind: "type", label: "search box", text: "hello" },
  ];
  await writeFile(scriptPath, JSON.stringify(script));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["site", "simulate", "example.com", "--script", scriptPath, "--db", dbPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toMatchObject({ totalMs: expect.any(Number) });
  expect(Array.isArray(parsed.data.steps)).toBe(true);
  expect(parsed.data.steps).toHaveLength(2);
  // no stored policy => empty interaction => zero delay
  expect(parsed.data.totalMs).toBe(0);
});

test("site simulate --seed abc returns a failure envelope and sets exit code 1 (invalid seed must not silently become 0)", async () => {
  const savedExitCode = process.exitCode;
  try {
    const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
    const profiles = new ProfileManager(root);
    const dbPath = join(root, "db.sqlite");
    const scriptPath = join(root, "script.json");
    const script = [{ kind: "click", label: "open menu" }];
    await writeFile(scriptPath, JSON.stringify(script));

    const lines: string[] = [];
    const program = buildProgram({ profiles });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(
      ["site", "simulate", "example.com", "--script", scriptPath, "--db", dbPath, "--seed", "abc", "--json"],
      { from: "user" }
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_INVALID_SEED" } });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("recording diff of two JSON takes prints a variable column", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const takeAPath = join(root, "takeA.json");
  const takeBPath = join(root, "takeB.json");

  const takeA = authoringTakeJson([fillStep("username", "jane"), clickStep("submit")]);
  const takeB = authoringTakeJson([fillStep("username", "bob"), clickStep("submit")]);
  await writeFile(takeAPath, JSON.stringify(takeA));
  await writeFile(takeBPath, JSON.stringify(takeB));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["recording", "diff", takeAPath, takeBPath, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  expect(Array.isArray(parsed.data.columns)).toBe(true);
  const variableColumns = parsed.data.columns.filter((c: { kind: string }) => c.kind === "variable");
  expect(variableColumns.length).toBeGreaterThan(0);
  expect(variableColumns[0].values).toEqual(["jane", "bob"]);
});

test("recording diff fails closed (E_INVALID_TAKE, exit 1) when a take file's `values` field is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const takeAPath = join(root, "takeA.json");
  const takeBPath = join(root, "takeB.json");

  const takeA = authoringTakeJson([fillStep("username", "jane"), clickStep("submit")]);
  const takeB = authoringTakeJson([fillStep("username", "bob"), clickStep("submit")]);
  // Simulate a malformed take file: `values` is missing entirely. This must
  // be rejected (fail closed), NOT silently treated as an empty values map
  // — a silently-empty map would make every column classify as "constant",
  // the single worst possible wrong answer for a variable-detection feature.
  const { values: _omitted, ...takeAWithoutValues } = takeA;
  await writeFile(takeAPath, JSON.stringify(takeAWithoutValues));
  await writeFile(takeBPath, JSON.stringify(takeB));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["recording", "diff", takeAPath, takeBPath, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_INVALID_TAKE" } });
  expect(process.exitCode).toBe(1);
});

test("recording diff fails closed (E_INVALID_TAKE, exit 1) when a take file's `values` field is malformed (wrong shape)", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const takeAPath = join(root, "takeA.json");
  const takeBPath = join(root, "takeB.json");

  const takeA = authoringTakeJson([fillStep("username", "jane"), clickStep("submit")]);
  const takeB = authoringTakeJson([fillStep("username", "bob"), clickStep("submit")]);
  // `values` present but the wrong shape (an array instead of a
  // string-keyed record of strings) — must still fail closed.
  await writeFile(takeAPath, JSON.stringify({ recording: takeA.recording, values: ["not", "a", "record"] }));
  await writeFile(takeBPath, JSON.stringify(takeB));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["recording", "diff", takeAPath, takeBPath, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_INVALID_TAKE" } });
  expect(process.exitCode).toBe(1);
});

test("recording fit prints a policy whose full output round-trips through SitePolicySchema", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const recPath = join(root, "rec.json");

  const rec: Recording = {
    version: "1",
    site: "https://example.com",
    pages: [
      {
        url: "/a",
        steps: [
          {
            step: fillStep("field", "hello"),
            timing: { atMs: 0, durationMs: 1000, gapBeforeMs: 0 },
          },
        ],
      },
    ],
  };
  await writeFile(recPath, JSON.stringify(rec));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["recording", "fit", recPath, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  expect(parsed.data.interaction.typing.charsPerSecond).toBeCloseTo(5, 5);

  // The claim "ready to `site policy set`" requires the WHOLE emitted `data`
  // to be a valid SitePolicy, not just the nested `interaction` field.
  const result = SitePolicySchema.safeParse(parsed.data);
  expect(result.success).toBe(true);
});

test("recording promote sets value:{var:...} at the targeted fill step", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const recPath = join(root, "rec.json");

  const rec: Recording = {
    version: "1",
    site: "https://example.com",
    pages: [{ url: "/login", steps: [{ step: fillStep("username", "jane") }] }],
  };
  await writeFile(recPath, JSON.stringify(rec));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["recording", "promote", recPath, "--page", "0", "--step", "0", "--var", "username"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.pages[0].steps[0].step.value).toEqual({ var: "username" });
  expect(parsed.pages[0].steps[0].variableName).toBe("username");
});

test("recording promote on a click step returns a fail envelope and sets exit code 1", async () => {
  const savedExitCode = process.exitCode;
  try {
    const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
    const profiles = new ProfileManager(root);
    const recPath = join(root, "rec.json");

    const rec: Recording = {
      version: "1",
      site: "https://example.com",
      pages: [{ url: "/login", steps: [{ step: clickStep("submit") }] }],
    };
    await writeFile(recPath, JSON.stringify(rec));

    const lines: string[] = [];
    const program = buildProgram({ profiles });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(
      ["recording", "promote", recPath, "--page", "0", "--step", "0", "--var", "x"],
      { from: "user" }
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ v: 1, ok: false });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

/** Loads a `--decisions <file>`-shaped take file the same way `recording
 * diff`/`recording postdoc` do (see `program.ts`'s copied loading snippet). */
async function loadAuthoringRecording(path: string): Promise<AuthoringRecording> {
  const raw = await readFile(path, "utf8");
  const parsed = AuthoringTakeSchema.parse(JSON.parse(raw));
  return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
}

test("recording postdoc --decisions applies the decisions and prints the same Recording applyPostdoc would produce", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const takeAPath = join(root, "takeA.json");
  const takeBPath = join(root, "takeB.json");
  const decisionsPath = join(root, "decisions.json");

  // username varies across takes; email does not; submit is a plain click.
  const takeA = authoringTakeJson([
    fillStep("username", "jane"),
    fillStep("email", "jane@example.test"),
    clickStep("submit"),
  ]);
  const takeB = authoringTakeJson([
    fillStep("username", "bob"),
    fillStep("email", "jane@example.test"),
    clickStep("submit"),
  ]);
  await writeFile(takeAPath, JSON.stringify(takeA));
  await writeFile(takeBPath, JSON.stringify(takeB));

  const decisions: PostdocDecision[] = [
    { step: { page: 0, step: 0 }, classify: "variable", name: "username" },
    { step: { page: 0, step: 1 }, classify: "constant", label: "email field" },
    { step: { page: 0, step: 2 }, classify: "handback", prompt: "confirm submission" },
  ];
  await writeFile(decisionsPath, JSON.stringify(decisions));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["recording", "postdoc", takeAPath, takeBPath, "--decisions", decisionsPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);

  const takes = await Promise.all([loadAuthoringRecording(takeAPath), loadAuthoringRecording(takeBPath)]);
  const diff = diffTakes(takes);
  const expected = applyPostdoc(takes[0], diff, decisions);

  expect(parsed.data).toEqual(JSON.parse(JSON.stringify(expected)));
});

test("recording postdoc --decisions fails closed (E_INVALID_DECISIONS, exit 1) on a malformed decisions file", async () => {
  const savedExitCode = process.exitCode;
  try {
    const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
    const profiles = new ProfileManager(root);
    const takeAPath = join(root, "takeA.json");
    const takeBPath = join(root, "takeB.json");
    const decisionsPath = join(root, "decisions.json");

    const takeA = authoringTakeJson([fillStep("username", "jane"), clickStep("submit")]);
    const takeB = authoringTakeJson([fillStep("username", "bob"), clickStep("submit")]);
    await writeFile(takeAPath, JSON.stringify(takeA));
    await writeFile(takeBPath, JSON.stringify(takeB));
    // Missing required `name` for a "variable" decision — must fail closed.
    await writeFile(
      decisionsPath,
      JSON.stringify([{ step: { page: 0, step: 0 }, classify: "variable" }])
    );

    const lines: string[] = [];
    const program = buildProgram({ profiles });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(
      ["recording", "postdoc", takeAPath, takeBPath, "--decisions", decisionsPath, "--json"],
      { from: "user" }
    );
    const parsed = JSON.parse(lines.join(""));

    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_INVALID_DECISIONS" } });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
