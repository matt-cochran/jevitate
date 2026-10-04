import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import type { RunExplorationOptions, RunExplorationResult } from "./explore-goal.js";

/**
 * #369: every `explore-author-journey` take is `explore`'s goal run (`runExploration`) — the
 * run-shaping flags reach it, and a take that does not reach the goal comes back with its stop
 * reason, checks and the paths of everything it wrote. `runExploration` is replaced by a capture.
 */
const calls: RunExplorationOptions[] = [];
let nextOutcome: "succeeded" | "failed" = "succeeded";

const recording: Recording = {
  version: "1.0",
  site: "http://127.0.0.1:3000",
  pages: [
    {
      url: "/login",
      steps: [
        { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Password" } } } },
        { step: { kind: "fill", target: { label: "Password" }, value: { redacted: true, length: 9 }, expect: { kind: "visible", target: { label: "Password" } } } },
      ],
    },
  ],
};

vi.mock("./explore-goal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./explore-goal.js")>();
  return {
    ...real,
    runExploration: vi.fn(async (opts: RunExplorationOptions): Promise<RunExplorationResult> => {
      calls.push(opts);
      const failed = nextOutcome === "failed";
      const stem = join(opts.outDir ?? "/logs", `explore-${calls.length}`);
      return {
        goalOutcome: nextOutcome,
        outcome: nextOutcome,
        stop: failed ? "no-progress" : "done",
        runOutcome: failed ? { status: "incomplete", reason: "no progress after 3 actions" } : { status: "completed", verifiedBy: "success-condition" },
        ...(failed ? { reason: "no progress after 3 actions; the success check did not hold: textIncludes:testId=status|Welcome (saw \"Wrong password\")" } : {}),
        checks: [{ check: "textIncludes:testId=status|Welcome", passed: !failed, detail: failed ? 'saw "Wrong password"' : "held" }],
        decisions: 4,
        actions: 3,
        finalUrl: "http://127.0.0.1:3000/login",
        recording,
        recordingPaths: [`${stem}.json`],
        transcriptPath: `${stem}.transcript.json`,
        resultPath: `${stem}.result.json`,
      } as unknown as RunExplorationResult;
    }),
  };
});

const { buildProgram } = await import("./program.js");

let dir: string;
let journeysDir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-author-goal-run-"));
  journeysDir = join(dir, "journeys");
  writeFileSync(join(dir, "upload.txt"), "upload me");
  writeFileSync(join(dir, "paste.txt"), "line one\nline two");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  calls.length = 0;
  nextOutcome = "succeeded";
  delete process.env.JEV_AUTHOR_PW;
  delete process.env.JEV_AUTHOR_SEED;
  process.exitCode = undefined;
});

async function cli(args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

const URL = "http://127.0.0.1:3000/login";
const BASE = ["explore-author-journey", "--url", URL, "--goal", "sign in", "--success", "textIncludes:testId=status|Welcome", "--id", "signin", "--name", "Sign in", "--fake-ai"];
const PW = "author-pw-canary-41c9";

describe("explore-author-journey runs explore's goal run (#369)", () => {
  it("every newly accepted run-shaping flag reaches the discovery run", async () => {
    process.env.JEV_AUTHOR_PW = PW;
    process.env.JEV_AUTHOR_SEED = "JBSWY3DPEHPK3PXP";
    const out = join(dir, "runs");
    const r = await cli([
      ...BASE,
      "--json",
      "--out", out,
      "--success-when", "held",
      "--allow-vacuous-checks",
      "--action-deltas",
      "--secret", "env:JEV_AUTHOR_PW",
      "--secret-field", "label=Password=env:JEV_AUTHOR_PW",
      "--secret-field", "label=Email code=cmd:echo 123456",
      "--allow-secret-cmd",
      "--secret-cmd-attempts", "2",
      "--totp", "label=Authentication code=env:JEV_AUTHOR_SEED",
      "--type-fixture", `label=Paste=${join(dir, "paste.txt")}`,
      "--fixture", join(dir, "upload.txt"),
      "--save-storage-state", join(dir, "session-out.json"),
      "--reply-wait-ms", "5000",
      "--reply-quiet-ms", "1500",
      "--reply-ceiling-ms", "9000",
      "--reply-max-chars", "120",
      "--job-wait-ms", "7000",
      "--deny", "Archive",
      "--paid", "/^Analyze/i",
      "--allow-destructive",
      "--dialogs", "accept",
      "--read-rpc", "Estimate*",
      "--hang-replays", "0",
      "--settle-ignore", "*/poll*",
      "--long-poll-ms", "4000",
      "--api-prefix", "/api/",
      "--ignore-no-progress", "/busy*",
      "--viewport", "375x812",
      "--geolocation", "41.6,-70.9",
      "--screenshots", "steps",
    ]);
    expect(r.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
    const o = calls[0]!;
    expect(o).toMatchObject({
      url: URL,
      goal: "sign in",
      outDir: out,
      successWhen: "held",
      allowVacuousChecks: true,
      actionDeltas: true,
      secrets: [PW],
      secretCommandAttempts: 2,
      fixture: join(dir, "upload.txt"),
      saveStorageState: join(dir, "session-out.json"),
      conversation: { replyWaitMs: 5000, replyQuietMs: 1500, replyCeilingMs: 9000, replyMaxChars: 120, jobWaitMs: 7000 },
      hangReplays: 0,
      emulation: { viewport: { width: 375, height: 812 }, geolocation: { latitude: 41.6, longitude: -70.9 } },
      screenshots: { mode: "steps" },
    });
    expect(o.successChecks).toEqual([{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Welcome" } }]);
    expect(o.secretFields?.map((f) => [f.descriptor, f.kind])).toEqual([
      ["label=Password", "value"],
      ["label=Email code", "cmd"],
      ["label=Authentication code", "totp"],
    ]);
    expect(typeof o.secretCommand).toBe("function");
    expect(o.typeFixtures?.map((f) => f.text)).toEqual(["line one\nline two"]);
    expect(o.target?.safety).toMatchObject({ deny: ["Archive"], paid: ["/^Analyze/i"], readRequests: ["Estimate*"], allowDestructive: true, dialogs: "accept" });
    expect(o.target?.settle).toMatchObject({ ignoreRequests: ["*/poll*"], longPollMs: 4000 });
    expect(o.target?.hangs).toMatchObject({ ignoreNoProgress: ["/busy*"] });
    expect(o.target?.timing).toMatchObject({ apiPrefixes: ["/api/"] });
    // No bound value ever reaches the output.
    expect(r.out).not.toContain(PW);
  });

  it("a code-typed --secret-field becomes a secret parameter of the authored Journey; the take's paths come back", async () => {
    process.env.JEV_AUTHOR_PW = PW;
    const r = await cli([...BASE, "--json", "--secret-field", "label=Password=env:JEV_AUTHOR_PW"]);
    expect(r.exitCode ?? 0).toBe(0);
    const env = JSON.parse(r.out) as { ok: boolean; data: { outcome: string; journey: { metadata: { params: string[]; parameters: unknown[] } }; discovery: Record<string, unknown>; takes: unknown } };
    expect(env.data.outcome).toBe("authored");
    expect(env.data.journey.metadata.params).toEqual(["secret1"]);
    expect(env.data.journey.metadata.parameters).toEqual([expect.objectContaining({ name: "secret1", secret: true })]);
    expect(env.data.discovery).toMatchObject({ outcome: "succeeded", resultPath: expect.stringMatching(/result\.json$/) });
    expect(env.data.takes).toEqual({ requested: 1, run: 1, succeeded: 1 });
    expect(r.out).not.toContain(PW);
  });

  it("a take that does not reach the goal: not-reached with its concrete reason, stop, checks and paths (JSON and human)", async () => {
    nextOutcome = "failed";
    const out = join(dir, "failed-runs");
    const json = await cli([...BASE, "--json", "--out", out, "--takes", "3"]);
    expect(json.exitCode).toBe(1);
    expect(calls).toHaveLength(1); // no corroborating take after a failed discovery
    const env = JSON.parse(json.out) as { ok: boolean; data: Record<string, unknown> };
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      outcome: "not-reached",
      reason: expect.stringContaining('discovery mission failed: no progress after 3 actions; the success check did not hold: textIncludes:testId=status|Welcome (saw "Wrong password")'),
      takes: { requested: 3, run: 1, succeeded: 0 },
      discovery: {
        outcome: "failed",
        stop: "no-progress",
        runOutcome: { status: "incomplete", reason: "no progress after 3 actions" },
        checks: [expect.objectContaining({ passed: false })],
        resultPath: join(out, "explore-1.result.json"),
        transcriptPath: join(out, "explore-1.transcript.json"),
        recordingPaths: [join(out, "explore-1.json")],
      },
    });

    calls.length = 0;
    const human = await cli([...BASE, "--out", out, "--screenshots"]);
    expect(human.exitCode).toBe(1);
    expect(human.out).toContain("NOT REACHED: discovery mission failed: no progress after 3 actions");
    expect(human.out).toContain("discovery: failed (stop: no-progress)");
    expect(human.out).toContain("check FAILED: textIncludes:testId=status|Welcome");
    expect(human.out).toContain(`result: ${join(out, "explore-1.result.json")}`);
    expect(human.out).toContain(`transcript: ${join(out, "explore-1.transcript.json")}`);
    expect(human.out).toContain(`recording: ${join(out, "explore-1.json")}`);
    expect(human.out).toContain(`screenshots: ${join(out, "explore-1.screenshots")}`);
  });

  it("--takes N runs N goal runs", async () => {
    const r = await cli([...BASE, "--json", "--takes", "2"]);
    expect(r.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(2);
    expect((JSON.parse(r.out) as { data: { takes: unknown } }).data.takes).toEqual({ requested: 2, run: 2, succeeded: 2 });
  });

  it("refuses unusable goal-run flags before any run (exit 64)", async () => {
    process.env.JEV_AUTHOR_PW = PW;
    for (const bad of [
      ["--secret-field", "label=Code=cmd:echo 1"], // cmd: without --allow-secret-cmd
      ["--secret-field", "label=Password=env:JEV_AUTHOR_UNSET"],
      ["--dialogs", "maybe"],
      ["--success-when", "sometimes"],
      ["--viewport", "375x812", "--device", "iPhone 13"],
      ["--type-fixture", `label=Paste=${join(dir, "missing.txt")}`],
    ]) {
      const r = await cli([...BASE, "--json", ...bad]);
      const env = JSON.parse(r.out) as { ok: boolean; error?: { code: string } };
      expect(env, bad.join(" ")).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a reloadThen check before any run, naming the inner check to author instead", async () => {
    const r = await cli([...BASE.slice(0, 5), "--success", "reloadThen:valueEquals:[data-testid=last-name]|Litmus", ...BASE.slice(7), "--json"]);
    const env = JSON.parse(r.out) as { ok: boolean; error: { code: string; message: string } };
    expect(env).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ASSERTION" } });
    expect(env.error.message).toContain("a reloadThen check can't be authored into a Journey");
    expect(env.error.message).toContain("nothing was run");
    expect(env.error.message).toContain('--success "valueEquals:[data-testid=last-name]|Litmus"');
    expect(calls).toHaveLength(0);
  });
});
