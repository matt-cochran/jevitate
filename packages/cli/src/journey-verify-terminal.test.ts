import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { BrowserPort } from "@jevitate/playwright";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { verifyRecordPath, writeVerifyRecord } from "./journey-review-store.js";
import { planJourneyVerification, proofInactivityMs, verifyJourneyMutations, type JourneyVerifyProgress } from "./journey-verify.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";

/**
 * `journey verify --mutate` always ends with a result (#766): the command itself, driven on a fake
 * clock through the `run` seam and the terminal layer's process seam. Spawned and real-browser cases
 * are in `journey-verify-terminal.e2e.test.ts`.
 */

const ID = "save-text";
const SECRET = "hunter2-do-not-print";

type Run = NonNullable<JourneyVerifySeams["run"]>;
const passed = { outcome: "ok", output: {} } as Awaited<ReturnType<Run>>;

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
let fake: FakeClock;
let limitMs: number;
let mutationIds: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-terminal-"));
  await new FsJourneyStore(dir).put(journey);
  mutationIds = (await planJourneyVerification({ dir, id: ID, params: {} })).mutations.map((m) => m.id);
  limitMs = proofInactivityMs(journey);
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

interface FakeProcess {
  readonly terminal: TerminalResultDeps;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exits: number[];
  readonly artifacts: unknown[];
}

function fakeProcess(): FakeProcess {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const artifacts: unknown[] = [];
  return {
    stdout,
    stderr,
    exits,
    artifacts,
    terminal: {
      exit: (code) => void exits.push(code),
      terminateBrowsers: () => undefined,
      writeStdout: (text) => void stdout.push(text),
      writeStderr: (text) => void stderr.push(text),
      writeResult: (path, _outcome, _code, result) => {
        artifacts.push(result);
        return path;
      },
      engine: () => ({ version: "0.0.0-test" }) as ReturnType<TerminalResultDeps["engine"]>,
      onFatalError: () => () => undefined,
      onProcessExit: () => () => undefined,
      installKillSwitch: () => undefined,
      sharedProcess: () => false,
    },
  };
}

/** Parses `journey verify` as the CLI does, with its stdout collected into `stdout`. */
function verifyCommand(stdout: string[], seams: JourneyVerifySeams, params: readonly string[] = []): Promise<unknown> {
  const program = new Command();
  program.configureOutput({ writeOut: (s) => void stdout.push(s), writeErr: () => undefined });
  const deps = { profiles: new ProfileManager("/unused"), journeysDir: dir, dbPath: join(dir, "no-site-policy.sqlite") };
  registerJourneyVerify(program.command("journey"), program, deps, seams);
  return program.parseAsync(["journey", "verify", ID, "--mutate", "--json", ...params.flatMap((p) => ["--param", p])], { from: "user" });
}

/** Passes `passing` replays, then never settles. `reached` resolves when the stuck replay has started. */
function stuckAfter(passing: number): { run: Run; reached: Promise<void> } {
  let calls = 0;
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const run = (async () => {
    calls += 1;
    if (calls <= passing) return passed;
    arrive();
    return new Promise(() => undefined);
  }) as unknown as Run;
  return { run, reached };
}

/** `parsing` once all its timers have run: the abandoned command unwinds, so nothing outlives the test. */
async function unwind(parsing: Promise<unknown>): Promise<void> {
  await fake.runUntilIdle();
  await parsing;
}

describe("a replay that never settles", () => {
  it("ends with E_TERMINAL_WATCHDOG naming its replay and mutation, exit 2", async () => {
    const p = fakeProcess();
    const { run, reached } = stuckAfter(1);
    const parsing = verifyCommand([], { run, terminal: p.terminal });
    await reached;
    await fake.advanceBy(limitMs);
    expect({ exits: p.exits, envelope: JSON.parse(p.stdout.join("")) }).toMatchObject({
      exits: [2],
      envelope: { ok: false, error: { code: "E_TERMINAL_WATCHDOG" }, data: { progress: { replay: 2, mutation: mutationIds[0] } } },
    });
    await unwind(parsing);
  });

  it("leaves the prior receipt unchanged", async () => {
    await writeVerifyRecord(dir, { journeyId: ID, contentHash: "a".repeat(64), proofHash: "b".repeat(64), verdict: "sensitive", summary: {}, at: "2026-10-26T00:00:00.000Z" });
    const before = await readFile(verifyRecordPath(dir, ID), "utf8");
    const { run, reached } = stuckAfter(1);
    const parsing = verifyCommand([], { run, terminal: fakeProcess().terminal });
    await reached;
    await unwind(parsing);
    expect(await readFile(verifyRecordPath(dir, ID), "utf8")).toBe(before);
  });
});

describe("a proof that keeps progressing", () => {
  it("is never ended, however long it runs", async () => {
    const p = fakeProcess();
    let started = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = 0;
    // Each replay takes 90% of the limit: more than the limit in total, never that long without progress.
    const steady = (async () => {
      started();
      await new Promise((resolve) => fake.setTimeout(resolve, limitMs * 0.9));
      finished += 1;
      return passed;
    }) as unknown as Run;
    const parsing = verifyCommand([], { run: steady, terminal: p.terminal });
    await reached;
    while (finished < mutationIds.length + 1) await fake.advanceBy(limitMs / 10);
    await parsing;
    expect({ exits: p.exits, ranPastTheLimit: fake.monotonicMs() > limitMs }).toEqual({ exits: [], ranPastTheLimit: true });
  });

  it("reports each replay on stderr, in order", async () => {
    const p = fakeProcess();
    await verifyCommand([], { run: (async () => passed) as unknown as Run, terminal: p.terminal });
    const reported = p.stderr.map((line) => /replay \d+(?:, mutation \S+)?/.exec(line)?.[0]);
    expect(reported).toEqual(["replay 1", ...mutationIds.map((id, i) => `replay ${i + 2}, mutation ${id}`)]);
  });

  it("keeps stdout to one JSON envelope", async () => {
    const stdout: string[] = [];
    const p = fakeProcess();
    await verifyCommand(stdout, { run: (async () => passed) as unknown as Run, terminal: p.terminal });
    const lines = [...stdout, ...p.stdout].join("").trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { ok: boolean }).ok)).toEqual([true]);
  });
});

describe("a secret parameter in a thrown error", () => {
  const throwing = (async () => {
    throw new Error(`login failed with ${SECRET}`);
  }) as unknown as Run;

  async function failed(): Promise<FakeProcess> {
    const p = fakeProcess();
    await verifyCommand([], { run: throwing, terminal: p.terminal }, [`password=${SECRET}`]);
    return p;
  }
  const reading = (text: string): { reportsTheError: boolean; leaks: boolean } => ({ reportsTheError: text.includes("login failed with"), leaks: text.includes(SECRET) });

  it("does not reach the envelope", async () => {
    expect(reading((await failed()).stdout.join(""))).toEqual({ reportsTheError: true, leaks: false });
  });

  it("does not reach the artifact", async () => {
    expect(reading(JSON.stringify((await failed()).artifacts))).toEqual({ reportsTheError: true, leaks: false });
  });
});

describe("inside an MCP call, where the terminal layer stays out", () => {
  it("ends the command with E_TERMINAL_WATCHDOG naming its replay and mutation", async () => {
    const stdout: string[] = [];
    const { run, reached } = stuckAfter(1);
    const parsing = runAsMcpInvocation(() => verifyCommand(stdout, { run }));
    await reached;
    await unwind(parsing);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ ok: false, error: { code: "E_TERMINAL_WATCHDOG" }, data: { progress: { replay: 2, mutation: mutationIds[0] } } });
  });

  it("exits 2", async () => {
    const { run, reached } = stuckAfter(1);
    const parsing = runAsMcpInvocation(() => verifyCommand([], { run }));
    await reached;
    await unwind(parsing);
    expect(process.exitCode).toBe(2);
  });
});

describe("the proof's own bound", () => {
  it("closes the session a stalled replay opened", async () => {
    let closes = 0;
    let opened = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const port = { open: async () => ({ close: async () => void (closes += 1) }) } as unknown as BrowserPort;
    const run = (async (opts: { browserPortFactory: () => BrowserPort }) => {
      await opts.browserPortFactory().open({} as never);
      opened();
      return new Promise(() => undefined);
    }) as unknown as Run;
    const proving = verifyJourneyMutations({ dir, id: ID, params: {}, browserPortFactory: () => port }, run).catch(() => undefined);
    await reached;
    await fake.runUntilIdle();
    await proving;
    expect(closes).toBe(1);
  });

  it("closes a session that lands after the stall", async () => {
    let closes = 0;
    let land = (): void => undefined;
    let opening = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      opening = resolve;
    });
    const port = {
      open: () =>
        new Promise((resolve) => {
          land = () => resolve({ close: async () => void (closes += 1) });
        }),
    } as unknown as BrowserPort;
    const run = (async (opts: { browserPortFactory: () => BrowserPort }) => {
      const open = opts.browserPortFactory().open({} as never);
      opening();
      await open;
      return new Promise(() => undefined);
    }) as unknown as Run;
    const proving = verifyJourneyMutations({ dir, id: ID, params: {}, browserPortFactory: () => port }, run).catch(() => undefined);
    await reached;
    await fake.runUntilIdle();
    await proving;
    land();
    await fake.advanceBy(1);
    expect(closes).toBe(1);
  });

  it("never reads as a verdict: the proof rejects", async () => {
    const { run, reached } = stuckAfter(1);
    const proving = expect(verifyJourneyMutations({ dir, id: ID, params: {} }, run)).rejects.toMatchObject({ code: "E_TERMINAL_WATCHDOG", where: { replay: 2, mutation: mutationIds[0] } });
    await reached;
    await fake.runUntilIdle();
    await proving;
  });

  it("reports progress to a caller without a terminal layer", async () => {
    const seen: JourneyVerifyProgress[] = [];
    await verifyJourneyMutations({ dir, id: ID, params: {}, onProgress: (p) => seen.push(p) }, (async () => passed) as unknown as Run);
    expect(seen).toEqual([{ replay: 1 }, ...mutationIds.map((mutation, i) => ({ replay: i + 2, mutation }))]);
  });
});

describe("the inactivity limit", () => {
  const sized = (steps: number, extra: Partial<Journey["recording"]["pages"][number]["steps"][number]> = {}): Journey => {
    const first = journey.recording.pages[0]!.steps[0]!;
    return { ...journey, recording: { ...journey.recording, pages: [{ url: "/", steps: Array.from({ length: steps }, () => ({ ...first, ...extra })) }] } };
  };

  it("grows with the Journey's size", () => {
    expect(proofInactivityMs(sized(40))).toBeGreaterThan(proofInactivityMs(sized(10)));
  });

  it("covers a step's declared response wait", () => {
    // At least: the longest step also sizes the pacing margin and the wait for open writes.
    expect(proofInactivityMs(sized(10, { responseTimeoutMs: 600_000 })) - proofInactivityMs(sized(10))).toBeGreaterThanOrEqual(10 * (600_000 - 15_000));
  });

  it("covers the 300 s admission bound and a replay floor for the smallest Journey", () => {
    expect(proofInactivityMs(sized(0))).toBe(300_000 + 360_000);
  });
});
