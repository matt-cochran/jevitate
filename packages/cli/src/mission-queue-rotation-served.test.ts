import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsMissionQueueStore, FsMissionTargetStore, MissionTargetRegistry, type MissionTarget, type QueuedMission } from "@jevitate/missions";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { drainMissionQueue, realQueuedMissionExecutor } from "./mission-queue-runner.js";

/**
 * #175 — queued missions against an app with a ROTATING refresh cookie. Every authenticated request
 * to `/app` invalidates the presented `rt` and sets the next one, so a storageState file is stale
 * after one use. With `saveStorageState: true` in targets.json, `jevitate mission run` writes the
 * rotated session back after each mission (the #82/#159 machinery), and the next queued mission —
 * they run one at a time — starts authenticated from it. Real Chromium, served locally.
 */
let server: Server;
let origin: string;
let current = 0;
const hits: Array<{ authed: boolean; presented: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path !== "/app") {
      res.writeHead(path === "/login" ? 200 : 404, { "content-type": "text/html" }).end("<!doctype html><h1>Sign in</h1>");
      return;
    }
    const presented = /(?:^|;\s*)rt=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const authed = presented === `rt-${current}`;
    hits.push({ authed, presented });
    if (!authed) {
      res.writeHead(302, { location: "/login" }).end();
      return;
    }
    current += 1;
    res
      .writeHead(200, { "content-type": "text/html", "set-cookie": `rt=rt-${current}; Path=/; HttpOnly; SameSite=Lax` })
      .end(`<!doctype html><html><body><h1 data-testid="account">Account</h1></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function queued(id: string, at: string): QueuedMission {
  return {
    id,
    target: "rotating",
    strategy: "feature",
    feature: "account",
    budget: { maxActions: 2, maxDecisions: 4, maxCandidates: 20 },
    status: "queued",
    enqueuedAtIso: at,
  } as QueuedMission;
}

describe("queued missions keep a rotating session alive (#175)", () => {
  it("two queued missions both start authenticated, and the storageState file is rotated (0600)", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-queue-rotate-"));
    try {
      const state = join(root, "state.json");
      writeFileSync(
        state,
        JSON.stringify({
          cookies: [{ name: "rt", value: "rt-0", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
          origins: [],
        }),
      );
      const target: MissionTarget = {
        id: "rotating",
        name: "Rotating",
        authorizedOrigin: origin,
        baseUrl: `${origin}/app`,
        promoted: true,
        createdAtIso: "2026-09-25T00:00:00Z",
      };
      const store = new FsMissionTargetStore(join(root, "targets"));
      await store.put(target);
      const queue = new FsMissionQueueStore(join(root, "queue"));
      await queue.enqueue(queued("11111111-1111-4111-8111-111111111111", "2026-09-25T00:00:00Z"));
      await queue.enqueue(queued("22222222-2222-4222-8222-222222222222", "2026-09-25T00:00:01Z"));
      const execute = realQueuedMissionExecutor({
        outDir: join(root, "out"),
        gateways: async () => {
          throw new Error("a feature mission builds no gateway");
        },
        browserPortFactory: () => new PlaywrightBrowserPort(),
        targets: { [origin]: { storageState: state, saveStorageState: true } },
      });

      const report = await drainMissionQueue({ queue, targets: new MissionTargetRegistry(store), execute });

      expect(report.ran.map((m) => m.status)).toEqual(["done", "done"]);
      // Every /app request presented the CURRENT token: the second mission started from the rotated file.
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits.every((h) => h.authed)).toBe(true);
      const saved = JSON.parse(readFileSync(state, "utf8")) as { cookies: Array<{ name: string; value: string }> };
      expect(saved.cookies.find((c) => c.name === "rt")?.value).toBe(`rt-${current}`);
      expect(current).toBeGreaterThanOrEqual(2);
      expect(statSync(state).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
