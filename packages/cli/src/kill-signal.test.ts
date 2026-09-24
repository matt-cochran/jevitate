import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@jevitate/explore";
import {
  armMissionKillSwitch,
  armedMissionCount,
  onMissionKilled,
  runWithMissionKillListener,
  setKillSwitchOutput,
  __resetKillSwitchForTests,
  type KillSwitchDeps,
} from "./kill-signal.js";

/** A fake `KillSwitchDeps`: captures the registered handlers so a test can "fire" a signal without
 *  touching the real process, and records every call the handler makes so behavior is asserted
 *  precisely (no writeFileSync/process.exit ever runs in this file). */
function fakeDeps(opts: { transcript?: readonly TranscriptEntry[] } = {}) {
  const handlers: Record<string, () => void> = {};
  const calls: { exit: number[]; closeBrowsers: number; writeResult: Array<Parameters<KillSwitchDeps["writeResult"]>> } = {
    exit: [],
    closeBrowsers: 0,
    writeResult: [],
  };
  const deps: KillSwitchDeps = {
    exit: (code) => {
      calls.exit.push(code);
    },
    closeBrowsers: async () => {
      calls.closeBrowsers += 1;
    },
    writeResult: (recordingPath, missionOutcome, exitCode, result) => {
      calls.writeResult.push([recordingPath, missionOutcome, exitCode, result]);
      return `${recordingPath}.result.json`;
    },
    readTranscript: () => ({ steps: opts.transcript?.length ?? 0, transcript: opts.transcript ?? [] }),
    onSignal: (signal, handler) => {
      handlers[signal] = handler;
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
    expect(onSignalCalls).toEqual(["SIGTERM", "SIGINT"]);
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
      recordingPath: "/out/usability-X.recording.json",
      resultPath: "/out/usability-X.recording.result.json",
      missionOutcome: "inconclusive",
      exitCode: 143,
      engine,
      usage: { judgments: 6, generations: 2, inputTokens: 900, outputTokens: 120 },
      partialReport: { screensObserved: 6 },
    });
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
    ["raw", (line: string) => expect(JSON.parse(line)).toMatchObject({ outcome: "inconclusive", engine })],
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
