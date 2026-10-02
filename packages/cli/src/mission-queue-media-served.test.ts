import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway, UsageTracker } from "@jevitate/ai-core";
import { FsMissionQueueStore, FsMissionTargetStore, MissionTargetRegistry, type MissionTarget } from "@jevitate/missions";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { drainMissionQueue, realQueuedMissionExecutor } from "./mission-queue-runner.js";
import { buildMcpTools } from "./mcp-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #255: `queue_exploration` (and `mission queue`) carry the media and persona the CLI's `explore`
 * takes — an exploratory mission queued with recordVideo + screenshots + a persona NAME runs
 * from that persona's targets.json session and writes its video and screenshots next to its
 * result. Real Chromium, served locally; enqueued through the served MCP handler.
 */
let server: Server;
let origin: string;
const cookiesSeen: string[] = [];

const APP = `<!doctype html><html><body>
  <h1>Board</h1>
  <button type="button" onclick="document.getElementById('d').hidden=!document.getElementById('d').hidden">Show details</button>
  <p id="d" hidden>Quarterly totals</p>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    cookiesSeen.push(req.headers.cookie ?? "");
    res.writeHead(path === "/board" ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(path === "/board" ? APP : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#255: a queued mission's media + persona reach the run", () => {
  it("exploratory + recordVideo + screenshots + persona: the persona's session, video and screenshots next to the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-queue-media-"));
    try {
      const target: MissionTarget = {
        id: "board",
        name: "Board",
        authorizedOrigin: origin,
        baseUrl: `${origin}/board`,
        promoted: true,
        createdAtIso: "2026-09-29T00:00:00Z",
      };
      const store = new FsMissionTargetStore(join(root, "targets"));
      await store.put(target);
      const queueDir = join(root, "queue");
      const adminState = join(root, "admin.json");
      writeFileSync(
        adminState,
        JSON.stringify({ cookies: [{ name: "who", value: "admin-session", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }),
      );

      const tool = buildMcpTools({ journeysDir: join(root, "j"), missionTargetsDir: join(root, "targets"), missionQueueDir: queueDir }).find((t) => t.name === "queue_exploration")!;
      // A path is never a queued media argument, and a persona is a name.
      for (const bad of [{ screenshots: join(root, "shots") }, { recordVideo: join(root, "v") }, { persona: "../admin" }]) {
        const refused = await tool.handler({ target: "board", strategy: "exploratory", ...bad });
        expect(refused.isError, JSON.stringify(bad)).toBe(true);
      }
      const queuedRes = await tool.handler({
        target: "board",
        strategy: "exploratory",
        recordVideo: true,
        screenshots: "steps",
        persona: "admin",
        budget: { maxActions: 2, maxDecisions: 4 },
      });
      expect(queuedRes.isError).toBeUndefined();
      const { missionId } = JSON.parse(queuedRes.content[0]!.text) as { missionId: string };

      const execute = realQueuedMissionExecutor({
        outDir: join(root, "out"),
        gateways: async () => ({
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          gen: new FakeGenerationGateway(),
          usage: new UsageTracker(),
        }),
        browserPortFactory: () => new PlaywrightBrowserPort(),
        targets: { [origin]: { personas: { admin: { storageState: adminState } } } },
      });
      const report = await drainMissionQueue({ queue: new FsMissionQueueStore(queueDir), targets: new MissionTargetRegistry(store), execute });

      expect(report.ran).toHaveLength(1);
      const ran = report.ran[0]!;
      expect(ran.missionId).toBe(missionId);
      expect(ran.status, ran.error).toBe("done");
      expect(ran.resultId).toMatch(/^exploratory-/);
      expect(cookiesSeen.some((c) => c.includes("who=admin-session"))).toBe(true);
      const raw = readFileSync(join(root, "out", `${ran.resultId ?? ""}.result.json`), "utf8");
      const videoPaths = [...raw.matchAll(/"([^"]+\.webm)"/g)].map((m) => m[1]!);
      const shots = [...raw.matchAll(/"([^"]+\.png)"/g)].map((m) => m[1]!);
      expect(videoPaths.length).toBeGreaterThan(0);
      expect(shots.length).toBeGreaterThan(0);
      for (const f of [...videoPaths, ...shots]) expect(existsSync(f), f).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("an unknown persona fails the mission by name — never runs as the default session", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-queue-persona-"));
    try {
      const target: MissionTarget = { id: "board", name: "Board", authorizedOrigin: origin, baseUrl: `${origin}/board`, promoted: true, createdAtIso: "2026-09-29T00:00:00Z" };
      const store = new FsMissionTargetStore(join(root, "targets"));
      await store.put(target);
      const queueDir = join(root, "queue");
      const tool = buildMcpTools({ journeysDir: join(root, "j"), missionTargetsDir: join(root, "targets"), missionQueueDir: queueDir }).find((t) => t.name === "queue_exploration")!;
      await tool.handler({ target: "board", strategy: "coverage", persona: "ghost" });
      let opened = 0;
      const execute = realQueuedMissionExecutor({
        outDir: join(root, "out"),
        gateways: async () => {
          opened += 1;
          throw new Error("no gateway in this test");
        },
        targets: { [origin]: { personas: { admin: {} } } },
      });
      const report = await drainMissionQueue({ queue: new FsMissionQueueStore(queueDir), targets: new MissionTargetRegistry(store), execute });
      expect(report.ran[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/persona 'ghost' is not declared.*known personas: admin/) });
      expect(opened).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
