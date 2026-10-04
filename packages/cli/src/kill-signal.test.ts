import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@jevitate/explore";
import { UsageTracker } from "@jevitate/ai-core";
import { FakeClock, installClock, MissionResultSchema, PersistedMissionResultSchema, resetClock } from "@jevitate/domain";
import {
  armMissionKillSwitch,
  armedMissionCount,
  onMissionKilled,
  runWithMissionKillListener,
  setKillSwitchOutput,
  setKillSummary,
  watchParentDeath,
  __resetKillSwitchForTests,
  type KillSwitchDeps,
} from "./kill-signal.js";

/** A fake `KillSwitchDeps`: captures the registered handlers so a test can "fire" a signal without
 *  touching the real process, and records every call the handler makes so behavior is asserted
 *  precisely (no writeFileSync/process.exit ever runs in this file). */
function fakeDeps(opts: { transcript?: readonly TranscriptEntry[] } = {}) {
  const handlers: Record<string, () => void> = {};
  const calls: {
    exit: number[];
    closeBrowsers: number;
    writeResult: Array<Parameters<KillSwitchDeps["writeResult"]>>;
    writeStorageStateSnapshot: Array<[string, string]>;
  } = {
    exit: [],
    closeBrowsers: 0,
    writeResult: [],
    writeStorageStateSnapshot: [],
  };
  const deps: KillSwitchDeps = {
    exit: (code) => {
      calls.exit.push(code);
    },
    closeBrowsers: async () => {
      calls.closeBrowsers += 1;
    },
    writeResult: (recordingPath, missionOutcome, exitCode, result, usage) => {
      calls.writeResult.push([recordingPath, missionOutcome, exitCode, result, usage]);
      return `${recordingPath}.result.json`;
    },
    readTranscript: () => ({ steps: opts.transcript?.length ?? 0, transcript: opts.transcript ?? [] }),
    onSignal: (signal, handler) => {
      handlers[signal] = handler;
    },
    // #159: captured instead of touching the real filesystem (no writeFileSync in this file).
    writeStorageStateSnapshot: (path, json) => {
      calls.writeStorageStateSnapshot.push([path, json]);
    },
  };
  return { deps, handlers, calls };
}

beforeEach(() => {
  __resetKillSwitchForTests();
});

describe("kill-signal — crash-safe SIGTERM/SIGINT (#94)", () => {
  it("installs the handler once per signal, even across several armed missions", () => {
    const { deps, handlers } = fakeDeps();
    const onSignalCalls: string[] = [];
    const counting: KillSwitchDeps = {
      ...deps,
      onSignal: (signal, handler) => {
        onSignalCalls.push(signal);
        deps.onSignal(signal, handler);
      },
    };
    armMissionKillSwitch({ recordingPath: "/tmp/a.json" }, counting)();
    armMissionKillSwitch({ recordingPath: "/tmp/b.json" }, counting)();
    expect(onSignalCalls).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
    expect(handlers.SIGTERM).toBeTypeOf("function");
    expect(handlers.SIGINT).toBeTypeOf("function");
  });

  it("on SIGTERM: writes an inconclusive partial result from whatever the journal flushed, closes browsers, exits 143", async () => {
    const transcript: TranscriptEntry[] = [
      { step: 1, op: "click", target: "x", confidence: 0.9, chosenBy: "model", actOk: true, url: "http://x.test/", signature: "s1", controlCount: 1 },
      { step: 2, op: "click", target: "y", confidence: 0.9, chosenBy: "model", actOk: true, url: "http://x.test/", signature: "s2", controlCount: 1 },
    ];
    const { deps, handlers, calls } = fakeDeps({ transcript });
    armMissionKillSwitch({ recordingPath: "/tmp/explore-x.json" }, deps);
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(calls.closeBrowsers).toBe(1);
    expect(calls.writeResult).toHaveLength(1);
    const [recordingPath, missionOutcome, exitCode, result] = calls.writeResult[0]!;
    expect(recordingPath).toBe("/tmp/explore-x.json");
    expect(missionOutcome).toBe("inconclusive");
    expect(exitCode).toBe(143);
    expect(result).toMatchObject({
      outcome: "inconclusive",
      reason: "interrupted by SIGTERM after 2 steps",
      stop: "terminated",
      signal: "SIGTERM",
      transcript,
    });
  });

  it("on SIGINT: exits 130, and a run killed before its first step is an honest 0-step report", async () => {
    const { deps, handlers, calls } = fakeDeps({ transcript: [] });
    armMissionKillSwitch({ recordingPath: "/tmp/explore-y.json" }, deps);
    handlers.SIGINT?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([130]));
    expect(calls.writeResult[0]?.[3]).toMatchObject({ reason: "interrupted by SIGINT after 0 steps" });
  });

  it("a disarmed mission writes no result on a later signal, but the process still exits", async () => {
    const { deps, handlers, calls } = fakeDeps();
    const disarm = armMissionKillSwitch({ recordingPath: "/tmp/explore-z.json" }, deps);
    disarm();
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(calls.writeResult).toHaveLength(0);
  });

  it("is idempotent: a second signal force-exits immediately, without writing again or re-closing browsers", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch({ recordingPath: "/tmp/explore-w.json" }, deps);
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    // Escalation: the operator/wrapper sends a second signal (possibly SIGINT this time).
    handlers.SIGINT?.();
    expect(calls.exit).toEqual([143, 130]);
    expect(calls.writeResult).toHaveLength(1);
    expect(calls.closeBrowsers).toBe(1);
  });
});

describe("kill-signal — --save-storage-state on a kill (#159)", () => {
  it("writes each armed mission's last snapshot, synchronously, mode 0600 (via the injected writer)", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch(
      {
        recordingPath: "/out/a.json",
        transcript: () => [],
        storageState: { path: "/out/a.state.json", snapshot: () => '{"cookies":["a-good"],"origins":[]}' },
      },
      deps,
    );
    armMissionKillSwitch(
      {
        recordingPath: "/out/b.json",
        transcript: () => [],
        storageState: { path: "/out/b.state.json", snapshot: () => '{"cookies":["b-good"],"origins":[]}' },
      },
      deps,
    );
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(calls.writeStorageStateSnapshot).toEqual([
      ["/out/a.state.json", '{"cookies":["a-good"],"origins":[]}'],
      ["/out/b.state.json", '{"cookies":["b-good"],"origins":[]}'],
    ]);
  });

  it("writes nothing for a mission with no --save-storage-state (no `storageState` field at all)", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch({ recordingPath: "/out/a.json", transcript: () => [] }, deps);
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(calls.writeStorageStateSnapshot).toEqual([]);
  });

  it("writes nothing when no snapshot was ever safely captured yet (killed before the first settled step)", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch(
      {
        recordingPath: "/out/a.json",
        transcript: () => [],
        storageState: { path: "/out/a.state.json", snapshot: () => undefined },
      },
      deps,
    );
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(calls.writeStorageStateSnapshot).toEqual([]);
  });

  it("a throwing snapshot getter never blocks the flush or the exit — best-effort like every other field", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch(
      {
        recordingPath: "/out/a.json",
        transcript: () => [],
        storageState: {
          path: "/out/a.state.json",
          snapshot: () => {
            throw new Error("boom");
          },
        },
      },
      deps,
    );
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(calls.writeStorageStateSnapshot).toEqual([]);
    expect(calls.writeResult).toHaveLength(1);
  });

  it("defaults to a real synchronous writeFileSync, mode 0600, when no writer is injected", async () => {
    const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const outDir = await mkdtemp(join(tmpdir(), "jev-kill-storage-state-"));
    const path = join(outDir, "state.json");
    try {
      const { deps, handlers, calls } = fakeDeps();
      // No `writeStorageStateSnapshot` override this time — exercises the real default.
      const { writeStorageStateSnapshot: _omit, ...withoutWriter } = deps;
      armMissionKillSwitch(
        { recordingPath: "/out/a.json", transcript: () => [], storageState: { path, snapshot: () => '{"cookies":["real"],"origins":[]}' } },
        withoutWriter,
      );
      handlers.SIGTERM?.();
      await vi.waitFor(() => expect(calls.exit).toEqual([143]));
      expect(await readFile(path, "utf8")).toBe('{"cookies":["real"],"origins":[]}');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("kill-signal — the killed run's result describes the run (#120, #112)", () => {
  const entry = (step: number): TranscriptEntry => ({
    step,
    op: "click",
    target: "x",
    confidence: 0.9,
    chosenBy: "model",
    actOk: true,
    url: "http://x.test/",
    signature: `s${step}`,
    controlCount: 1,
  });
  const engine = { version: "1.2.3", commit: "abc1234", builtAt: "2026-09-24T00:00:00Z" };
  const HOST_HEALTH = {
    samples: 3,
    cores: 8,
    peakLoadPerCore: 2.6,
    minFreeMemoryBytes: 1e9,
    peakEventLoopLagMs: 40,
    slowestRenderMs: 900,
    baselineRenderMs: 300,
    steps: 5,
    degradedSteps: 4,
    degraded: true,
    starvation: ["load 2.60/core > 2"],
    attribution: "on" as const,
  };

  it("prefers the live step list over the file, and carries engine, usage-so-far, the real transcriptPath and a partial report", async () => {
    const { deps, handlers, calls } = fakeDeps({ transcript: [] });
    const readPaths: string[] = [];
    const live = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    armMissionKillSwitch(
      {
        recordingPath: "/out/usability-X.recording.json",
        transcriptPath: "/out/usability-X.transcript.json",
        transcript: () => live,
        usage: { snapshot: () => ({ judgments: 6, generations: 2, inputTokens: 900, outputTokens: 120 }) },
        partialReport: () => ({ screensObserved: 6 }),
        hostHealth: () => HOST_HEALTH,
      },
      {
        ...deps,
        engine: () => engine,
        readTranscript: (p) => {
          readPaths.push(p);
          return { steps: 0, transcript: [] };
        },
      },
    );
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(readPaths).toEqual([]); // the live list was used — no stale file read
    expect(calls.writeResult[0]?.[3]).toMatchObject({
      reason: "interrupted by SIGTERM after 5 steps",
      steps: 5,
      transcript: live,
      transcriptPath: "/out/usability-X.transcript.json",
      recordingPaths: ["/out/usability-X.recording.json"],
      resultPath: "/out/usability-X.recording.result.json",
      missionOutcome: "inconclusive",
      exitCode: 143,
      engine,
      usage: { judgments: 6, generations: 2, inputTokens: 900, outputTokens: 120 },
      partialReport: { screensObserved: 6 },
      // #203: a killed run's result carries the host's health so far, like every other result.
      hostHealth: HOST_HEALTH,
    });
  });

  it("#163: a killed run carries the full usage (Jev + generation) spent so far, and hands its calls to the sidecar", async () => {
    const { deps, handlers, calls } = fakeDeps({ transcript: [] });
    const tracker = new UsageTracker();
    tracker.recordJudgment({ inputTokens: 5, outputTokens: 0, usd: 9 }); // an earlier run's call: not this run's
    const run = tracker.scope();
    tracker.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
    tracker.recordGeneration({ inputTokens: 10, outputTokens: 10, usd: 0.02, model: "openai/gpt-4o-mini", task: "form.value" });
    armMissionKillSwitch({ recordingPath: "/out/explore-X.json", transcript: () => [], usage: run }, deps);
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    const [, , , result, ledger] = calls.writeResult[0]!;
    expect((result as { usage: { totalUsd: number } }).usage).toMatchObject({ judgments: 1, generations: 1, priced: "full" });
    expect((result as { usage: { totalUsd: number } }).usage.totalUsd).toBeCloseTo(0.042 + 0.02, 12);
    expect(ledger?.calls().map((c) => c.kind)).toEqual(["judgment", "generation"]);
  });

  it("without a live reference, reads the flushed transcript at the mission's own transcriptPath", async () => {
    const { deps, handlers, calls } = fakeDeps();
    const readPaths: string[] = [];
    armMissionKillSwitch(
      { recordingPath: "/out/usability-Y.recording.json", transcriptPath: "/out/usability-Y.transcript.json" },
      {
        ...deps,
        readTranscript: (p) => {
          readPaths.push(p);
          return { steps: 2, transcript: [entry(1), entry(2)] };
        },
      },
    );
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(readPaths).toEqual(["/out/usability-Y.transcript.json"]);
    expect(calls.writeResult[0]?.[3]).toMatchObject({ steps: 2, reason: "interrupted by SIGTERM after 2 steps" });
  });

  it("a throwing getter never blocks the flush or the exit", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch(
      {
        recordingPath: "/out/explore-Z.json",
        transcript: () => {
          throw new Error("boom");
        },
        usage: {
          snapshot: () => {
            throw new Error("boom");
          },
        },
      },
      deps,
    );
    handlers.SIGINT?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([130]));
    expect(calls.writeResult).toHaveLength(1);
    expect(calls.writeResult[0]?.[3]).not.toHaveProperty("usage");
  });

  it.each([
    ["envelope", (line: string) => expect(JSON.parse(line)).toMatchObject({ v: 1, ok: true, data: { outcome: "inconclusive", engine } })],
    // #210: without --json a killed run prints the human summary (verdict first, never raw JSON).
    ["human", (line: string) => expect(line).toMatch(/^INCONCLUSIVE: /)],
  ] as const)("prints the %s result to stdout before exiting", async (mode, check) => {
    const { deps, handlers, calls } = fakeDeps();
    const order: string[] = [];
    const out: string[] = [];
    setKillSwitchOutput(mode);
    armMissionKillSwitch(
      { recordingPath: "/out/explore-W.json" },
      {
        ...deps,
        engine: () => engine,
        writeStdout: (text) => {
          order.push("stdout");
          out.push(text);
        },
        exit: (code) => {
          order.push("exit");
          calls.exit.push(code);
        },
      },
    );
    handlers.SIGTERM?.();
    expect(order).toEqual(["stdout", "exit"]); // synchronous: printed in the same turn, before the exit
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith("\n")).toBe(true);
    check(out[0]!);
  });

  it("prints nothing when no output mode was set (a library caller owns stdout)", async () => {
    const { deps, handlers, calls } = fakeDeps();
    const out: string[] = [];
    armMissionKillSwitch({ recordingPath: "/out/explore-V.json" }, { ...deps, writeStdout: (t) => out.push(t) });
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([143]));
    expect(out).toEqual([]);
  });
});

describe("kill-signal — several missions in one process (shared browser pool)", () => {
  const entry = (step: number): TranscriptEntry => ({ step }) as unknown as TranscriptEntry;

  it("one signal flushes EVERY armed mission with its own steps, closes browsers once and exits once", async () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch({ recordingPath: "/out/a.json", transcript: () => [entry(1), entry(2)] }, deps);
    armMissionKillSwitch({ recordingPath: "/out/b.json", transcript: () => [entry(1)] }, deps);
    expect(armedMissionCount()).toBe(2);
    handlers.SIGTERM?.();
    await Promise.resolve();
    expect(calls.writeResult.map(([path]) => path)).toEqual(["/out/a.json", "/out/b.json"]);
    const reasons = calls.writeResult.map(([, , , result]) => (result as { reason: string }).reason);
    expect(reasons).toEqual(["interrupted by SIGTERM after 2 steps", "interrupted by SIGTERM after 1 step"]);
    expect(calls.closeBrowsers).toBe(1);
    expect(calls.exit).toEqual([143]);
    expect(armedMissionCount()).toBe(0);
  });

  it("disarming one mission leaves the others armed", async () => {
    const { deps, handlers, calls } = fakeDeps();
    const disarmA = armMissionKillSwitch({ recordingPath: "/out/a.json", transcript: () => [] }, deps);
    armMissionKillSwitch({ recordingPath: "/out/b.json", transcript: () => [] }, deps);
    disarmA();
    handlers.SIGINT?.();
    await Promise.resolve();
    expect(calls.writeResult.map(([path]) => path)).toEqual(["/out/b.json"]);
    expect(calls.exit).toEqual([130]);
  });

  it("a scoped listener hears only about the mission armed inside its own context; process-wide ones hear all", async () => {
    const { deps, handlers } = fakeDeps();
    const heardA: string[] = [];
    const heardB: string[] = [];
    const heardAll: string[] = [];
    onMissionKilled(({ resultPath }) => heardAll.push(resultPath));
    let releaseA!: () => void;
    let releaseB!: () => void;
    const runA = runWithMissionKillListener(
      ({ resultPath }) => heardA.push(resultPath),
      async () => {
        await Promise.resolve();
        armMissionKillSwitch({ recordingPath: "/out/a.json", transcript: () => [] }, deps);
        await new Promise<void>((r) => (releaseA = r));
      },
    );
    const runB = runWithMissionKillListener(
      ({ resultPath }) => heardB.push(resultPath),
      async () => {
        await Promise.resolve();
        armMissionKillSwitch({ recordingPath: "/out/b.json", transcript: () => [] }, deps);
        await new Promise<void>((r) => (releaseB = r));
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(armedMissionCount()).toBe(2);
    handlers.SIGTERM?.();
    expect(heardA).toEqual(["/out/a.json.result.json"]);
    expect(heardB).toEqual(["/out/b.json.result.json"]);
    expect(heardAll).toEqual(["/out/a.json.result.json", "/out/b.json.result.json"]);
    releaseA();
    releaseB();
    await Promise.all([runA, runB]);
  });

  it("a failed flush of one mission never keeps the others from being flushed", async () => {
    const { deps, handlers, calls } = fakeDeps();
    const failing: KillSwitchDeps = {
      ...deps,
      writeResult: (recordingPath, missionOutcome, exitCode, result) => {
        if (recordingPath === "/out/a.json") throw new Error("disk full");
        return deps.writeResult(recordingPath, missionOutcome, exitCode, result);
      },
    };
    armMissionKillSwitch({ recordingPath: "/out/a.json", transcript: () => [] }, failing);
    armMissionKillSwitch({ recordingPath: "/out/b.json", transcript: () => [] }, failing);
    handlers.SIGTERM?.();
    await Promise.resolve();
    expect(calls.writeResult.map(([path]) => path)).toEqual(["/out/b.json"]);
    expect(calls.exit).toEqual([143]);
  });
});

describe("kill-signal — the killed partial is a unified result; an orchestrator reports the kill itself (#220)", () => {
  it("the partial carries strategy, canonical missionOutcome and every common field: it parses as a MissionResult", async () => {
    const { deps, handlers, calls } = fakeDeps();
    deps.engine = () => ({ version: "0.0.0", commit: "abc1234", builtAt: "2026-01-01T00:00:00.000Z" });
    armMissionKillSwitch(
      { recordingPath: "/tmp/explore-s.json", strategy: "goal", target: { seedUrl: "http://x.test/", allowlist: ["http://x.test"] } },
      deps,
    );
    handlers.SIGINT?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([130]));
    const [, missionOutcome, exitCode, result] = calls.writeResult[0]!;
    const parsed = MissionResultSchema.parse(result);
    expect(parsed).toMatchObject({ strategy: "goal", missionOutcome: "inconclusive", goalOutcome: "inconclusive", exitCode: 130, recordingPaths: ["/tmp/explore-s.json"] });
    expect(PersistedMissionResultSchema.safeParse({ missionOutcome, exitCode, result }).success).toBe(true);
  });

  it("with a kill summary installed: it is told every killed mission, its text replaces the per-mission output, and it runs even with no mission armed", async () => {
    const { deps, handlers, calls } = fakeDeps();
    const out: string[] = [];
    deps.writeStdout = (t) => out.push(t);
    setKillSwitchOutput("envelope");
    const seen: Array<{ signal: string; exitCode: number; missions: number }> = [];
    const remove = setKillSummary(({ signal, exitCode, missions }) => {
      seen.push({ signal, exitCode, missions: missions.length });
      return `SUMMARY ${missions.map((m) => String(m.partial.missionOutcome)).join(",")}\n`;
    });
    armMissionKillSwitch({ recordingPath: "/tmp/run-2.json", strategy: "goal" }, deps);
    handlers.SIGINT?.();
    await vi.waitFor(() => expect(calls.exit).toEqual([130]));
    expect(seen).toEqual([{ signal: "SIGINT", exitCode: 130, missions: 1 }]);
    expect(out).toEqual(["SUMMARY inconclusive\n"]); // not the run's own envelope
    remove();

    // Between two runs (nothing armed): the summary still reports the orchestrator's partial.
    __resetKillSwitchForTests();
    const second = fakeDeps();
    const out2: string[] = [];
    second.deps.writeStdout = (t) => out2.push(t);
    setKillSummary(({ missions }) => `BETWEEN ${missions.length}\n`);
    armMissionKillSwitch({ recordingPath: "/tmp/r.json" }, second.deps)(); // installs, then disarms
    second.handlers.SIGTERM?.();
    await vi.waitFor(() => expect(second.calls.exit).toEqual([143]));
    expect(out2).toEqual(["BETWEEN 0\n"]);
  });
});

describe("kill-signal — no browser outlives the CLI (#326)", () => {
  it("terminates this process's browsers synchronously, after the result is written and before the exit", () => {
    const { deps, handlers, calls } = fakeDeps();
    const order: string[] = [];
    const tracking: KillSwitchDeps = {
      ...deps,
      writeResult: (...args) => {
        order.push("write");
        return deps.writeResult(...args);
      },
      terminateBrowsers: () => {
        order.push("terminate");
      },
      exit: (code) => {
        order.push("exit");
        deps.exit(code);
      },
    };
    armMissionKillSwitch({ recordingPath: "/tmp/explore-t.json" }, tracking);
    handlers.SIGTERM?.();
    // Synchronous: everything happened in the signal's own turn, nothing awaited.
    expect(order).toEqual(["write", "terminate", "exit"]);
    expect(calls.exit).toEqual([143]);
  });

  it("a teardown that throws never keeps the process from exiting", () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch(
      { recordingPath: "/tmp/explore-u.json" },
      {
        ...deps,
        terminateBrowsers: () => {
          throw new Error("boom");
        },
      },
    );
    handlers.SIGTERM?.();
    expect(calls.exit).toEqual([143]);
    expect(calls.writeResult).toHaveLength(1);
  });

  it("on SIGHUP: writes the partial result and exits 129", () => {
    const { deps, handlers, calls } = fakeDeps();
    armMissionKillSwitch({ recordingPath: "/tmp/explore-h.json" }, deps);
    handlers.SIGHUP?.();
    expect(calls.exit).toEqual([129]);
    expect(calls.writeResult[0]?.[3]).toMatchObject({ reason: "interrupted by SIGHUP after 0 steps", signal: "SIGHUP", exitCode: 129 });
  });

  it("the parent's death ends the run like a SIGHUP", () => {
    const { deps, calls } = fakeDeps();
    let parentGone: (() => void) | undefined;
    armMissionKillSwitch({ recordingPath: "/tmp/explore-p.json" }, { ...deps, watchParent: (onGone) => (parentGone = onGone) });
    expect(parentGone).toBeTypeOf("function");
    parentGone?.();
    expect(calls.exit).toEqual([129]);
    expect(calls.writeResult).toHaveLength(1);
  });
});

describe("watchParentDeath (#326)", () => {
  beforeEach(() => () => resetClock());

  it("polls on the installed clock: unchanged parent → nothing; changed → onGone exactly once", async () => {
    const fake = new FakeClock();
    installClock(fake);
    let ppid = 4242;
    let gone = 0;
    watchParentDeath(() => (gone += 1), { ppid: () => ppid, platform: "linux", env: {}, intervalMs: 1000 });
    await fake.advanceBy(3000);
    expect(gone).toBe(0);
    ppid = 1;
    await fake.advanceBy(1000);
    expect(gone).toBe(1);
    ppid = 7;
    await fake.advanceBy(5000);
    expect(gone).toBe(1);
  });

  it("is off on Windows, with JEVITATE_PARENT_WATCHDOG=off, and with no real parent", () => {
    const never = () => {
      throw new Error("must not fire");
    };
    expect(watchParentDeath(never, { ppid: () => 4242, platform: "win32", env: {} })).toBeUndefined();
    expect(watchParentDeath(never, { ppid: () => 4242, platform: "linux", env: { JEVITATE_PARENT_WATCHDOG: "off" } })).toBeUndefined();
    expect(watchParentDeath(never, { ppid: () => 1, platform: "linux", env: {} })).toBeUndefined();
  });
});
