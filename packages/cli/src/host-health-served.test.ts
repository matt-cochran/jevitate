import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { HostHealthSampler, type HostPressure } from "@jevitate/explore";
import { MissionResultSchema } from "@jevitate/domain";
import { runCoverageMission, runExploration } from "./explore-api.js";

/**
 * #203 — a starved host is told apart from app findings, end to end: REAL Chromium against a served
 * page whose only controls never become clickable (they animate forever, so Playwright's actionability
 * wait times out), and a DETERMINISTIC fake host injected through the runner's host-health seam.
 *
 *  - On a starved host, the goal run's click timeouts are `environment-degraded` (advisory) and the
 *    run — every step of it starved — is `inconclusive` (degraded-environment), never a pass/fail.
 *  - On a calm host, the coverage frontier that emptied only because its actions timed out is
 *    `insufficient-coverage` (#209: one name — it was `insufficient-exploration`), never `exhausted` (and never `clean`).
 *  - Both results carry `hostHealth` and validate against the unified result schema.
 */
const PAGE = `<!doctype html><html><head><style>
  @keyframes wobble { from { transform: translateX(0) } to { transform: translateX(40px) } }
  button { animation: wobble 0.2s linear infinite alternate; }
</style></head><body><main><h1>Moving targets</h1>
  <button type="button">Alpha</button> <button type="button">Beta</button>
</main></body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/moving") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const GB = 1024 ** 3;
/**
 * The fake host's clock is frozen. With background sampling off (`intervalMs: 0`) the sampler only
 * samples at start, at `judge()` and at the end, and a step counts as starved only when a starved
 * sample lies inside `STARVATION_WINDOW_MS` (15 s) of NOW. On the wall clock, a run that took longer
 * than 15 s on a loaded test host (browser launch + click-timeout steps) left its later steps outside
 * the window — counted healthy — so "every step starved" failed under load ~20+. Time is part of the
 * fake host: the window is judged on it, never on how fast the real machine ran the test.
 */
const fakeHost = (host: HostPressure): HostHealthSampler =>
  new HostHealthSampler({ probe: async () => host, eventLoopLagMs: () => 2, intervalMs: 0, attribute: true, cores: 4, now: () => 0 });
const STARVED: HostPressure = { sample: { memAvailableBytes: 6 * GB, source: "test" }, overThreshold: null, loadPerCore: 3.5 };
const CALM: HostPressure = { sample: { memAvailableBytes: 6 * GB, source: "test" }, overThreshold: null, loadPerCore: 0.3 };

/** Always clicks the first control (never `done`), so every decision is a real — timing-out — click. */
const clickFirst: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
      else out[key] = { kind: "choice", value: q.options.find((o) => o.startsWith("click")) ?? q.options[0] ?? "", confidence: 0.9 };
    }
    return out;
  },
};

describe("a starved host is told apart from app findings (#203)", () => {
  it(
    "goal on a starved host: click timeouts are environment-degraded and the run is inconclusive (degraded-environment)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-host-starved-"));
      try {
        const r = await runExploration({
          url: `${origin}/moving`,
          goal: "open Alpha",
          allowlist: [origin],
          judge: clickFirst,
          gen: new FakeGenerationGateway({}),
          successAssertion: { kind: "urlIncludes", text: "/never" },
          bounds: { maxDecisions: 2, maxActions: 2 },
          outDir,
          hostHealth: fakeHost(STARVED),
        });
        expect(r.missionOutcome).toBe("inconclusive");
        expect(r.exitCode).toBe(2);
        expect(r.failure?.kind).toBe("degraded-environment");
        expect(r.hangs).toEqual([]);
        expect(r.environmentDegraded.length).toBeGreaterThan(0);
        expect(r.environmentDegraded.every((f) => f.advisory && f.cause === "load 3.50/core > 2")).toBe(true);
        expect(r.environmentDegraded.some((f) => f.finding === "click-timeout" && /timeout/i.test(f.detail))).toBe(true);
        expect(r.hostHealth).toMatchObject({ peakLoadPerCore: 3.5, minFreeMemoryBytes: 6 * GB, degraded: true, attribution: "on" });
        expect(r.hostHealth.degradedSteps).toBe(r.hostHealth.steps);
        expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "#213: a goal whose success check did not hold on a starved host is inconclusive, and still names the check",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-host-starved-failed-"));
      /** Proposes `done` at once and answers the goal question yes: the run ends on the check. */
      const doneAtOnce: JudgmentPort = {
        async systemOne({ questions }) {
          const out: Record<string, Answer> = {};
          for (const [key, q] of Object.entries(questions)) {
            if (q.kind === "noul") out[key] = { kind: "noul", value: true, probability: 0.95 };
            else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
            else out[key] = { kind: "choice", value: q.options.includes("done") ? "done" : (q.options[0] ?? ""), confidence: 0.9 };
          }
          return out;
        },
      };
      try {
        const r = await runExploration({
          url: `${origin}/moving`,
          goal: "open Alpha",
          allowlist: [origin],
          judge: doneAtOnce,
          gen: new FakeGenerationGateway({}),
          successAssertion: { kind: "urlIncludes", text: "/never" },
          bounds: { maxDecisions: 2, maxActions: 2 },
          outDir,
          hostHealth: fakeHost(STARVED),
        });
        expect(r.missionOutcome).toBe("inconclusive");
        expect(r.failure?.kind).toBe("degraded-environment");
        // One sentence with the peak readings, then what the run would have ended as — the check named.
        expect(r.failure?.message).toMatch(/^\d+\/\d+ steps ran on a starved host \(peak load 3\.50?\/core.*\), so the run proves nothing about the app; otherwise it would have ended \w+: .*urlIncludes:\/never did not hold/);
        expect(r.failure?.message).not.toMatch(/degraded-environment —/);
        expect(r.checks?.some((c) => !c.passed)).toBe(true);
        expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "coverage on a calm host: a frontier drained by timed-out actions is insufficient-coverage, never exhausted",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-host-drained-"));
      try {
        const r = await runCoverageMission({
          url: `${origin}/moving`,
          allowlist: [origin],
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          gen: new FakeGenerationGateway(),
          outDir,
          hostHealth: fakeHost(CALM),
        });
        // #209: renamed from `insufficient-exploration` — one outcome, one name.
        expect(r.outcome).toBe("insufficient-coverage");
        expect(r.missionOutcome).toBe("inconclusive");
        expect(r.failure?.kind).toBe("insufficient-coverage");
        expect(r.coverage.timedOutActions).toBe(2);
        expect(r.coverage.transitionsExercised).toBe(0);
        // A calm host: the timeouts are the page's own, not the environment's.
        expect(r.environmentDegraded).toEqual([]);
        expect(r.hostHealth).toMatchObject({ peakLoadPerCore: 0.3, degraded: false, degradedSteps: 0, attribution: "on" });
        expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
