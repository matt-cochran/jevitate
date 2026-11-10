import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import { FsJourneyCallQueueStore, FsMissionQueueStore, type QueuedJourneyRecord } from "@jevitate/missions";
import { drainMissionQueue, realQueuedJourneyExecutor, type QueuedJourneyExecutor } from "./mission-queue-runner.js";
import { journeyReviewHash } from "./journey-review.js";
import { buildMcpTools } from "./mcp-api.js";

/**
 * M1: a hand-edited queue file that carries a value for a parameter the Journey declares secret (a name
 * the schema's isSecretName check does not catch) is refused at drain time, E_SECRET_PARAM_IN_QUEUE,
 * before any browser. M2: a drained call's error is masked before it is stored and when it is returned.
 */

const VALUE = "QueueSecretVal9Zq";
let root: string;
let journeysDir: string;
let queueDir: string;
let targetsFile: string;
let seq = 0;

function journey(): Journey {
  const j = {
    metadata: { id: "answer", name: "answer", promoted: true, params: ["answer"], parameters: [{ name: "answer", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: "http://127.0.0.1:9",
      pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "a" } } } }, { step: { kind: "fill", target: { testId: "a" }, value: { var: "answer" }, expect: { kind: "visible", target: { testId: "a" } } } }] }],
    },
  } as unknown as Journey;
  j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } as never;
  return j;
}

/** A call written into the queue directory by hand, past the queue tool's refusal. */
async function queued(params: Record<string, string>): Promise<string> {
  const id = `journey-00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const record: QueuedJourneyRecord = {
    id,
    status: "queued",
    enqueuedAtIso: "2026-11-09T00:00:00.000Z",
    call: { kind: "journey", journey: { id: "answer", hash: journeyReviewHash(journey()) }, params, requestedAt: "2026-11-09T00:00:00.000Z" },
  };
  await new FsJourneyCallQueueStore(queueDir).enqueue(record);
  return id;
}

const drain = (execute: QueuedJourneyExecutor) =>
  drainMissionQueue({
    queue: new FsMissionQueueStore(join(root, "missions")),
    targets: { resolve: async () => { throw new Error("no missions here"); } } as never,
    execute: async () => { throw new Error("no missions here"); },
    journeyCalls: { store: new FsJourneyCallQueueStore(queueDir), execute },
  });

function filesHolding(value: string): string[] {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(root).filter((f) => readFileSync(f).includes(value));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jev-m1m2-"));
  journeysDir = join(root, "journeys");
  queueDir = join(root, "queue");
  mkdirSync(journeysDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });
  targetsFile = join(root, "targets.json");
  writeFileSync(targetsFile, "{}");
  writeFileSync(join(journeysDir, "answer.json"), JSON.stringify(journey()));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("M1: the drain re-checks a queued call's params against the Journey's declared secrets", () => {
  it("a declared-secret value in a hand-edited queue file is refused E_SECRET_PARAM_IN_QUEUE, no browser, the value never echoed", async () => {
    const id = await queued({ answer: VALUE });
    let opens = 0;
    const execute = realQueuedJourneyExecutor({ journeysDir, targetsFile, logsRoot: join(root, "logs"), browserPortFactory: () => ({ open: async () => { opens += 1; throw new Error("no browser"); } }) as never });
    const report = await drain(execute);
    expect(opens).toBe(0);
    const stored = await new FsJourneyCallQueueStore(queueDir).get(id);
    expect(stored).toMatchObject({ status: "failed", code: "E_SECRET_PARAM_IN_QUEUE" });
    expect(stored?.error).toContain("answer");
    expect(JSON.stringify(report)).not.toContain(VALUE);
    expect(stored?.error).not.toContain(VALUE);
  });
});

describe("M2: a drained call's error is masked before it is stored and when it is returned", () => {
  const LEAK = `navigate to https://app.example/cb?token=${VALUE} failed; password: ${VALUE}`;

  it("stored masked", async () => {
    const id = await queued({});
    await drain(async () => { throw new Error(LEAK); });
    const stored = await new FsJourneyCallQueueStore(queueDir).get(id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("«redacted»");
    expect(stored?.error).not.toContain(VALUE);
  });

  it("an older record, stored unmasked, is masked when get_mission_result returns it", async () => {
    const id = `journey-00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    await new FsJourneyCallQueueStore(queueDir).enqueue({ id, status: "failed", enqueuedAtIso: "2026-11-09T00:00:00.000Z", finishedAtIso: "2026-11-09T00:00:01.000Z", error: LEAK, call: { kind: "journey", journey: { id: "answer", hash: "h" }, requestedAt: "2026-11-09T00:00:00.000Z" } });
    const tool = buildMcpTools({ journeysDir, missionQueueDir: queueDir }).find((t) => t.name === "get_mission_result")!;
    const r = await tool.handler({ id });
    expect(r.content[0]!.text).not.toContain(VALUE);
    expect(filesHolding(VALUE).length).toBeGreaterThan(0); // only the hand-planted older record holds it
  });
});
