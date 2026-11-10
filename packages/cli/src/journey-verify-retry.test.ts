import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, clock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { MachineBrowserSlots, ResourceGovernor, type BrowserPort, type BrowserSession, type MachineSlotLease } from "@jevitate/playwright";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { planJourneyVerification, proofInactivityMs, verifyJourneyMutations, type JourneyVerifyProgress } from "./journey-verify.js";
import type { MissionFixtures } from "./mission-fixtures.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";

/**
 * A proof survives one infrastructure hiccup (#766, #778): it keeps its machine slot between replays
 * unless another process waits, and runs an errored mutated replay once more. Driven through the
 * `run` seam on a fake clock; the slot is a real file in a private directory.
 */

const ID = "save-text";

type Run = NonNullable<JourneyVerifySeams["run"]>;
type RunResult = Awaited<ReturnType<Run>>;
const passed = { outcome: "ok", output: {} } as RunResult;
/** A mutated replay that broke the step: a result, not an error. */
const failed = { outcome: "quarantined", reason: "step 2 postcondition failed", at: 1, failurePhase: "postcondition" } as RunResult;

const journey: Journey = {
  metadata: { id: ID, name: "Save text", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00.000Z" },
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

let dir: string;
let slotDir: string;
let fake: FakeClock;
let mutationIds: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-retry-"));
  slotDir = join(dir, "slots");
  await new FsJourneyStore(dir).put(journey);
  mutationIds = (await planJourneyVerification({ dir, id: ID, params: {} })).mutations.map((m) => m.id);
  fake = new FakeClock();
  installClock(fake);
  __resetTerminalResultForTests();
});

afterEach(async () => {
  __resetTerminalResultForTests();
  resetClock();
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Replay `n` (1-based; 1 is the Journey as recorded) as `script` says; `passed` when it says nothing. Counts the calls. */
function scripted(script: (n: number) => RunResult | Error | Promise<RunResult>): { run: Run; calls: () => number } {
  let n = 0;
  const run = (async () => {
    n += 1;
    const step = await script(n);
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as Run;
  return { run, calls: () => n };
}

const prove = (run: Run, extra: Partial<Parameters<typeof verifyJourneyMutations>[0]> = {}): ReturnType<typeof verifyJourneyMutations> => verifyJourneyMutations({ dir, id: ID, params: {}, ...extra }, run);

const ADMISSION = new Error("admission timed out after 300s");

/** What each of the plan's mutations must do for every paired assertion to be proven sensitive. */
const REQUEST_BROKEN = { outcome: "quarantined", reason: "step 3 request check failed", outcomeFailures: [{ where: "step-request", step: 3, checkIndex: 0 }], blockedWrites: [{ method: "POST", path: "/api/save" }] } as unknown as RunResult;
const PROVING = [REQUEST_BROKEN, REQUEST_BROKEN, failed];

/** A proof that ends `proven`, except that the replays in `erroring` (1-based over the proof) throw instead. */
function proofErroringAt(...erroring: number[]): { run: Run; calls: () => number } {
  let results = 0;
  return scripted((n) => {
    if (erroring.includes(n)) return ADMISSION;
    return n === 1 ? passed : PROVING[results++ % PROVING.length]!;
  });
}

/** Lets a proof's real I/O and its fake timers run until `promise` settles. */
async function untilSettled(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const done = (): void => void (settled = true);
  promise.then(done, done);
  while (!settled) await fake.advanceBy(30_000);
}

describe("an errored mutated replay", () => {
  it("counts the retry's result when the retry succeeds", async () => {
    const report = await prove(proofErroringAt(2).run);
    expect(report.mutations[0]!.outcome).toBe("failed");
  });

  it("leaves the proof proven when its retry succeeds", async () => {
    const report = await prove(proofErroringAt(2).run);
    // #812: this double reports no step of the base, so no independence replay runs, and the adjudicator
    // never counts a proof whose replays were not shown independent. The retry itself leaves no gap.
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toBe("the proof could not establish that the replays stayed independent (not-gathered); retry it");
    expect(report.assertions.every((a) => a.verdict === "sensitive" || a.verdict === "unpaired")).toBe(true);
  });

  it("records the retry and the error it followed on the mutation", async () => {
    const report = await prove(proofErroringAt(2).run);
    expect(report.mutations[0]!.retries).toEqual([{ reason: ADMISSION.message }]);
  });

  it("leaves no trace on a mutation that was not retried", async () => {
    const report = await prove(proofErroringAt(2).run);
    expect(report.mutations[1]!.retries).toBeUndefined();
  });

  it("is run exactly once more when the retry errors too", async () => {
    const { run, calls } = proofErroringAt(2, 3);
    const report = await prove(run);
    expect(calls()).toBe(1 + 1 + report.mutations.length);
  });

  it("stays an error when the retry errors too", async () => {
    const report = await prove(proofErroringAt(2, 3).run);
    expect(report.mutations[0]!.outcome).toBe("error");
  });

  it("leaves the proof inconclusive when the retry errors too", async () => {
    const report = await prove(proofErroringAt(2, 3).run);
    expect(report.verdict).toBe("inconclusive");
  });

  it("reports the retry as progress, named as one", async () => {
    const seen: JourneyVerifyProgress[] = [];
    const { run } = scripted((n) => (n === 2 ? ADMISSION : passed));
    await prove(run, { onProgress: (p) => seen.push(p) });
    expect(seen[2]).toEqual({ replay: 3, mutation: `${mutationIds[0]} (retry after error)`, retry: true });
  });

  it("sets its fixtures up and restores them around each attempt", async () => {
    const log: string[] = [];
    const fixtures = (): MissionFixtures =>
      ({
        setup: async () => void log.push("setup"),
        restore: async () => void log.push("restore"),
        restoreFailed: () => false,
        bindings: () => ({}),
        record: () => ({}),
      }) as unknown as MissionFixtures;
    const brokenPort: BrowserPort = { open: async () => Promise.reject(ADMISSION) };
    let calls = 0;
    const run = ((options: Parameters<Run>[0], mutation: Parameters<Run>[1]) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(passed);
      // The real run, for the first mutation's two attempts: its own fixture handling is what is under test.
      if (calls <= 3) return runJourneyProgrammatically({ ...options, browserPortFactory: () => brokenPort }, mutation);
      return Promise.resolve(passed);
    }) as unknown as Run;
    await prove(run, { fixtures });
    expect(log.slice(0, 4)).toEqual(["setup", "restore", "setup", "restore"]);
  });
});

describe("a proof's inactivity limit", () => {
  const withChecks = (count: number): Journey => {
    const copy = structuredClone(journey);
    const save = copy.recording.pages[0]!.steps[2]!;
    save.responseTimeoutMs = 600_000;
    save.expectRequests = Array.from({ length: count }, () => ({ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }) as const);
    return copy;
  };

  it("allows a step one response wait per request check", () => {
    // At least: the longest step also sizes the pacing margin and the wait for open writes.
    expect(proofInactivityMs(withChecks(3)) - proofInactivityMs(withChecks(1))).toBeGreaterThanOrEqual(1_200_000);
  });
});

describe("a replay that is not retried", () => {
  it("is not retried once it has opened a browser session, which may have changed the app", async () => {
    let calls = 0;
    const run = (async (options: Parameters<Run>[0]) => {
      calls += 1;
      if (calls === 1) return passed;
      await options.browserPortFactory!().open({} as never);
      throw ADMISSION;
    }) as unknown as Run;
    const session = { close: async () => undefined } as unknown as BrowserSession;
    const port: BrowserPort = { open: async () => session };
    const report = await prove(run, { browserPortFactory: () => port });
    expect(report.mutations.some((m) => m.retries !== undefined)).toBe(false);
  });

  it("a failed replay is a result", async () => {
    const seen: JourneyVerifyProgress[] = [];
    const { run } = proofErroringAt();
    await prove(run, { onProgress: (p) => seen.push(p) });
    expect(seen.filter((p) => p.retry === true)).toEqual([]);
  });

  it("a stall ends the run at the replay it hit", async () => {
    const { run, calls } = scripted((n) => (n === 1 ? passed : new Promise<RunResult>(() => undefined)));
    await untilSettled(prove(run));
    expect(calls()).toBe(2);
  });

  it("a stall still rejects the proof with no verdict", async () => {
    const { run } = scripted((n) => (n === 1 ? passed : new Promise<RunResult>(() => undefined)));
    const proving = prove(run);
    await untilSettled(proving);
    await expect(proving).rejects.toMatchObject({ code: "E_TERMINAL_WATCHDOG" });
  });

  it("a stall during a retry ends the run too", async () => {
    const { run, calls } = scripted((n) => (n === 1 ? passed : n === 2 ? ADMISSION : new Promise<RunResult>(() => undefined)));
    await untilSettled(prove(run));
    expect(calls()).toBe(3);
  });

  it("an errored base replay gets no second run", async () => {
    const { run, calls } = scripted(() => ADMISSION);
    await prove(run).catch(() => undefined);
    expect(calls()).toBe(1);
  });
});

describe("a targeted proof's replay", () => {
  it("is retried through the same path", async () => {
    // Every mutated replay stops at step 1's postcondition, leaving later sites a cascade: a targeted proof runs.
    const stopped = { outcome: "quarantined", reason: "step 1 postcondition failed", at: 0, failurePhase: "postcondition" } as RunResult;
    const replays: JourneyVerifyProgress[] = [];
    const targetedError = 3; // after the base and the first mutation's first (and relaxed) replay
    let errored = false;
    const run = (async (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>) => {
      void options;
      if (replays.length === 1) return passed;
      if (!errored && replays.length >= targetedError && mutation.mutateJourney !== undefined) {
        errored = true;
        throw ADMISSION;
      }
      return stopped;
    }) as unknown as Run;
    const report = await prove(run, { onProgress: (p) => replays.push(p) });
    const retried = report.mutations.find((m) => m.retries !== undefined);
    expect(retried?.targeted?.length ?? 0).toBeGreaterThan(0);
  });
});

/** Parses `journey verify` as the CLI does, with the process seams collected. */
function verifyCommand(run: Run): { stderr: string[]; exits: number[]; parsing: Promise<unknown> } {
  const stderr: string[] = [];
  const exits: number[] = [];
  const terminal: TerminalResultDeps = {
    exit: (code) => void exits.push(code),
    terminateBrowsers: () => undefined,
    writeStdout: () => undefined,
    writeStderr: (text) => void stderr.push(text),
    writeResult: (path) => path,
    engine: () => ({ version: "0.0.0-test" }) as ReturnType<TerminalResultDeps["engine"]>,
    onFatalError: () => () => undefined,
    onProcessExit: () => () => undefined,
    installKillSwitch: () => undefined,
    sharedProcess: () => false,
  };
  const program = new Command();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const deps = { profiles: new ProfileManager("/unused"), journeysDir: dir, dbPath: join(dir, "no-site-policy.sqlite") };
  registerJourneyVerify(program.command("journey"), program, deps, { run, terminal });
  return { stderr, exits, parsing: program.parseAsync(["journey", "verify", ID, "--mutate", "--json"], { from: "user" }) };
}

describe("the command", () => {
  it("prints the retry on stderr", async () => {
    const { run } = scripted((n) => (n === 2 ? ADMISSION : passed));
    const { stderr, parsing } = verifyCommand(run);
    await parsing;
    expect(stderr.join("")).toContain(`mutation ${mutationIds[0]} (retry after error)`);
  });

  it("counts a retry as progress: an error and its retry may together outlast the inactivity limit", async () => {
    const nearly = proofInactivityMs(journey) - 1_000;
    const started: Array<() => void> = [];
    const reached = [2, 3].map((_, i) => new Promise<void>((resolve) => (started[i] = resolve)));
    const { run } = scripted(async (n) => {
      if (n !== 2 && n !== 3) return passed;
      started[n - 2]!();
      await clock.sleep(nearly);
      if (n === 2) throw ADMISSION;
      return passed;
    });
    const { exits, parsing } = verifyCommand(run);
    await reached[0];
    await fake.advanceBy(nearly);
    await reached[1];
    await fake.advanceBy(nearly);
    await parsing;
    expect(exits).toEqual([]);
  });
});

describe("a proof's machine slot", () => {
  const ONE = { maxBrowsers: 1 };
  const slotsOf = (pid: number): MachineBrowserSlots => new MachineBrowserSlots({ dir: slotDir, host: "h", pid, isAlive: () => true });
  const governorOf = (): ResourceGovernor =>
    new ResourceGovernor({
      config: { enabled: false, maxBrowsers: 1, memoryCeilingBytes: null },
      slots: slotsOf(100),
      sampleHost: async () => ({}),
      measureMemory: () => undefined,
      admissionTimeoutMs: 60_000,
    });
  const slotToken = (): string => (JSON.parse(readFileSync(join(slotDir, "slot-0.json"), "utf8")) as { token: string }).token;
  /** Every replay opens one session on `g`, as the real browser port does. */
  const replaysOn = (g: ResourceGovernor, during: (n: number) => void | Error = () => undefined): Run => {
    let n = 0;
    return (async () => {
      n += 1;
      const ticket = await g.enter(ONE);
      try {
        const outcome = during(n);
        if (outcome instanceof Error) throw outcome;
        return passed;
      } finally {
        ticket.release();
      }
    }) as unknown as Run;
  };

  it("is the same slot for every replay when nobody waits", async () => {
    const g = governorOf();
    const tokens = new Set<string>();
    await prove(replaysOn(g, () => void tokens.add(slotToken())), { slotGovernor: g });
    expect(tokens.size).toBe(1);
  });

  it("goes to another process that waits, between replays", async () => {
    const g = governorOf();
    let got: MachineSlotLease | undefined;
    const proving = prove(
      replaysOn(g, (n) => {
        if (n !== 2) return;
        void slotsOf(200)
          .acquire(1, clock.now() + 60_000)
          .then((lease) => {
            got = lease;
            lease.release();
          });
      }),
      { slotGovernor: g },
    );
    await untilSettled(proving);
    expect(got?.index).toBe(0);
  });

  it("is released when the proof ends", async () => {
    const g = governorOf();
    await prove(replaysOn(g), { slotGovernor: g });
    expect(g.slots.list()).toEqual([]);
  });

  it("is released when the proof ends in an error", async () => {
    const g = governorOf();
    await prove(replaysOn(g, () => ADMISSION), { slotGovernor: g }).catch(() => undefined);
    expect(g.slots.list()).toEqual([]);
  });

  it("is released when the proof ends in a stall", async () => {
    const g = governorOf();
    const run = replaysOn(g);
    let n = 0;
    const stalling = (async (options: Parameters<Run>[0], mutation: Parameters<Run>[1]) => {
      n += 1;
      return n === 1 ? run(options, mutation) : new Promise(() => undefined);
    }) as unknown as Run;
    await untilSettled(prove(stalling, { slotGovernor: g }));
    expect(g.slots.list()).toEqual([]);
  });

  it("is not kept after the proof: a later session releases at its close", async () => {
    const g = governorOf();
    await prove(replaysOn(g), { slotGovernor: g });
    (await g.enter(ONE)).release();
    expect(g.slots.list()).toEqual([]);
  });
});
