import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { MISSION_EXIT_CODES } from "@jevitate/domain";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import { startServer } from "@jevitate/example-site";
import { buildProgram, type CliDeps } from "./program.js";
import { EXIT_CODES, exitCodeForError } from "./exit-codes.js";
import { formatMissionHuman, formatRegressionCaptureHuman, formatRegressionRunHuman } from "./cli-output.js";

/**
 * The CLI contract (#210): ONE exit-code table for every command (usage errors distinct from
 * defects), ONE output rule for every explore strategy (the envelope with --json, a human summary
 * without), and a human init/ledger/verify-fix/check that never prints raw JSON.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cli-contract-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  delete process.env.JEV_210_UNSET;
});

/** A browser port that refuses to open: a run that gets past its argument checks fails at runtime. */
const refusingPort: BrowserPort = {
  async open() {
    throw new Error("open intercepted by test");
  },
};

function cli(extra: Partial<CliDeps> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => refusingPort },
    ...extra,
  });
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  // Commander calls the SUBCOMMAND's exit on a parse error: override every level (none inherit it).
  const override = (c: typeof program): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  const run = async (argv: string[]): Promise<{ code: number | undefined; out: string; err: string }> => {
    process.exitCode = undefined;
    let code: number | undefined;
    try {
      await program.parseAsync(argv, { from: "user" });
      code = process.exitCode === undefined ? undefined : Number(process.exitCode);
    } catch (err) {
      if (!(err instanceof CommanderError)) throw err;
      code = err.exitCode;
    }
    return { code, out: stdout.join(""), err: stderr.join("") };
  };
  return { run };
}

const URL = "http://127.0.0.1:3999/";

describe("one exit-code table (#210)", () => {
  it("keeps the mission codes 0–4 and gives usage errors their own code", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, defects: 1, inconclusive: 2, hang: 3, intermittent: 4, usage: 64 });
    expect(MISSION_EXIT_CODES).toEqual({ clean: 0, "defects-found": 1, inconclusive: 2, crashed: 2, hang: 3, intermittent: 4 });
    for (const code of ["E_EXPLORE_ARGS", "E_EXPLORE_ASSERTION", "E_CHECK_SUITE", "E_LEDGER_INPUT", "E_VERIFY_FIX_ARGS", "E_UNKNOWN_JOURNEY"]) {
      expect(exitCodeForError(code), code).toBe(64);
    }
    for (const code of ["E_EXPLORE_RUN", "E_CHECK", "E_PROFILE_CREATE", "E_LEDGER"]) expect(exitCodeForError(code), code).toBe(2);
  });

  it("explore: an unset --secret env var is a usage error (64), not defects-found (1)", async () => {
    const r = await cli().run(["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--secret", "env:JEV_210_UNSET", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(r.code).toBe(64);
  });

  it("explore: an unparseable --success is a usage error (64)", async () => {
    const r = await cli().run(["explore", "--url", URL, "--goal", "g", "--success", "nonsense:Saved", "--fake-ai", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ASSERTION" } });
    expect(r.code).toBe(64);
  });

  it("explore: a run that broke at runtime is 2 (proves nothing), never 1", async () => {
    const r = await cli().run(["explore", "--strategy", "adversarial", "--url", URL, "--fake-ai", "--out", dir, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_EXPLORE_RUN" } });
    expect(r.code).toBe(2);
  });

  it("a commander parse error (unknown option, missing required option) is 64", async () => {
    expect((await cli().run(["explore", "--no-such-flag"])).code).toBe(64);
    expect((await cli().run(["check"])).code).toBe(64);
  });

  it("check: an unreadable suite is 64 (it was 2, the same as an errored item)", async () => {
    const r = await cli().run(["check", "--suite", join(dir, "missing.json"), "--out", dir, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_CHECK_SUITE" } });
    expect(r.code).toBe(64);
  });

  it("ledger / verify-fix: unusable input is 64 (it was 2, the same as an inconclusive verdict)", async () => {
    const add = await cli().run(["ledger", "add", join(dir, "missing.result.json"), "0123456789abcdef", "--dir", dir, "--json"]);
    expect(JSON.parse(add.out)).toMatchObject({ ok: false });
    expect(add.code).toBe(64);
    const vf = await cli().run(["verify-fix", "--json"]);
    expect(JSON.parse(vf.out)).toMatchObject({ ok: false, error: { code: "E_VERIFY_FIX_ARGS" } });
    expect(vf.code).toBe(64);
  });
});

describe("human output: never raw JSON without --json (#210)", () => {
  it("an explore usage error is one `error <CODE>: …` line on stderr with a --help hint; stdout stays empty", async () => {
    const r = await cli().run(["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--secret", "env:JEV_210_UNSET"]);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^error E_EXPLORE_ARGS: .*JEV_210_UNSET/m);
    expect(r.err).toContain("next: jevitate explore --help");
    expect(r.code).toBe(64);
  });

  it("check errors print a human line, not the envelope", async () => {
    const r = await cli().run(["check", "--suite", join(dir, "missing.json"), "--out", dir]);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^error E_CHECK_SUITE: /);
  });

  it("ledger list / add: a summary with a next step", async () => {
    const list = await cli().run(["ledger", "list", "--dir", dir]);
    expect(list.out).toBe("0 ledger entries\nnext: jevitate ledger add <result.json> <fingerprint>\n");
    expect(list.code).toBe(0);
    const listJson = await cli().run(["ledger", "list", "--dir", dir, "--json"]);
    expect(JSON.parse(listJson.out)).toEqual({ v: 1, ok: true, data: { entries: [] } });
    const add = await cli().run(["ledger", "add", join(dir, "missing.result.json"), "0123456789abcdef", "--dir", dir]);
    expect(add.out).toBe("");
    expect(add.err).toMatch(/^error E_LEDGER_INPUT: /);
  });

  it("init: keys already configured read as ready, never `keys: {json}` / `collected: []`", async () => {
    const home = join(dir, "home");
    const r = await cli({
      ai: { env: { OPENROUTER_API_KEY: "x", TYPESAFE_API_KEY: "y" } },
      init: { detection: { existsSync: () => false, homedir: () => home, cwd: () => dir }, statePath: join(dir, "state.json") },
    }).run(["init", "--skip-skills", "--skip-mcp", "--skip-project"]);
    expect(r.out).toContain("keys: generation ready — 1/1 configured (already configured)");
    expect(r.out).toContain("keys: judgment ready — 1/1 configured (already configured)");
    expect(r.out).not.toContain("{");
    expect(r.out).not.toContain("collected: []");
    expect(r.out).not.toContain('"x"');
    expect(r.code).toBe(0);
  });

  it("a mission result's summary: verdict, defects by fingerprint, result file and next step", () => {
    const text = formatMissionHuman({
      strategy: "adversarial",
      missionOutcome: "defects-found",
      exitCode: 1,
      target: { seedUrl: "http://app.test/profile", allowlist: [] },
      defects: [{ fingerprint: "0123456789abcdef", kind: "http-5xx", title: "PUT /api/profile returned 500" }],
      hangs: [],
      resultPath: "/runs/adversarial-1.result.json",
    });
    expect(text).toBe(
      [
        "DEFECTS-FOUND: adversarial http://app.test/profile · 1 defect(s) · 0 hang(s)",
        "DEFECT  0123456789abcdef  http-5xx  PUT /api/profile returned 500",
        "RESULT  /runs/adversarial-1.result.json",
        "next: jevitate verify-fix 0123456789abcdef --result /runs/adversarial-1.result.json (after a fix) · jevitate ledger add /runs/adversarial-1.result.json 0123456789abcdef · jevitate report",
        "",
      ].join("\n"),
    );
  });

  // #227 item 1: `regression capture` / `regression run` (the README demo path) used to print the
  // raw JSON envelope without --json.
  it("regression capture: a human summary (captured, or too flaky to commit) — never the raw envelope", () => {
    const captured = formatRegressionCaptureHuman({ recordingPath: "/regressions/r1.recording.json", metaPath: "/regressions/r1.meta.json" });
    expect(captured).toBe(["CAPTURED: /regressions/r1.recording.json", "META    /regressions/r1.meta.json", "next: jevitate regression run r1", ""].join("\n"));
    expect(captured).not.toMatch(/^\{/);

    const flaky = formatRegressionCaptureHuman({ skipped: "flaky", rate: 0.4 });
    expect(flaky).toContain("FLAKY: the failure did not reproduce reliably enough to commit (reproduced 40% of attempts)");
    expect(flaky).not.toMatch(/^\{/);
  });

  it("regression run: a human summary (verdict, reason, next step) — never the raw envelope", () => {
    const fixed = formatRegressionRunHuman({ id: "r1", verdict: "fixed", reason: "the assertion holds" });
    expect(fixed).toBe(["FIXED: r1", "REASON  the assertion holds", "next: jevitate report", ""].join("\n"));
    const reproduces = formatRegressionRunHuman({ id: "r1", verdict: "reproduces", reason: "the assertion still fails" });
    expect(reproduces).toContain("next: fix it, then jevitate regression run r1");
    expect(reproduces).not.toMatch(/^\{/);
  });

  // #227 item 2: `journey list` / `source list` printed nothing at all on an empty/missing dir.
  it("journey list / source list: a next-step line, never silence, on an empty dir", async () => {
    const journeys = await cli({ journeysDir: join(dir, "journeys") }).run(["journey", "list"]);
    expect(journeys.out).toBe("no journeys yet — record one with `jevitate record` (see jevitate record --help)\n");
    expect(journeys.code).toBe(0);

    const sources = await cli({
      sources: {
        sourcesDir: join(dir, "sources"),
        lockPath: join(dir, "jevitate.lock"),
        trustDir: join(dir, "trust"),
        ackDir: join(dir, "ack"),
        git: async () => {
          throw new Error("git not needed for source list");
        },
      },
    }).run(["source", "list"]);
    expect(sources.out).toBe("no sources yet — add one with `jevitate source add <name> <gitUrl>`\n");
    expect(sources.code).toBe(0);
  });

  // #227 item 3: a commander parse-time error (bad number, unknown option/command) printed
  // commander's own `error: option …` with no `<CODE>` — the code appeared only under --json.
  it("a commander parse-time error prints the same `error <CODE>: …` shape as every other refusal", async () => {
    const badNumber = await cli().run(["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--max-actions", "abc"]);
    expect(badNumber.err).toMatch(/^error E_EXPLORE_ARGS: .*--max-actions/m);
    expect(badNumber.err).toContain("next: jevitate explore --help");
    expect(badNumber.code).toBe(64);

    const unknownOption = await cli().run(["explore", "--no-such-flag"]);
    expect(unknownOption.err).toMatch(/^error E_EXPLORE_ARGS: /m);
    expect(unknownOption.code).toBe(64);

    const unknownCommand = await cli().run(["frobnicate"]);
    expect(unknownCommand.err).toMatch(/^error E_CLI_ARGS: /m);
    expect(unknownCommand.code).toBe(64);
  });

  // #227 item 5: `ledger verify` with nothing to verify used to print `FIXED: 0 entries` at exit 0.
  it("ledger verify with no matching entries: says nothing was verified, exit 2 (never a false FIXED/0)", async () => {
    const r = await cli().run(["ledger", "verify", "--dir", dir]);
    expect(r.out).toBe("NOTHING VERIFIED: the ledger has no matching entries\nnext: jevitate ledger add <result.json> <fingerprint>\n");
    expect(r.out).not.toContain("FIXED");
    expect(r.code).toBe(2);
    const json = await cli().run(["ledger", "verify", "--dir", dir, "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, data: { entries: [], exitCode: 2 } });
    expect(json.code).toBe(2);
  });
});

describe("#217 — a goal result's human summary", () => {
  it("a succeeded goal heads with the canonical CLEAN verdict, then its own ending and stop", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "clean",
      goalOutcome: "succeeded",
      outcome: "succeeded",
      stop: "done",
      exitCode: 0,
      target: { seedUrl: "http://app.test/cart", allowlist: [] },
      defects: [],
      hangs: [],
      resultPath: "/runs/explore-1.result.json",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("CLEAN: goal http://app.test/cart · 0 defect(s) · 0 hang(s)");
    expect(lines[1]).toMatch(/^GOAL\s+succeeded \(stop: done\)$/);
  });

  it("a real defect (an independent oracle, not the goal's own check) still heads DEFECTS-FOUND with the real count", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "defects-found",
      goalOutcome: "defects-found",
      outcome: "defects-found",
      stop: "done",
      exitCode: 1,
      target: { seedUrl: "http://app.test/cart", allowlist: [] },
      defects: [{ fingerprint: "0123456789abcdef", kind: "http-5xx", title: "PUT /api/profile returned 500" }],
      hangs: [],
      resultPath: "/runs/explore-1.result.json",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("DEFECTS-FOUND: goal http://app.test/cart · 1 defect(s) · 0 hang(s)");
  });
});

describe("#227 — a failed/exhausted/blocked goal never leads with '0 defect(s)'", () => {
  it("failed: heads FAILED with the goal's own verdict and why, not 'DEFECTS-FOUND … 0 defect(s)'", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "defects-found",
      goalOutcome: "failed",
      outcome: "failed",
      stop: "done",
      exitCode: 1,
      target: { seedUrl: "http://app.test/cart", allowlist: [] },
      defects: [],
      hangs: [],
      failure: { kind: "success-check-failed", message: "the model said done, but success check 'urlIncludes:/done' did not hold" },
      resultPath: "/runs/explore-1.result.json",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("FAILED: goal http://app.test/cart (the model said done, but success check 'urlIncludes:/done' did not hold)");
    expect(lines[0]).not.toContain("0 defect(s)");
    expect(lines[0]).not.toContain("DEFECTS-FOUND");
    expect(lines[1]).toMatch(/^GOAL\s+failed \(stop: done\)$/);
    // #217: missionOutcome/goalOutcome stay the canonical fold — this is a human-output-only change.
    expect(text).not.toContain("OUTCOME");
  });

  it("exhausted: heads EXHAUSTED, not DEFECTS-FOUND", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "defects-found",
      goalOutcome: "exhausted",
      outcome: "exhausted",
      stop: "exhausted",
      exitCode: 1,
      target: { seedUrl: "http://app.test/cart", allowlist: [] },
      defects: [],
      hangs: [],
      resultPath: "/runs/explore-1.result.json",
    });
    expect(text.split("\n")[0]).toBe("EXHAUSTED: goal http://app.test/cart");
  });

  it("blocked: heads BLOCKED, not DEFECTS-FOUND", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "defects-found",
      goalOutcome: "blocked",
      outcome: "blocked",
      stop: "blocked",
      exitCode: 1,
      target: { seedUrl: "http://app.test/cart", allowlist: [] },
      defects: [],
      hangs: [],
      resultPath: "/runs/explore-1.result.json",
    });
    expect(text.split("\n")[0]).toBe("BLOCKED: goal http://app.test/cart");
  });
});

/** Every strategy follows the same rule, against a real browser and the example site. */
describe("explore output shape is the same for every strategy (#210)", () => {
  let site: { url: string; close(): Promise<void> };
  beforeAll(async () => {
    site = await startServer();
  });
  afterAll(async () => {
    await site.close();
  });

  const strategies: ReadonlyArray<[string, string, string[]]> = [
    ["goal", "/login", ["--goal", "look around", "--success", "urlIncludes:/login"]],
    ["coverage", "/login", ["--strategy", "coverage"]],
    ["adversarial", "/adversarial/boom", ["--strategy", "adversarial"]],
    ["feature", "/feature-mission/chrome-only", ["--feature", "buy a pack", "--route", "/feature-mission/chrome-only"]],
  ];

  for (const [name, path, flags] of strategies) {
    it(
      `${name}: --json prints exactly the envelope; without it, a human summary (no JSON)`,
      async () => {
        const base = ["explore", "--url", `${site.url}${path}`, ...flags, "--fake-ai", "--max-actions", "2", "--max-decisions", "2"];
        // Real browser (no port factory), the fake-AI gateways.
        const deps: Partial<CliDeps> = { explore: {} };
        const json = await cli(deps).run([...base, "--out", join(dir, "json"), "--json"]);
        const lines = json.out.trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        const envelope = JSON.parse(lines[0]!) as { v: number; ok: boolean; data: { exitCode: number } };
        expect(envelope).toMatchObject({ v: 1, ok: true });
        expect(json.code).toBe(envelope.data.exitCode);

        const human = await cli(deps).run([...base, "--out", join(dir, "human")]);
        expect(() => JSON.parse(human.out)).toThrow();
        expect(human.out).not.toMatch(/^\{/m);
        expect(human.out).toMatch(/^[A-Z-]+: /);
        expect(human.out).toMatch(/^RESULT {2}.*\.result\.json$/m);
        expect(human.out).toMatch(/^next: jevitate /m);
        expect(human.code).toBe(json.code);
      },
      120_000,
    );
  }
});
