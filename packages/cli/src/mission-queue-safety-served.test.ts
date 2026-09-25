import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway, UsageTracker } from "@jevitate/ai-core";
import { FsMissionQueueStore, FsMissionTargetStore, MissionTargetRegistry, type MissionTarget, type QueuedMission } from "@jevitate/missions";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { drainMissionQueue, realQueuedMissionExecutor } from "./mission-queue-runner.js";

/**
 * Surface-wiring audit: the operator's targets.json safety (`deny`) holds for a QUEUED mission (what
 * MCP `queue_exploration` feeds `jevitate mission run`) exactly as for `explore` on the CLI. Before,
 * the queue never passed the target config: a queued feature or coverage mission clicked a control
 * the operator had denied. "Export CSV" is in no built-in category — only the `--deny` pattern
 * protects it. Real Chromium, served locally.
 */
let server: Server;
let origin: string;
let exports = 0;

const APP = `<!doctype html><html><body>
  <h1>Reports</h1>
  <button type="button" onclick="fetch('/api/export',{method:'POST'});document.getElementById('s').textContent='Export queued'">Export CSV</button>
  <button type="button" onclick="document.getElementById('d').hidden=!document.getElementById('d').hidden">Show details</button>
  <p id="s">Ready</p><p id="d" hidden>Quarterly totals</p>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "POST" && path === "/api/export") {
      exports += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(path === "/reports" ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(path === "/reports" ? APP : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const queued = (id: string, strategy: "feature" | "coverage"): QueuedMission =>
  ({
    id,
    target: "reports",
    strategy,
    ...(strategy === "feature" ? { feature: "reports" } : {}),
    budget: { maxActions: 6, maxDecisions: 10, maxCandidates: 20 },
    status: "queued",
    enqueuedAtIso: "2026-09-25T00:00:00Z",
  }) as QueuedMission;

describe("targets.json safety reaches queued missions (surface-wiring audit)", () => {
  it("a queued feature and coverage mission never click a control the operator denied", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-queue-safety-"));
    exports = 0;
    try {
      const target: MissionTarget = {
        id: "reports",
        name: "Reports",
        authorizedOrigin: origin,
        baseUrl: `${origin}/reports`,
        promoted: true,
        createdAtIso: "2026-09-25T00:00:00Z",
      };
      const store = new FsMissionTargetStore(join(root, "targets"));
      await store.put(target);
      const queue = new FsMissionQueueStore(join(root, "queue"));
      await queue.enqueue(queued("11111111-1111-4111-8111-111111111111", "feature"));
      await queue.enqueue(queued("22222222-2222-4222-8222-222222222222", "coverage"));
      const execute = realQueuedMissionExecutor({
        outDir: join(root, "out"),
        gateways: async () => ({
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          gen: new FakeGenerationGateway(),
          usage: new UsageTracker(),
        }),
        browserPortFactory: () => new PlaywrightBrowserPort(),
        targets: { [origin]: { safety: { deny: ["/^Export/"] } } },
      });

      const report = await drainMissionQueue({ queue, targets: new MissionTargetRegistry(store), execute });

      expect(report.ran.map((m) => m.status)).toEqual(["done", "done"]);
      expect(exports).toBe(0);
      for (const m of report.ran) {
        type Entry = { strategy?: string; reason?: string };
        const { result } = JSON.parse(readFileSync(join(root, "out", `${m.resultId ?? ""}.result.json`), "utf8")) as {
          result: { transcript?: Entry[]; transcriptPath?: string };
        };
        const transcript = result.transcript ?? (JSON.parse(readFileSync(result.transcriptPath ?? "", "utf8")) as Entry[]);
        const refusals = transcript.filter((e) => e.strategy === "safety-policy");
        expect(refusals.map((e) => e.reason)).toEqual([expect.stringMatching(/"Export CSV" matches --deny/)]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
