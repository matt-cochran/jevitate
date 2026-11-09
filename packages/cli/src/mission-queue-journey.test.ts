import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import type { QueuedJourneyCall } from "@jevitate/missions";
import { JourneyRunRefusedError } from "@jevitate/mcp-facade";
import type { GuardedJourneyDecision, GuardedJourneyRequest } from "./journey-run-mode-gate.js";

const calls: { req: Omit<GuardedJourneyRequest<unknown>, "run">; decision: GuardedJourneyDecision | undefined }[] = [];

// A spy on the shared function: the real one runs, and what it was given and decided is recorded.
vi.mock("./journey-run-mode-gate.js", async (orig) => {
  const actual = await orig<typeof import("./journey-run-mode-gate.js")>();
  return {
    ...actual,
    runGuardedJourney: vi.fn(<T>(req: GuardedJourneyRequest<T>) => {
      const { run, ...rest } = req;
      return actual.runGuardedJourney({
        ...req,
        run: (decision) => {
          calls.push({ req: rest, decision });
          return run(decision);
        },
      });
    }),
  };
});

const { runGuardedJourney } = await import("./journey-run-mode-gate.js");
const { runQueuedJourneyCall } = await import("./mission-queue-runner.js");
const { buildMcpTools } = await import("./mcp-api.js");
const { journeyReviewHash } = await import("./journey-review.js");

let root: string;
let journeysDir: string;
let targetsFile: string;

const journey = (): Journey =>
  ({
    metadata: { id: "notes", name: "notes", promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00.000Z" },
    recording: { version: "1", site: "http://127.0.0.1:9", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "note" } } } }] }] },
  }) as Journey;

const approved = (j: Journey): Journey => ({
  ...j,
  metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } },
}) as Journey;

const seed = (j: Journey): void => writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jev-797-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  targetsFile = join(root, "targets.json");
  writeFileSync(targetsFile, "{}");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("#797 a queued Journey call and run_journey share runGuardedJourney", () => {
  it("goes through the same function with the same guard arguments", async () => {
    const j = approved(journey());
    seed(j);
    calls.length = 0;
    vi.mocked(runGuardedJourney).mockClear();
    const call: QueuedJourneyCall = { kind: "journey", journey: { id: "notes", hash: journeyReviewHash(j) }, requestedAt: "2026-11-09T00:00:00Z" };
    await runQueuedJourneyCall(call, { journeysDir, targetsFile, run: async () => "ran" });
    const sentinel = new Error("no browser in this test");
    const tool = buildMcpTools({ journeysDir, pathRoots: [root], targetsConfigPath: targetsFile, browserPortFactory: () => ({ open: async () => { throw sentinel; } }) as never }).find((t) => t.name === "run_journey")!;
    await tool.handler({ id: "notes" }).catch(() => undefined);

    expect(vi.mocked(runGuardedJourney)).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    const [queued, direct] = calls;
    expect(queued!.req).toMatchObject({ journeysDir, id: "notes", targetsFile });
    expect({ ...queued!.req, expectedHash: undefined }).toEqual({ ...direct!.req, expectedHash: undefined });
    expect(queued!.decision?.guardRequest).toEqual(direct!.decision?.guardRequest);
    expect(queued!.decision?.target.mode).toBe(direct!.decision?.target.mode);
  });

  it("refuses a call whose Journey changed since it was queued, with the stale-approval code, before the run", async () => {
    const j = approved(journey());
    seed(j);
    const run = vi.fn(async () => "ran");
    const call: QueuedJourneyCall = { kind: "journey", journey: { id: "notes", hash: "queued-against-an-older-hash" }, requestedAt: "2026-11-09T00:00:00Z" };
    await expect(runQueuedJourneyCall(call, { journeysDir, targetsFile, run })).rejects.toMatchObject({ code: "E_JOURNEY_APPROVAL_STALE" });
    await expect(runQueuedJourneyCall(call, { journeysDir, targetsFile, run })).rejects.toBeInstanceOf(JourneyRunRefusedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an unpromoted Journey like run_journey does", async () => {
    seed(journey());
    const run = vi.fn(async () => "ran");
    const call: QueuedJourneyCall = { kind: "journey", journey: { id: "notes", hash: "h" }, requestedAt: "2026-11-09T00:00:00Z" };
    await expect(runQueuedJourneyCall(call, { journeysDir, targetsFile, run })).rejects.toMatchObject({ code: "E_JOURNEY_NOT_PROMOTED" });
    expect(run).not.toHaveBeenCalled();
  });
});
