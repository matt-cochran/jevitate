import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvariantSpecError } from "@jevitate/recording";
import {
  FsMissionQueueStore,
  FsMissionTargetStore,
  MissionTargetRegistry,
  type MissionTarget,
  type QueuedMission,
} from "@jevitate/missions";
import { __resetKillSwitchForTests, armMissionKillSwitch } from "./kill-signal.js";
import {
  drainMissionQueue,
  needsModel,
  realQueuedMissionExecutor,
  resultIdFromPath,
  type QueuedMissionExecutor,
} from "./mission-queue-runner.js";

const target: MissionTarget = {
  id: "spa",
  name: "SPA",
  authorizedOrigin: "https://app.example.com",
  apiOrigins: ["https://api.example.com"],
  baseUrl: "https://app.example.com/settings",
  promoted: true,
  createdAtIso: "2026-09-24T00:00:00Z",
};
const allowlist = ["https://app.example.com", "https://api.example.com"];

function mission(req: Partial<QueuedMission>): QueuedMission {
  return {
    id: "549db40a-cd30-4706-b7f5-01ddea8f6d1f",
    target: "spa",
    strategy: "goal-based",
    budget: { maxActions: 5, maxDecisions: 10, maxCandidates: 50 },
    status: "running",
    enqueuedAtIso: "2026-09-24T00:00:00Z",
    ...req,
  } as QueuedMission;
}

/** No browser, no gateway: every refusal below must happen before either is touched. */
function executor() {
  let gatewayCalls = 0;
  let browserOpens = 0;
  const execute = realQueuedMissionExecutor({
    outDir: "/nonexistent-out",
    gateways: async () => {
      gatewayCalls += 1;
      throw new Error("gateways must not be built");
    },
    browserPortFactory: () => {
      browserOpens += 1;
      throw new Error("a browser must not open");
    },
  });
  return { execute, counts: () => ({ gatewayCalls, browserOpens }) };
}

describe("mission queue runner (#117)", () => {
  it("resultIdFromPath: the stem get_mission_result takes", () => {
    expect(resultIdFromPath("/r/explore-2026-09-24T00-00-00-000Z.result.json")).toBe("explore-2026-09-24T00-00-00-000Z");
    expect(resultIdFromPath("/r/usability-2026-09-24T00-00-00-000Z.recording.result.json")).toBe(
      "usability-2026-09-24T00-00-00-000Z.recording",
    );
  });

  it("needsModel: every strategy but the model-free feature mission", () => {
    expect(needsModel(mission({ strategy: "goal-based", goal: "g" }))).toBe(true);
    expect(needsModel(mission({ strategy: "coverage" }))).toBe(true);
    expect(needsModel(mission({ strategy: "adversarial" }))).toBe(true);
    expect(needsModel(mission({ strategy: "feature", feature: "billing" }))).toBe(false);
    expect(needsModel(mission({ strategy: "goal-based", feature: "billing" }))).toBe(false);
  });

  it("a route-only goal-based mission has no runner: refused, never guessed", async () => {
    const { execute, counts } = executor();
    await expect(execute({ mission: mission({ route: "/settings" }), target, allowlist })).rejects.toThrow(/no runner/);
    expect(counts()).toEqual({ gatewayCalls: 0, browserOpens: 0 });
  });

  it("a mission killed mid-run is recorded done-with-its-partial-result in the same synchronous turn, never left running", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-drain-kill-"));
    const queue = new FsMissionQueueStore(join(root, "queue"));
    const store = new FsMissionTargetStore(join(root, "targets"));
    await store.put(target);
    await queue.enqueue(mission({ strategy: "feature", feature: "billing", status: "queued" }));
    __resetKillSwitchForTests();
    const handlers: Record<string, () => void> = {};
    let seenAtKill: unknown;
    const execute: QueuedMissionExecutor = async () => {
      armMissionKillSwitch(
        { recordingPath: join(root, "feature-2026-09-24T00-00-00-000Z.json") },
        {
          exit: () => {
            // The process would exit here: capture the queue record exactly as it is on disk now.
            seenAtKill = JSON.parse(readFileSync(join(root, "queue", `${mission({}).id}.json`), "utf8"));
          },
          closeBrowsers: async () => {},
          writeResult: (p) => p.replace(/\.json$/, ".result.json"),
          readTranscript: () => ({ steps: 0, transcript: [] }),
          onSignal: (signal, handler) => {
            handlers[signal] = handler;
          },
        },
      );
      handlers.SIGTERM?.();
      throw new Error("the page closed under the mission");
    };
    await drainMissionQueue({ queue, targets: new MissionTargetRegistry(store), execute });
    expect(seenAtKill).toMatchObject({
      status: "done",
      resultId: "feature-2026-09-24T00-00-00-000Z",
      missionOutcome: "inconclusive",
      exitCode: 143,
    });
    __resetKillSwitchForTests();
  });

  it("re-checks declared invariants against the target's CURRENT origins before anything runs", async () => {
    const { execute, counts } = executor();
    const invariants = {
      observe: { total: { probe: { get: "https://evil.example.com/v1/count", json: "$.n" } } },
      invariants: [{ id: "x", always: "total >= 0" }],
    } as unknown as QueuedMission["invariants"];
    await expect(
      execute({ mission: mission({ strategy: "coverage", invariants }), target, allowlist }),
    ).rejects.toBeInstanceOf(InvariantSpecError);
    expect(counts()).toEqual({ gatewayCalls: 0, browserOpens: 0 });
  });
});
