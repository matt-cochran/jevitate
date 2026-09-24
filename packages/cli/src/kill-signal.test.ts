import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@jevitate/explore";
import { armMissionKillSwitch, __resetKillSwitchForTests, type KillSwitchDeps } from "./kill-signal.js";

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
