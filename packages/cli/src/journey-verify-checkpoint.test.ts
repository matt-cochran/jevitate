import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, ParamValidationError, assertionSiteKey, journeyAssertions, judgeAssertions, mutationProofVerdict, planJourneyMutations, type Journey, type JourneyAssertionSite, type MutationPlan, type ReplayPace } from "@jevitate/journey";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { JourneyVerifyStalledError, planJourneyVerification, verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";
import {
  CHECKPOINT_MAX_AGE_MS,
  JourneyVerifyResumeRefusedError,
  REFUSAL_NOT_KEPT,
  browserBindingOf,
  canonicalJson,
  checkpointReplayOf,
  hookBindingOf,
  openProofCheckpoint,
  checkpointPairOf,
  readVerifyProgress,
  resumeRefusalAgainstBase,
  REPLAY_RECORD_KINDS,
  reusedProofFields,
  verifierStateOf,
  verifyCheckpointPath,
  type CheckpointBody,
  type OpenedCheckpoint,
  type ProofCheckpointRequest,
  type ResumeRefusalReason,
  type ResumeState,
} from "./journey-verify-checkpoint.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CLI_TOOL_SPECS, runCliTool } from "./mcp-cli-tools.js";
import { __resetTerminalResultForTests } from "./terminal-result.js";
import { verifyRecordPath } from "./journey-review-store.js";

/**
 * #787: durable progress and fail-closed resume of a mutation proof, through the `run` seam on a fake
 * clock with real files. The processes themselves (observer loss, SIGKILL) are in
 * journey-verify-resume.e2e.test.ts.
 */

const ID = "save-text";
const SECRET_PARAM = "1234";
const HOOK_TEXT = "restore --password hook-secret-text";
const APP_TEXT = "page-said-private-customer-text";
const READ_SAVE = "/api/save";
const BUILD = { version: "1.2.3", commit: "abc", builtAt: "2026-11-01T00:00:00.000Z", tree: "def" };

type Run = NonNullable<JourneyVerifySeams["run"]>;
type RunResult = Awaited<ReturnType<Run>>;
const passed = { outcome: "ok", output: {} } as RunResult;
const requestBroken = { outcome: "quarantined", reason: `step 3 request check failed: ${APP_TEXT}`, outcomeFailures: [{ where: "step-request", step: 3, checkIndex: 0 }], blockedWrites: [{ method: "POST", path: `/api/save?who=${APP_TEXT}` }] } as unknown as RunResult;
const stepBroken = { outcome: "quarantined", reason: `step 2 postcondition failed: ${APP_TEXT}`, at: 1 } as RunResult;

function journeyOf(name = "Save text"): Journey {
  return {
    metadata: { id: ID, name, promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00.000Z" },
    recording: {
      version: "1",
      site: "http://127.0.0.1:9",
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
            { step: { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: { kind: "valueEquals", target: { label: "Text" }, value: "hello" } } },
            {
              step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "count", target: { testId: "status" }, min: 0 } },
              delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

/** The same Journey taking a parameter it reads and asserts nothing about, so the plan stays as it was. */
async function storeJourneyWithParam(): Promise<void> {
  const journey = journeyOf();
  journey.metadata.params = ["code"];
  journey.recording.pages[0]!.steps.push({ step: { kind: "fill", target: { label: "Code" }, value: { var: "code" }, expect: { kind: "count", target: { label: "Code" }, min: 0 } } } as never);
  await new FsJourneyStore(join(dir, "journeys")).put(journey);
}

/** The base replay reports each step's end, so the proof has a pace and runs its closing replay. */
const FAKE_ACTOR = { ability: () => ({ session: { page: {} } }) };
async function reportSteps(options: { observer?: { beforeStep?: (s: never) => Promise<void>; afterStep?: (s: never) => Promise<void> } }): Promise<void> {
  for (const index of [0, 1, 2]) {
    await options.observer?.beforeStep?.({ index, actor: FAKE_ACTOR } as never);
    await options.observer?.afterStep?.({ index, actor: FAKE_ACTOR, outcome: "done" } as never);
  }
}

const stall = (): JourneyVerifyStalledError => new JourneyVerifyStalledError({ replay: 0 }, 1, true);

/**
 * Replay `n` as `script` says. Replay 1 is the base and reports its steps. An `Error` is thrown; a stall ends the proof as a kill
 * would. The independence replay right after a base with steps is not numbered: it passes unless `independence` says otherwise.
 */
function scripted(script: (n: number, mutation: Record<string, unknown>) => RunResult | Error, independence: RunResult | Error = passed): { run: Run; calls: () => number; independenceRuns: () => number } {
  let n = 0;
  let raw = 0;
  let independenceRuns = 0;
  const run = (async (options: never, mutation: Record<string, unknown>) => {
    raw += 1;
    // An error before a browser opened is retried once.
    if (raw === 2 || (raw === 3 && independence instanceof Error)) {
      independenceRuns += 1;
      if (independence instanceof Error) throw independence;
      return independence;
    }
    n += 1;
    const step = script(n, mutation);
    if (n === 1) await reportSteps(options);
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as Run;
  return { run, calls: () => n, independenceRuns: () => independenceRuns };
}

/** The plan's mutations, each answering so the paired assertions are proven: skip, block, then the fill's stale value. */
const PROVING = [requestBroken, requestBroken, stepBroken];
function proofResult(n: number): RunResult {
  return n === 1 ? passed : (PROVING[n - 2] ?? passed);
}

let dir: string;
let path: string;
let keyFile: string;
let fake: FakeClock;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-verify-checkpoint-"));
  await new FsJourneyStore(join(dir, "journeys")).put(journeyOf());
  path = verifyCheckpointPath(join(dir, ".jevitate"), join(dir, "journeys"), ID);
  keyFile = join(dir, "home", ".jevitate", "verify-checkpoint.key");
  fake = new FakeClock();
  installClock(fake);
  __resetTerminalResultForTests();
});

afterEach(() => {
  resetClock();
  __resetTerminalResultForTests();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const CONFIG = { hook: { before: HOOK_TEXT }, origin: { baseUrl: "http://127.0.0.1:9" }, browser: { browser: undefined } };

function request(resume: boolean, over: Partial<ProofCheckpointRequest> = {}): ProofCheckpointRequest {
  return { path, keyFile, resume, build: BUILD, config: CONFIG, ...over };
}

type ProveExtra = Partial<Parameters<typeof verifyJourneyMutations>[0]>;
const prove = (run: Run, checkpoint: ProofCheckpointRequest | undefined, extra: ProveExtra = {}): Promise<JourneyVerifyReport> =>
  verifyJourneyMutations({ dir: join(dir, "journeys"), id: ID, params: {}, ...(checkpoint === undefined ? {} : { checkpoint }), ...extra }, run);

/** Runs a proof that dies as replay `stopAt` starts, leaving the checkpoint as a kill would. */
async function interruptAt(stopAt: number, results: (n: number) => RunResult | Error = proofResult, extra: ProveExtra = {}): Promise<void> {
  const { run } = scripted((n) => (n === stopAt ? stall() : results(n)));
  await expect(prove(run, request(false), extra)).rejects.toBeInstanceOf(JourneyVerifyStalledError);
}

const readBody = (): CheckpointBody => (JSON.parse(readFileSync(path, "utf8")) as { body: CheckpointBody }).body;

/** Signs a body with the real key: what only someone who can read `~/.jevitate/` can do. */
function writeSigned(change: (body: CheckpointBody) => CheckpointBody): void {
  const key = Buffer.from(readFileSync(keyFile, "utf8"), "hex");
  const body = change(readBody());
  const mac = createHmac("sha256", key).update("jevitate-verify-checkpoint/1\0file\0").update(canonicalJson(body)).digest("hex");
  writeFileSync(path, JSON.stringify({ body, mac }));
}

async function refusal(promise: Promise<unknown>): Promise<ResumeRefusalReason> {
  const err = await promise.then(
    () => {
      throw new Error("the resume was not refused");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(JourneyVerifyResumeRefusedError);
  return (err as JourneyVerifyResumeRefusedError).reason;
}

/** A refusal's wording is not kept, so a reused one says that; that a refusal happened is what the verdict reads. */
const assertionsOf = (r: JourneyVerifyReport): unknown => r.assertions.map((a) => (a.targetedRefusal === undefined ? a : { ...a, targetedRefusal: "refused" }));

describe("the progress receipt", () => {
  it("moves with the proof: a fresh read sees each finished pair and the one in progress", async () => {
    const seen: { completed: number; currentPair: string | null; lastResultClass: unknown }[] = [];
    const { run } = scripted((n) => {
      const s = readVerifyProgress(path, keyFile, ID).progress!;
      seen.push({ completed: s.completed, currentPair: s.currentPair, lastResultClass: s.lastResultClass });
      return proofResult(n);
    });
    const report = await prove(run, request(false));
    expect(report.verdict).toBe("proven");
    expect(report.reusedPairs).toBe(0);
    expect(seen).toEqual([
      { completed: 0, currentPair: null, lastResultClass: null },
      { completed: 0, currentPair: "skip:3", lastResultClass: null },
      { completed: 1, currentPair: "block-write:3", lastResultClass: "failed" },
      { completed: 2, currentPair: "stale-value:2", lastResultClass: "failed" },
      { completed: 3, currentPair: null, lastResultClass: "failed" },
    ]);
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({
      receipt: "valid",
      verifier: "exited",
      resume: { possible: false, refusal: "finished" },
      progress: { state: "finished", verdict: "proven", completed: 3, total: 3, build: BUILD, verifierPid: process.pid },
    });
  });

  it("holds what the issue names", async () => {
    await interruptAt(3);
    const body = readBody();
    expect(body).toMatchObject({ journeyId: ID, total: 3, currentPair: "block-write:3", state: "interrupted", build: BUILD, verifier: { pid: process.pid } });
    expect(body.journeyHash.length).toBeGreaterThan(0);
    expect(body.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.completed.map((p) => [p.id, p.outcome])).toEqual([["skip:3", "failed"]]);
    expect(body.startedAt).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
    expect(body.verifier.startToken).not.toBe("");
  });

  it("holds no hook text, parameter value or anything the app said, in any form a reader could use", async () => {
    await storeJourneyWithParam();
    await interruptAt(4, proofResult, { params: { code: SECRET_PARAM } });
    const raw = readFileSync(path, "utf8");
    for (const leak of [SECRET_PARAM, HOOK_TEXT, "hook-secret-text", APP_TEXT, "/api/save", createHash("sha256").update(SECRET_PARAM).digest("hex"), createHash("sha256").update(canonicalJson({ code: SECRET_PARAM })).digest("hex")]) {
      expect(raw).not.toContain(leak);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("binds a low-entropy parameter by a key kept out of the project: no guess from the file alone", async () => {
    await storeJourneyWithParam();
    await interruptAt(3, proofResult, { params: { code: SECRET_PARAM } });
    const key = readFileSync(keyFile, "utf8");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(keyFile.startsWith(join(dir, "home"))).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain(key);
    expect(readBody().bindings.params).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never replaces a live verifier's checkpoint: a second fresh proof gets no session and says so", async () => {
    const notices: string[] = [];
    const journey = journeyOf();
    const plan = planJourneyMutations(journey, {});
    let sibling: Promise<OpenedCheckpoint> | undefined;
    const { run } = scripted((n) => {
      if (n === 2) sibling = openProofCheckpoint(request(false, { onNotice: (t) => void notices.push(t) }), { journey, journeyHash: "other", plan, params: {}, sites: journeyAssertions(journey) });
      return proofResult(n);
    });
    expect((await prove(run, request(false))).verdict).toBe("proven");
    expect((await sibling)?.session).toBeUndefined();
    expect(notices.join()).toContain("owns");
    expect(readBody().completed).toHaveLength(3);
  });

  it("is not replaced by a command the replay would refuse for its params", async () => {
    await interruptAt(3);
    const before = readFileSync(path, "utf8");
    // As the real replay does: the seam's replay does not check params itself.
    const refusing = scripted(() => new ParamValidationError("param mismatch"));
    await expect(prove(refusing.run, request(false), { params: { typo: "x" } })).rejects.toThrow("param mismatch");
    expect(refusing.calls()).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not end a proof when a write fails: it says so once and the verdict stands", async () => {
    const notices: string[] = [];
    const parent = join(dir, ".jevitate", "logs", "verify-progress");
    const { run } = scripted((n) => {
      if (n === 2) chmodSync(parent, 0o555);
      return proofResult(n);
    });
    const report = await prove(run, request(false, { onNotice: (t) => void notices.push(t) })).finally(() => chmodSync(parent, 0o755));
    expect(report.verdict).toBe("proven");
    expect(notices.filter((t) => t.includes("could not be saved"))).toHaveLength(1);
  });

  it("leaves nothing resumable when a taint cannot be written: the older file would read clean", async () => {
    const journey = journeyOf();
    const { session } = await openProofCheckpoint(request(false), { journey, journeyHash: "h", plan: planJourneyMutations(journey), params: {}, sites: journeyAssertions(journey) });
    // Any failed write will do, and a link at the path refuses one while it can still be removed, as a file on a full disk can.
    unlinkSync(path);
    symlinkSync(join(dir, "elsewhere"), path);
    session!.taint({ restoreFailed: true });
    expect(() => lstatSync(path)).toThrow();
    expect(readVerifyProgress(path, keyFile, ID).resume).toEqual({ possible: false, refusal: "no-checkpoint" });
    // Each write holds the whole body, so the next one that lands still carries it.
    session!.startPair("skip:3");
    expect(readBody().taint.restoreFailed).toBe(true);
  });

  it("says when starting again replaces finished work", async () => {
    await interruptAt(3);
    const notices: string[] = [];
    await prove(scripted(proofResult).run, request(false, { onNotice: (t) => void notices.push(t) }));
    expect(notices.join()).toContain("replaces a checkpoint with 1 finished pairs");
  });
});

describe("resume", () => {
  it("runs the base, the unfinished pairs and the closing replay, and no finished pair", async () => {
    await interruptAt(3);
    const asked: unknown[] = [];
    const resumed = scripted((n, mutation) => {
      asked.push(n);
      void mutation;
      return n === 1 ? passed : n === 2 ? requestBroken : n === 3 ? stepBroken : passed;
    });
    const report = await prove(resumed.run, request(true));
    expect(report.verdict).toBe("proven");
    expect(report.reusedPairs).toBe(1);
    // Base, block-write:3 (the interrupted pair, run again), stale-value:2, closing.
    expect(resumed.calls()).toBe(4);
    expect(report.mutations.map((m) => [m.id, m.reused])).toEqual([
      ["skip:3", true],
      ["block-write:3", undefined],
      ["stale-value:2", undefined],
    ]);
    expect(JSON.parse(readFileSync(verifyRecordPath(join(dir, "journeys"), ID), "utf8"))).toMatchObject({ verdict: "proven", reusedPairs: 1 });
  });

  it("runs the closing replay even with every pair reused, and its failure leaves no proof", async () => {
    await interruptAt(5);
    expect(readBody().completed).toHaveLength(3);
    const failing = scripted((n) => (n === 1 ? passed : stepBroken));
    const report = await prove(failing.run, request(true));
    expect(failing.calls()).toBe(2);
    expect(report.reusedPairs).toBe(3);
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("no longer passes");
  });

  it("requires the base to pass before anything is reused, and keeps the checkpoint for another try", async () => {
    await interruptAt(3);
    const down = scripted((n) => (n === 1 ? stepBroken : passed));
    expect(await refusal(prove(down.run, request(true)))).toBe("base-failed");
    expect(down.calls()).toBe(1);
    expect(existsSync(verifyRecordPath(join(dir, "journeys"), ID))).toBe(false);
    expect(readBody().completed).toHaveLength(1);
    const again = scripted((n) => (n === 1 ? passed : n === 2 ? requestBroken : n === 3 ? stepBroken : passed));
    expect((await prove(again.run, request(true))).verdict).toBe("proven");
  });

  it("can follow a resume with another resume, keeping the pairs of both", async () => {
    await interruptAt(3);
    const second = scripted((n) => (n === 1 ? passed : n === 2 ? requestBroken : stall()));
    await expect(prove(second.run, request(true))).rejects.toBeInstanceOf(JourneyVerifyStalledError);
    expect(readBody().completed.map((p) => p.id)).toEqual(["skip:3", "block-write:3"]);
    const third = scripted((n) => (n === 1 ? passed : n === 2 ? stepBroken : passed));
    const report = await prove(third.run, request(true));
    expect(report).toMatchObject({ verdict: "proven", reusedPairs: 2 });
  });

  it("is free to resume after a proof ended in a process that goes on (an MCP server)", async () => {
    await interruptAt(3);
    expect(readBody().verifier.pid).toBe(process.pid);
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ verifier: "exited", resume: { possible: true } });
  });
});

describe("a resumed proof and an uninterrupted one", () => {
  /** Each replay answered by what it is, however many came before it: the same result whenever it runs. A stall at `stopAt` is the kill. */
  function byPair(answers: Readonly<Record<string, RunResult | Error>>, stopAt?: string): { run: Run; onProgress: NonNullable<ProveExtra["onProgress"]> } {
    let current: string | undefined;
    const run = (async (options: never) => {
      if (current === undefined) {
        await reportSteps(options);
        return passed;
      }
      if (current === stopAt) throw stall();
      const answer = answers[current] ?? passed;
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as Run;
    return { run, onProgress: (p) => void (current = p.mutation?.replace(" (retry after error)", "")) };
  }
  const STOPS = ["skip:3", "block-write:3", "stale-value:2", "closing replay, as recorded"];
  const proving = { "skip:3": requestBroken, "block-write:3": requestBroken, "stale-value:2": stepBroken };
  const unevaluable = { outcome: "quarantined", reason: APP_TEXT, outcomeFailures: [{ where: "unevaluable" }] } as unknown as RunResult;
  const scripts: Record<string, Readonly<Record<string, RunResult | Error>>> = {
    proven: proving,
    "a mutation that still passed": { ...proving, "block-write:3": passed, "stale-value:2": passed },
    "a replay that errored": { ...proving, "block-write:3": new Error(`boom ${APP_TEXT}`) },
    "cascades only": { "skip:3": unevaluable, "block-write:3": unevaluable, "stale-value:2": unevaluable },
  };
  for (const [name, answers] of Object.entries(scripts)) {
    it(`reach the same verdict from the same results: ${name}`, async () => {
      const once = byPair(answers);
      const whole = await prove(once.run, undefined, { onProgress: once.onProgress });
      const reusedAt: number[] = [];
      for (const stopAt of STOPS) {
        rmSync(verifyRecordPath(join(dir, "journeys"), ID), { force: true });
        rmSync(path, { force: true });
        const killed = byPair(answers, stopAt);
        const ended = await prove(killed.run, request(false), { onProgress: killed.onProgress }).then(
          () => undefined,
          (e: unknown) => e,
        );
        // A proof already inconclusive has no closing replay to be killed in, and so finished.
        if (ended === undefined) continue;
        expect(ended).toBeInstanceOf(JourneyVerifyStalledError);
        // An errored pair is on file and is run again, so it is not reused.
        const finished = readBody().completed.filter((p) => p.outcome !== "error").length;
        const rest = byPair(answers);
        const report = await prove(rest.run, request(true), { onProgress: rest.onProgress });
        expect({ stopAt, verdict: report.verdict, assertions: assertionsOf(report), summary: report.summary }).toEqual({ stopAt, verdict: whole.verdict, assertions: assertionsOf(whole), summary: whole.summary });
        expect(report.reusedPairs).toBe(finished);
        reusedAt.push(finished);
      }
      expect(reusedAt.length).toBeGreaterThanOrEqual(3);
      expect(reusedAt[0]).toBe(0);
    });
  }

  /**
   * The same, with every replay reporting its steps, so pacing, shared controls and re-runs happen. Held replays sleep
   * on the fake clock, which this moves along.
   */
  const realTimer = setTimeout;
  async function driven<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const ended = work.finally(() => void (done = true));
    ended.catch(() => undefined);
    while (!done) {
      fake.runUntilIdle();
      await new Promise((resolve) => realTimer(resolve, 1));
    }
    return ended;
  }
  function timedByLabel(answers: Readonly<Record<string, RunResult>>, stopAt?: string): { run: Run; onProgress: NonNullable<ProveExtra["onProgress"]>; labels: string[] } {
    const labels: string[] = [];
    const run = (async (options: never) => {
      const current = labels.at(-1)!;
      if (current === stopAt) throw stall();
      await reportSteps(options);
      return answers[current] ?? passed;
    }) as unknown as Run;
    return { run, labels, onProgress: (p) => void labels.push(p.mutation ?? "base") };
  }
  const timedScripts: Record<string, Readonly<Record<string, RunResult>>> = {
    "siblings sharing a control": { "skip:3": requestBroken, "block-write:3": requestBroken, "stale-value:2": stepBroken },
    "a sibling's pass the failure does not reproduce against": { "skip:3": requestBroken, "stale-value:2": stepBroken },
  };
  for (const [name, answers] of Object.entries(timedScripts)) {
    it(`reach the same verdict with the experiment's replays: ${name}`, async () => {
      const once = timedByLabel(answers);
      const whole = await driven(prove(once.run, undefined, { onProgress: once.onProgress }));
      // Shared: the independence replay ran on these floors, so it is this step's control too.
      expect(whole.mutations.find((m) => m.id === "skip:3")?.control).toBe("passed");
      expect(once.labels.filter((l) => l === "independence replay, as recorded")).toHaveLength(1);
      rmSync(verifyRecordPath(join(dir, "journeys"), ID), { force: true });
      const killed = timedByLabel(answers, "stale-value:2");
      await expect(driven(prove(killed.run, request(false), { onProgress: killed.onProgress }))).rejects.toBeInstanceOf(JourneyVerifyStalledError);
      expect(readBody().completed.map((p) => p.id)).toEqual(["skip:3", "block-write:3"]);
      const rest = timedByLabel(answers);
      const report = await driven(prove(rest.run, request(true), { onProgress: rest.onProgress }));
      expect({ verdict: report.verdict, assertions: assertionsOf(report), summary: report.summary }).toEqual({ verdict: whole.verdict, assertions: assertionsOf(whole), summary: whole.summary });
      expect(report.reusedPairs).toBe(2);
      // Never reused: a resume answers for the base it just measured.
      expect(rest.labels.filter((l) => l === "independence replay, as recorded")).toHaveLength(1);
    });
  }

  it("keep a replay at the base's time, and what it read, through the file", () => {
    const original = { kind: "skip" as const, step: 3, id: "skip:3", outcome: "failed" as const, failedSites: [{ where: "end-state", index: 0 } as const], waitsCut: ["end-state:0"], control: "failed" as const, atBaseTime: { outcome: "passed" as const, failedSites: [] }, relaxed: { outcome: "failed" as const, failedSites: [], atBaseTime: { outcome: "failed" as const, failedSites: [] } } };
    expect(reusedProofFields(checkpointPairOf(original, []))).toMatchObject({ atBaseTime: { outcome: "passed" }, relaxed: { atBaseTime: { outcome: "failed" } } });
  });

  it("keep the one refusal a suggestion reads, by class, and no other wording", () => {
    const pair = { kind: "skip" as const, step: 3, id: "skip:3", outcome: "failed" as const, failedSites: [] };
    const proof = (refused: string): typeof pair & { targeted: [{ site: string; relaxedSites: string[]; outcome: "failed"; failedSites: []; refused: string }] } => ({ ...pair, targeted: [{ site: "end-state:0", relaxedSites: [], outcome: "failed", failedSites: [], refused }] });
    const bound = "relaxation bound 4 reached";
    expect(checkpointPairOf(proof(bound), []).targeted?.[0]?.refused).toBe("relaxation-bound");
    expect(reusedProofFields(checkpointPairOf(proof(bound), [])).targeted?.[0]?.refused).toBe(bound);
    expect(checkpointPairOf(proof(`app said ${APP_TEXT}`), []).targeted?.[0]?.refused).toBe("other");
    expect(reusedProofFields(checkpointPairOf(proof(`app said ${APP_TEXT}`), [])).targeted?.[0]?.refused).toBe(REFUSAL_NOT_KEPT);
  });

  it("feed mutationProofVerdict the same input: a stored result reads as the original does", () => {
    const journey = journeyOf();
    const plan = planJourneyMutations(journey, {});
    const originals = plan.mutations.map((m) => ({
      kind: m.kind,
      step: m.step,
      id: m.id,
      outcome: "failed" as const,
      failedSites: [{ where: "step-request", step: 3, checkIndex: 0 } as const],
      reason: APP_TEXT,
      blockedWrites: [APP_TEXT],
      relaxed: undefined,
      waitsCut: ["step-request:3:0"],
      targeted: [{ site: "step-request:3:0", relaxedSites: ["step:2"], outcome: "failed" as const, failedSites: [], refused: `app said ${APP_TEXT}`, control: "failed" as const }],
    }));
    const judge = (ms: readonly { id: string; outcome: "failed"; failedSites: readonly never[] | readonly object[] }[]): unknown => {
      const results = new Map(ms.map((m) => [m.id, m as never]));
      const assertions = judgeAssertions(journey, plan, results);
      return { assertions: assertions.map(({ targetedRefusal: _wording, ...a }) => a), verdict: mutationProofVerdict({ basePassed: true, mutations: ms as never, assertions }).verdict };
    };
    const stored = originals.map((m) => reusedProofFields(checkpointPairOf(m, [])));
    const withIds = stored.map((s, i) => ({ ...s, id: originals[i]!.id })) as never;
    expect(judge(withIds)).toEqual(judge(originals as never));
    expect(JSON.stringify(stored)).not.toContain(APP_TEXT);
    expect(stored[0]?.targeted?.[0]?.refused).toBe(REFUSAL_NOT_KEPT);
  });
});

describe("the independence replay on a resume", () => {
  it("runs again, and is reused from nothing", async () => {
    await interruptAt(3);
    expect(readBody().independence).toBe("passed");
    const resumed = scripted((n) => (n === 1 ? passed : n === 2 ? requestBroken : n === 3 ? stepBroken : passed));
    await prove(resumed.run, request(true));
    expect(resumed.independenceRuns()).toBe(1);
  });

  it("leaves the proof inconclusive when it cannot run, whatever the reused pairs read", async () => {
    await interruptAt(3);
    const resumed = scripted((n) => (n === 1 ? passed : n === 2 ? requestBroken : n === 3 ? stepBroken : passed), new Error("no browser"));
    const report = await prove(resumed.run, request(true));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(/cannot say the replays are independent/);
  });
});

describe("a taint from before the interruption", () => {
  it("a failed fixture restore keeps the resumed proof inconclusive", async () => {
    const { run } = scripted((n, mutation) => {
      if (n !== 2) return proofResult(n);
      // Nothing runs after a failed restore, so the kill comes as it fails.
      (mutation["onFixtureRestoreFailed"] as () => void)();
      return stall();
    });
    await expect(prove(run, request(false))).rejects.toBeInstanceOf(JourneyVerifyStalledError);
    expect(readBody().taint.restoreFailed).toBe(true);
    const report = await prove(scripted(proofResultAfter(1)).run, request(true));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("fixture restore failed");
  });

  it("a replay that closed with a write open keeps the resumed proof inconclusive", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, taint: { ...b.taint, notIsolatedBy: "skip:3" } }));
    const report = await prove(scripted(proofResultAfter(1)).run, request(true));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("a replay of skip:3 closed with a write still unanswered");
  });

  it("a note that state crosses replays keeps the resumed proof inconclusive, with its reason", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, taint: { ...b.taint, isolation: "state-crossed" } }));
    const report = await prove(scripted(proofResultAfter(1)).run, request(true));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(/cross into the next/);
  });

  function proofResultAfter(finished: number): (n: number) => RunResult {
    return (n) => (n === 1 ? passed : (PROVING[n - 2 + finished] ?? passed));
  }
});

describe("a resume and an errored pair", () => {
  const BOOM = new Error(`boom ${APP_TEXT}`);
  /** Each replay answered by its label. `script` says what a label's answer is, or `passed`. The base reports its steps unless `paced` is false. */
  function labelled(script: (label: string, seen: number, mutation: Record<string, unknown>) => RunResult | Error | undefined, paced = true): { run: Run; onProgress: NonNullable<ProveExtra["onProgress"]>; labels: string[] } {
    const labels: string[] = [];
    const run = (async (options: never, mutation: Record<string, unknown>) => {
      const label = labels.at(-1)!;
      if (label === "base") {
        if (paced) await reportSteps(options);
        return passed;
      }
      const answer = script(label, labels.filter((l) => l === label).length, mutation) ?? passed;
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as Run;
    return { run, labels, onProgress: (p) => void labels.push(p.mutation?.replace(" (retry after error)", "") ?? "base") };
  }
  const blockedButPassed = { outcome: "ok", output: {}, blockedWrites: [{ method: "POST", path: "/api/save" }] } as unknown as RunResult;
  const proving = (label: string): RunResult | undefined => (label === "skip:3" || label === "block-write:3" ? requestBroken : label === "stale-value:2" ? stepBroken : undefined);
  const erroringBlock = (label: string): RunResult | Error | undefined => (label === "block-write:3" ? BOOM : proving(label));
  const proveLabelled = (l: ReturnType<typeof labelled>, resume: boolean): Promise<JourneyVerifyReport> => prove(l.run, request(resume), { onProgress: l.onProgress });

  it("after a proof that finished inconclusive on an errored pair, runs that pair again and reaches the verdict", async () => {
    const report = await proveLabelled(labelled(erroringBlock), false);
    expect(report.verdict).toBe("inconclusive");
    expect(readVerifyProgress(path, keyFile, ID).resume).toEqual({ possible: true });
    const resumed = labelled(proving);
    const second = await proveLabelled(resumed, true);
    expect(second).toMatchObject({ verdict: "proven", reusedPairs: 2 });
    expect(resumed.labels).toEqual(["base", "independence replay, as recorded", "block-write:3", "closing replay, as recorded"]);
    expect(second.mutations.map((m) => [m.id, m.reused])).toEqual([
      ["skip:3", true],
      ["block-write:3", undefined],
      ["stale-value:2", true],
    ]);
    expect(JSON.parse(readFileSync(verifyRecordPath(join(dir, "journeys"), ID), "utf8"))).toMatchObject({ verdict: "proven", reusedPairs: 2 });
    expect(readBody()).toMatchObject({ state: "finished", verdict: "proven" });
    expect(readBody().completed.map((p) => p.id)).toEqual(["skip:3", "block-write:3", "stale-value:2"]);
    expect(await refusal(prove(labelled(proving).run, request(true)))).toBe("finished");
  });

  it("after an interruption, does not reuse an errored pair", async () => {
    const killed = labelled((label) => (label === "stale-value:2" ? stall() : erroringBlock(label)));
    await expect(proveLabelled(killed, false)).rejects.toBeInstanceOf(JourneyVerifyStalledError);
    expect(readBody().completed.map((p) => [p.id, p.outcome])).toEqual([
      ["skip:3", "failed"],
      ["block-write:3", "error"],
    ]);
    const resumed = labelled(proving);
    const report = await proveLabelled(resumed, true);
    expect(report).toMatchObject({ verdict: "proven", reusedPairs: 1 });
    expect(resumed.labels).toEqual(["base", "independence replay, as recorded", "block-write:3", "stale-value:2", "closing replay, as recorded"]);
  });

  it("stays inconclusive when the pair errors again, and can be resumed again", async () => {
    await proveLabelled(labelled(erroringBlock), false);
    const again = await proveLabelled(labelled(erroringBlock), true);
    expect(again).toMatchObject({ verdict: "inconclusive", reusedPairs: 2 });
    expect(readBody().completed.map((p) => p.id)).toEqual(["skip:3", "block-write:3", "stale-value:2"]);
    expect((await proveLabelled(labelled(proving), true)).verdict).toBe("proven");
  });

  it("keeps an errored pair on file if the resume dies before it finishes", async () => {
    await proveLabelled(labelled(erroringBlock), false);
    const killed = labelled((label) => (label === "block-write:3" ? stall() : proving(label)));
    await expect(proveLabelled(killed, true)).rejects.toBeInstanceOf(JourneyVerifyStalledError);
    expect(readBody().verdict).toBeUndefined();
    const resumed = labelled(proving);
    expect(await proveLabelled(resumed, true)).toMatchObject({ verdict: "proven", reusedPairs: 2 });
    expect(resumed.labels).toContain("block-write:3");
  });

  it("still refuses a proof that finished inconclusive with no errored pair: running it again changes nothing", async () => {
    const unevaluable = { outcome: "quarantined", reason: APP_TEXT, outcomeFailures: [{ where: "unevaluable" }] } as unknown as RunResult;
    const report = await proveLabelled(labelled((label) => (proving(label) === undefined ? undefined : unevaluable)), false);
    expect(report.verdict).toBe("inconclusive");
    expect(await refusal(prove(labelled(proving).run, request(true)))).toBe("finished");
    expect(readVerifyProgress(path, keyFile, ID).resume).toEqual({ possible: false, refusal: "finished" });
  });

  it("still refuses an errored proof whose verdict an errored pair did not decide", async () => {
    const report = await proveLabelled(labelled((label) => (label === "block-write:3" ? BOOM : label === "stale-value:2" ? passed : proving(label))), false);
    expect(report.verdict).toBe("insensitive");
    expect(await refusal(prove(labelled(proving).run, request(true)))).toBe("finished");
  });

  it("still refuses an errored proof a failed restore ended: the taint is the proof's, and no re-run lifts it", async () => {
    const report = await proveLabelled(
      labelled((label, _seen, mutation) => {
        if (label === "stale-value:2") (mutation["onFixtureRestoreFailed"] as () => void)();
        return erroringBlock(label);
      }),
      false,
    );
    expect(report.reason).toContain("fixture restore failed");
    expect(await refusal(prove(labelled(proving).run, request(true)))).toBe("finished");
  });

  it("re-runs the reading when the only error was a sibling's re-run, which no pair keeps", async () => {
    const answer = (label: string): RunResult | Error | undefined => (label === "skip:3 (re-run)" ? BOOM : label === "block-write:3" ? blockedButPassed : proving(label));
    const report = await proveLabelled(labelled(answer, false), false);
    expect(report.verdict).toBe("inconclusive");
    expect(report.mutations.find((m) => m.id === "skip:3")?.rerun).toBe("error");
    expect(readVerifyProgress(path, keyFile, ID).resume).toEqual({ possible: true });
  });

  it("the plan's minimum is what a proof that reaches a verdict runs when nothing needs more", async () => {
    const plan = await planJourneyVerification({ dir: join(dir, "journeys"), id: ID, params: {} });
    const l = labelled(proving);
    expect((await proveLabelled(l, false)).verdict).toBe("proven");
    expect(l.labels).toEqual(["base", "independence replay, as recorded", "skip:3", "block-write:3", "stale-value:2", "closing replay, as recorded"]);
    expect(plan.summary.minimumReplays).toBe(l.labels.length);
  });

  describe("a failed restore", () => {
    const failRestore = (mutation: Record<string, unknown>): void => (mutation["onFixtureRestoreFailed"] as () => void)();

    it("runs nothing more after a first replay", async () => {
      const l = labelled((label, _seen, mutation) => {
        if (label === "skip:3") failRestore(mutation);
        return proving(label);
      });
      expect((await proveLabelled(l, false)).verdict).toBe("inconclusive");
      expect(l.labels.at(-1)).toBe("skip:3");
    });

    it("runs no further replay of a targeted proof", async () => {
      const journey = journeyOf();
      journey.metadata.endState = [{ kind: "page", assertion: { kind: "visible", target: { testId: "saved" } } }] as never;
      const save = journey.recording.pages[0]!.steps[2]! as { step: { expect?: unknown }; expectRequests?: unknown };
      delete save.expectRequests;
      save.step.expect = { kind: "visible", target: { testId: "status" } };
      await new FsJourneyStore(join(dir, "journeys")).put(journey);
      const stopped = { outcome: "quarantined", reason: "step 3 postcondition failed", at: 2 } as RunResult;
      const endState = { outcome: "quarantined", reason: "end state", outcomeFailures: [{ where: "end-state", index: 0 }] } as unknown as RunResult;
      const l = labelled((label, seen, mutation) => {
        if (label !== "skip:3") return undefined;
        if (seen < 3) return stopped;
        failRestore(mutation);
        return endState;
      });
      const report = await proveLabelled(l, false);
      expect(report.reason).toContain("fixture restore failed");
      expect(l.labels.filter((x) => x === "skip:3")).toHaveLength(3);
      expect(l.labels.at(-1)).toBe("skip:3");
    });

    it("runs no control after a sibling's re-run", async () => {
      const l = labelled((label, _seen, mutation) => {
        if (label === "skip:3 (re-run)") {
          failRestore(mutation);
          return requestBroken;
        }
        return label === "block-write:3" ? blockedButPassed : proving(label);
      }, false);
      const report = await proveLabelled(l, false);
      expect(report.reason).toContain("fixture restore failed");
      expect(l.labels.at(-1)).toBe("skip:3 (re-run)");
    });
  });
});

describe("a checkpoint of the earlier experiment", () => {
  it("is refused, not misread: its floors and controls meant something else", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, schema: 1 }) as unknown as CheckpointBody);
    expect(await refusal(prove(scripted(proofResult).run, request(true)))).toBe("corrupt");
  });

  it("knows the kinds this experiment runs per pair", () => {
    expect(REPLAY_RECORD_KINDS).toEqual(expect.arrayContaining(["control", "at-base-time", "rerun"]));
  });
});

describe("resume refuses, by name, and never starts over", () => {
  const nothingRuns = (): Run => (async () => { throw new Error("a browser replay ran"); }) as unknown as Run;
  const refusedResume = (over: Partial<ProofCheckpointRequest> = {}, extra: ProveExtra = {}): Promise<ResumeRefusalReason> => refusal(prove(nothingRuns(), request(true, over), extra));

  it("no checkpoint", async () => {
    await interruptAt(3);
    unlinkSync(path);
    expect(await refusedResume()).toBe("no-checkpoint");
  });

  it("a changed Journey", async () => {
    await interruptAt(3);
    const changed = journeyOf();
    (changed.recording.pages[0]!.steps[1]!.step as { value: { value: string } }).value.value = "other";
    await new FsJourneyStore(join(dir, "journeys")).put(changed);
    expect(await refusedResume()).toBe("journey-hash");
  });

  it("a changed mutation plan", async () => {
    await interruptAt(3);
    expect(await refusedResume({}, { readRequests: [READ_SAVE] })).toBe("mutation-plan");
  });

  it("changed parameter values", async () => {
    await storeJourneyWithParam();
    await interruptAt(3, proofResult, { params: { code: "1" } });
    expect(await refusedResume({}, { params: { code: "2" } })).toBe("params");
  });

  it("a changed hook", async () => {
    await interruptAt(3);
    expect(await refusedResume({ config: { ...CONFIG, hook: { before: "other" } } })).toBe("hook");
  });

  it("a changed origin", async () => {
    await interruptAt(3);
    expect(await refusedResume({ config: { ...CONFIG, origin: { baseUrl: "http://127.0.0.1:10" } } })).toBe("origin");
  });

  it("a changed browser configuration", async () => {
    await interruptAt(3);
    expect(await refusedResume({ config: { ...CONFIG, browser: { browser: { headed: true } } } })).toBe("browser");
  });

  it("another CLI build, and a build that cannot say what it is", async () => {
    await interruptAt(3);
    expect(await refusedResume({ build: { ...BUILD, commit: "other" } })).toBe("cli-build");
    expect(await refusedResume({ build: { ...BUILD, commit: "unknown" } })).toBe("cli-build");
  });

  it("over the age limit, counted from its oldest result", async () => {
    await interruptAt(3);
    fake.advanceBy(CHECKPOINT_MAX_AGE_MS + 1);
    expect(await refusedResume()).toBe("too-old");
    expect(readVerifyProgress(path, keyFile, ID).resume).toEqual({ possible: false, refusal: "too-old" });
  });

  it("from the future", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, updatedAt: "2999-01-01T00:00:00.000Z" }));
    expect(await refusedResume()).toBe("too-old");
  });

  it("a truncated file", async () => {
    await interruptAt(3);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.slice(0, raw.length >> 1));
    expect(await refusedResume()).toBe("corrupt");
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ receipt: "corrupt", verifier: "none", resume: { refusal: "corrupt" } });
  });

  it("an empty file", async () => {
    await interruptAt(3);
    writeFileSync(path, "");
    expect(await refusedResume()).toBe("corrupt");
  });

  it("a field nothing here writes, which is how free text would get in", async () => {
    await interruptAt(3);
    const file = JSON.parse(readFileSync(path, "utf8")) as { body: { completed: Record<string, unknown>[] } };
    file.body.completed[0]!["reason"] = APP_TEXT;
    writeFileSync(path, JSON.stringify(file));
    expect(await refusedResume()).toBe("corrupt");
  });

  it("an edited result: a forged `failed` where the proof saw a pass does not carry the key", async () => {
    await interruptAt(3, (n) => (n === 2 ? passed : proofResult(n)));
    const file = JSON.parse(readFileSync(path, "utf8")) as { body: CheckpointBody };
    (file.body.completed[0] as { outcome: string }).outcome = "failed";
    (file.body.completed[0] as { failedSites: unknown[] }).failedSites = [{ where: "step-request", step: 3, checkIndex: 0 }];
    (file.body.completed[0] as { replays: unknown[] }).replays = [{ kind: "first", outcome: "failed", failedSites: [{ where: "step-request", step: 3, checkIndex: 0 }], reachedMs: [], writesInFlightAtClose: 0 }];
    writeFileSync(path, JSON.stringify(file));
    expect(await refusedResume()).toBe("integrity");
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ receipt: "integrity-failed", verifier: "none" });
  });

  it("a replaced key", async () => {
    await interruptAt(3);
    chmodSync(keyFile, 0o600);
    writeFileSync(keyFile, "0".repeat(64));
    expect(await refusedResume()).toBe("integrity");
  });

  it("a missing key is not created to read an old file", async () => {
    await interruptAt(3);
    unlinkSync(keyFile);
    expect(await refusedResume()).toBe("key-unavailable");
    expect(existsSync(keyFile)).toBe(false);
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ receipt: "unverified", resume: { refusal: "key-unavailable" } });
    expect(existsSync(keyFile)).toBe(false);
  });

  it("a key others can reach", async () => {
    await interruptAt(3);
    chmodSync(keyFile, 0o644);
    expect(await refusedResume()).toBe("key-unavailable");
  });

  it("results the plan could not have produced, even signed", async () => {
    await interruptAt(3);
    const original = readBody();
    const cases: ((b: CheckpointBody) => CheckpointBody)[] = [
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, id: "block-write:3", kind: "block-write" as const })) }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, failedSites: [{ where: "step" as const, step: 99, postcondition: true }] })) }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, outcome: "passed" as const })) }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, replays: [] })) }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, control: "passed" as const })) }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, replays: p.replays.map((r) => ({ ...r, failedSites: [] })) })) }),
      (b) => ({ ...b, total: 9 }),
      (b) => ({ ...b, taint: { ...b.taint, notIsolatedBy: "skip:99" } }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, targeted: [{ site: "end-state:77", relaxedSites: [], outcome: "failed" as const, failedSites: [] }] })) }),
      (b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, targeted: [{ site: "end-state:0", relaxedSites: [], outcome: "failed" as const, failedSites: [], refused: APP_TEXT }] })) }) as unknown as CheckpointBody,
    ];
    for (const edit of cases) {
      writeSigned(() => edit(original));
      expect(await refusedResume()).toBe("corrupt");
    }
  });

  it("a replay record of a kind this build does not know, even signed", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, replays: [...p.replays, { kind: "confirming", outcome: "passed" as const, failedSites: [], reachedMs: [], writesInFlightAtClose: 0 }] })) }));
    expect(await refusedResume()).toBe("unknown-record");
    expect(readVerifyProgress(path, keyFile, ID).resume).toEqual({ possible: false, refusal: "unknown-record" });
  });

  it("a replay record with free text for a kind", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, completed: b.completed.map((p) => ({ ...p, replays: p.replays.map((r) => ({ ...r, kind: APP_TEXT + " has spaces" })) })) }));
    expect(await refusedResume()).toBe("corrupt");
  });

  it("a finished proof", async () => {
    await prove(scripted(proofResult).run, request(false));
    expect(await refusedResume()).toBe("finished");
  });

  it("a live verifier, while its proof runs in this very process", async () => {
    let inner: ResumeRefusalReason | undefined;
    let pending: Promise<void> | undefined;
    const { run } = scripted((n) => {
      if (n === 2) pending = refusedResume().then((r) => void (inner = r));
      return proofResult(n);
    });
    await prove(run, request(false));
    await pending;
    expect(inner).toBe("live-verifier");
    expect(readVerifyProgress(path, keyFile, ID).progress?.verdict).toBe("proven");
  });

  it("a verifier on another host, which this host cannot check", async () => {
    await interruptAt(3);
    writeSigned((b) => ({ ...b, state: "running", verifier: { ...b.verifier, host: `not-${hostname()}` } }));
    expect(await refusedResume()).toBe("other-host");
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ verifier: "stale", resume: { refusal: "other-host" } });
  });

  it("the checkpoint stays as it was after a refusal", async () => {
    await interruptAt(3);
    const before = readFileSync(path, "utf8");
    expect(await refusedResume({ config: { ...CONFIG, hook: { before: "other" } } })).toBe("hook");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("what a binding reads", () => {
  it("follows a fixture file through a link, so its new bytes are a change", () => {
    const real = join(dir, "fixtures.json");
    const link = join(dir, "fixtures-link.json");
    writeFileSync(real, "one");
    symlinkSync(real, link);
    const first = canonicalJson(hookBindingOf({ fixtures: link }, undefined));
    writeFileSync(real, "two");
    expect(canonicalJson(hookBindingOf({ fixtures: link }, undefined))).not.toBe(first);
  });

  it("binds an environment's fixture file beside a flag's", () => {
    const flag = join(dir, "flag.json");
    const target = join(dir, "target.json");
    writeFileSync(flag, "flag");
    writeFileSync(target, "one");
    const first = canonicalJson(hookBindingOf({ fixtures: flag }, target));
    writeFileSync(target, "two");
    expect(canonicalJson(hookBindingOf({ fixtures: flag }, target))).not.toBe(first);
  });

  it("binds the session file's bytes, and reads a FIFO as nothing rather than wait on it", () => {
    const session = join(dir, "session.json");
    writeFileSync(session, "one");
    const first = canonicalJson(browserBindingOf(undefined, undefined, session, undefined));
    writeFileSync(session, "two");
    expect(canonicalJson(browserBindingOf(undefined, undefined, session, undefined))).not.toBe(first);
    const fifo = join(dir, "fifo");
    execFileSync("sh", ["-c", 'mkfifo "$1"', "sh", fifo]);
    expect(hookBindingOf({ fixtures: fifo }, undefined)).toMatchObject({ content: null });
  });
});

describe("what is at the checkpoint's path", () => {
  it("a symlink is not followed, by a read, a resume or a fresh proof", async () => {
    await interruptAt(3);
    const target = join(dir, "elsewhere.json");
    renameSync(path, target);
    const held = readFileSync(target, "utf8");
    symlinkSync(target, path);
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ receipt: "not-regular-file", verifier: "none" });
    expect(await refusal(prove(scripted(proofResult).run, request(true)))).toBe("not-regular-file");
    const notices: string[] = [];
    expect((await prove(scripted(proofResult).run, request(false, { onNotice: (t) => void notices.push(t) }))).verdict).toBe("proven");
    expect(notices.join()).toContain("other than a regular file");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(held);
  });

  it("a FIFO does not hang anything", async () => {
    await interruptAt(3);
    unlinkSync(path);
    execFileSync("sh", ["-c", 'mkfifo "$1"', "sh", path]);
    expect(readVerifyProgress(path, keyFile, ID).receipt).toBe("not-regular-file");
    expect(await refusal(prove(scripted(proofResult).run, request(true)))).toBe("not-regular-file");
    expect((await prove(scripted(proofResult).run, request(false))).verdict).toBe("proven");
  });

  it("a directory is no checkpoint", async () => {
    await interruptAt(3);
    unlinkSync(path);
    mkdirSync(path);
    expect(readVerifyProgress(path, keyFile, ID).receipt).toBe("not-regular-file");
    expect(await refusal(prove(scripted(proofResult).run, request(true)))).toBe("not-regular-file");
  });

  it("a key at a link is not trusted", async () => {
    await interruptAt(3);
    const real = `${keyFile}.real`;
    renameSync(keyFile, real);
    symlinkSync(real, keyFile);
    expect(await refusal(prove(scripted(proofResult).run, request(true)))).toBe("key-unavailable");
  });
});

describe("--status", () => {
  it("creates nothing where nothing is", () => {
    expect(readVerifyProgress(path, keyFile, ID)).toMatchObject({ receipt: "none", verifier: "none", resume: { possible: false, refusal: "no-checkpoint" } });
    expect(existsSync(keyFile)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("tells a running proof from an exited one and a reused pid", () => {
    const body = { state: "running" as const, verifier: { pid: 4242, startToken: "100", host: hostname() } };
    expect(verifierStateOf(body, () => "100")).toBe("live");
    expect(verifierStateOf(body, () => undefined)).toBe("exited");
    expect(verifierStateOf(body, () => "999")).toBe("stale");
    expect(verifierStateOf({ ...body, state: "finished" }, () => "100")).toBe("exited");
    expect(verifierStateOf({ ...body, state: "interrupted" }, () => "100")).toBe("exited");
    expect(verifierStateOf({ ...body, verifier: { ...body.verifier, host: `not-${hostname()}` } }, () => "100")).toBe("stale");
  });

  it("through the command: no browser, no hook, no key made, the same answer as the function", async () => {
    const out: string[] = [];
    const program = new Command();
    program.configureOutput({ writeOut: (t) => void out.push(t), writeErr: () => undefined });
    const deps = { profiles: new ProfileManager("/unused"), journeysDir: join(dir, "journeys"), dbPath: join(dir, "no-site-policy.sqlite") };
    registerJourneyVerify(program.command("journey"), program, deps, { run: (async () => { throw new Error("a browser replay ran"); }) as never });
    await program.parseAsync(["journey", "verify", "never-ran", "--status"], { from: "user" });
    expect(out.join("")).toContain("no progress receipt");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("the reused results against a re-measured base", () => {
  const journey = journeyOf();
  const plan: MutationPlan = planJourneyMutations(journey, {});
  const sites: readonly JourneyAssertionSite[] = journeyAssertions(journey);
  const m = plan.mutations.find((x) => x.id === "skip:3")!;
  const site = sites.find((s) => assertionSiteKey(s) === "step-request:3:0")!;
  expect(site).toBeDefined();
  const failedSites = [{ where: "step-request", step: 3, checkIndex: 0 } as const];
  const stateWith = (reachedStep3Ms: number, over: { control?: "passed" | "failed"; writes?: number; controlWrites?: number; controlReachedMs?: number; outcome?: "failed" | "passed" } = {}): ResumeState => {
    const outcome = over.outcome ?? "failed";
    const run = { outcome, failedSites: outcome === "failed" ? failedSites : [], reachedMs: [undefined, undefined, reachedStep3Ms] };
    const control = over.control === undefined ? [] : [checkpointReplayOf("control", { outcome: over.control, failedSites: over.control === "failed" ? failedSites : [], reachedMs: [undefined, undefined, over.controlReachedMs ?? 1] }, over.controlWrites ?? 0)];
    const pair = checkpointPairOf({ kind: m.kind, step: m.step, id: m.id, outcome, failedSites: run.failedSites, ...(over.control === undefined ? {} : { control: over.control }) }, [checkpointReplayOf("first", run, over.writes ?? 0), ...control]);
    return { pairs: new Map([[m.id, pair]]), restoreFailed: false, notIsolatedBy: null };
  };
  const paceOf = (step3Ms: number): ReplayPace => ({ stepEndMs: [100, 200, 200 + step3Ms] });
  const reason = (state: ResumeState, pace: ReplayPace, inFlight = 0): string | undefined => resumeRefusalAgainstBase(state, plan, sites, pace, inFlight)?.reason;

  it("keeps a failure reached well after the new base passed the site", () => {
    // Base took 2s at the step; the replay got there at 10s, past twice the margin.
    expect(reason(stateWith(10_000), paceOf(2_000))).toBeUndefined();
  });

  it("refuses a failure reached sooner than the new, slower base passed the site", () => {
    expect(reason(stateWith(3_000), paceOf(8_000))).toBe("pace");
  });

  it("refuses a failure newly thin against the new base when no control answered for it", () => {
    expect(reason(stateWith(9_000), paceOf(8_000))).toBe("pace");
  });

  it("keeps it when a control replay answered: that comparison never rested on the base", () => {
    expect(reason(stateWith(9_000, { control: "passed" }), paceOf(8_000))).toBeUndefined();
  });

  it("still refuses a failure sooner than the base with a control", () => {
    expect(reason(stateWith(3_000, { control: "passed" }), paceOf(8_000))).toBe("pace");
  });

  it("a faster base only leaves a reused replay more room", () => {
    expect(reason(stateWith(10_000), paceOf(100))).toBeUndefined();
  });

  it("ignores a pair that proved nothing: a pass cannot become a false proof", () => {
    expect(reason(stateWith(3_000, { outcome: "passed" }), paceOf(8_000))).toBeUndefined();
  });

  it("holds a control to the same checks as a mutated replay", () => {
    expect(reason(stateWith(10_000, { control: "passed", controlWrites: 1 }), paceOf(2_000), 0)).toBe("isolation");
    expect(reason(stateWith(10_000, { control: "failed", controlReachedMs: 3_000 }), paceOf(8_000))).toBe("pace");
  });

  it("refuses when a reused replay left more writes open than the new base did", () => {
    expect(reason(stateWith(10_000, { writes: 1 }), paceOf(2_000), 0)).toBe("isolation");
    expect(reason(stateWith(10_000, { writes: 1 }), paceOf(2_000), 1)).toBeUndefined();
  });
});

describe("MCP (`verify_journey`) and the CLI", () => {
  const spec = CLI_TOOL_SPECS.find((t) => t.name === "verify_journey")!;

  /** The real command through the real MCP runner, with only the replay and the home directory swapped. */
  function surfaces(run: Run): { mcp: (args: Record<string, unknown>) => ReturnType<typeof runCliTool>; cli: (...argv: string[]) => Promise<{ stdout: string; exitCode: number }> } {
    const build = (): Command => {
      const program = new Command();
      program.exitOverride();
      const deps = { profiles: new ProfileManager("/unused"), journeysDir: join(dir, "journeys"), dbPath: join(dir, "no-site-policy.sqlite") };
      registerJourneyVerify(program.command("journey"), program, deps, { run });
      return program;
    };
    const runCli = makeInProcessCliRunner(build);
    return {
      mcp: (args) => runCliTool(spec, args as never, { runCli, roots: [dir], redact: (t) => t }),
      cli: (...argv) => runCli(argv),
    };
  }

  const prior = process.env["HOME"];
  beforeEach(() => {
    process.env["HOME"] = join(dir, "home");
    mkdirSync(join(dir, "home"), { recursive: true });
  });
  afterEach(() => {
    if (prior === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prior;
  });

  it("offer the same status, with the same fields", async () => {
    const stalled = scripted((n) => (n === 3 ? stall() : proofResult(n)));
    const { mcp, cli } = surfaces(stalled.run);
    await mcp({ id: ID, mutate: true });
    const overMcp = (await mcp({ id: ID, status: true })) as { isError?: boolean; body: { exitCode: number; data: { engine: unknown; progress: { completed: number; total: number } } } };
    expect(overMcp.isError).toBeFalsy();
    expect(overMcp.body.data.progress).toMatchObject({ completed: 1, total: 3 });
    const overCli = await cli("journey", "verify", ID, "--status", "--json");
    expect((JSON.parse(overCli.stdout) as { data: unknown }).data).toEqual(overMcp.body.data);
  });

  it("answer status while a proof holds the same server's queue, and leave that proof's exit code alone", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const realSleep = setTimeout;
    let n = 0;
    const run = (async (options: never) => {
      n += 1;
      if (n === 1) await reportSteps(options);
      if (n === 4) await held;
      // Replay 2 is the independence replay.
      return n === 2 ? passed : proofResult(n - 1);
    }) as unknown as Run;
    const { mcp } = surfaces(run);
    const proof = mcp({ id: ID, mutate: true });
    for (let i = 0; i < 200 && n < 4; i++) await new Promise((resolve) => realSleep(resolve, 5));
    expect(n).toBe(4);
    process.exitCode = 7;
    const seen = (await mcp({ id: ID, status: true })) as unknown as { isError?: boolean; body: { exitCode: number; data: { verifier: string; progress: { completed: number; currentPair: string } } } };
    expect(seen.isError).toBeFalsy();
    expect(seen.body).toMatchObject({ exitCode: 0, data: { verifier: "live", progress: { completed: 1, currentPair: "block-write:3" } } });
    const usage = await mcp({ id: ID, status: true, plan: true });
    expect(usage).toMatchObject({ isError: true, body: { code: "E_JOURNEY_VERIFY_ARGS", exitCode: 64 } });
    expect(process.exitCode).toBe(7);
    process.exitCode = undefined;
    release();
    expect(await proof).toMatchObject({ body: { exitCode: 0, data: { verdict: "proven", reusedPairs: 0 } } });
  });

  it("offer the same resume, reaching the same report field", async () => {
    let script: (n: number) => RunResult | Error = (n) => (n === 3 ? stall() : proofResult(n));
    const { mcp } = surfaces(scripted((n) => script(n)).run);
    await mcp({ id: ID, mutate: true });
    let n2 = 0;
    script = () => {
      n2 += 1;
      return n2 === 1 ? passed : n2 === 2 ? requestBroken : n2 === 3 ? stepBroken : passed;
    };
    const resumed = (await mcp({ id: ID, mutate: true, resume: true })) as unknown as { body: { exitCode: number; data: JourneyVerifyReport } };
    expect(resumed.body).toMatchObject({ exitCode: 0, data: { verdict: "proven", reusedPairs: 1 } });
  });

  it("refuse alike, naming the reason in `data` on both", async () => {
    const { mcp, cli } = surfaces(scripted(proofResult).run);
    const overMcp = await mcp({ id: ID, mutate: true, resume: true });
    expect(overMcp).toMatchObject({ isError: true, body: { error: "refused", code: "E_JOURNEY_VERIFY_RESUME_REFUSED", exitCode: 2, data: { reason: expect.stringMatching(/^(no-checkpoint|key-unavailable)$/) } } });
    const overCli = await cli("journey", "verify", ID, "--mutate", "--resume", "--json");
    expect(overCli.exitCode).toBe(2);
    expect(JSON.parse(overCli.stdout)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_VERIFY_RESUME_REFUSED" }, data: { reason: (overMcp.body as { data: { reason: string } }).data.reason } });
  });

  it("add no tool: the arguments live on `verify_journey`", () => {
    const params = (spec.command as { params: Record<string, { flag?: string }> }).params;
    expect(params["status"]?.flag).toBe("--status");
    expect(params["resume"]?.flag).toBe("--resume");
  });

  it("refuse --resume without --mutate, and --status with --resume, as usage", async () => {
    const { cli } = surfaces(scripted(proofResult).run);
    expect((await cli("journey", "verify", ID, "--resume", "--json")).stdout).toContain("E_JOURNEY_VERIFY_ARGS");
    expect((await cli("journey", "verify", ID, "--status", "--resume", "--json")).stdout).toContain("E_JOURNEY_VERIFY_ARGS");
  });
});
