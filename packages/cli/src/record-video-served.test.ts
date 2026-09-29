import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PersistedMissionResultSchema } from "@jevitate/domain";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { runAdversarialCliMission } from "./explore-api.js";

/**
 * #245 `--record-video`: a served, real-Chromium (headless) run writes a video of its browser
 * context, finalized (the context closed) BEFORE the result naming it is written, and lists it as
 * `videoPaths` in the returned and the persisted result (the unified schema, schemaVersion 1).
 */

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/home") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><html><body><h1>Home</h1><button type="button" onclick="this.textContent='Done'">Go</button></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("--record-video (served, real Chromium, headless)", () => {
  it(
    "writes a non-empty video next to the run's output and lists it in the result",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-record-video-"));
      try {
        const run = await runAdversarialCliMission({
          seedUrl: `${origin}/home`,
          allowlist: [origin],
          strategies: ["nav-during-pending"],
          bounds: { maxDecisions: 1 },
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          outDir,
          nowIso: () => "2026-09-28T00:00:00.000Z",
          browser: { recordVideo: {} },
          browserPortFactory: () => new PlaywrightBrowserPort(),
        });
        const videos = run.videoPaths ?? [];
        expect(videos.length).toBeGreaterThanOrEqual(1);
        for (const v of videos) {
          expect(v.endsWith(".webm")).toBe(true);
          // Beside the run's output, in the run's own folder.
          expect(dirname(v)).toBe(join(outDir, "adversarial-2026-09-28T00-00-00-000Z.videos"));
          expect(existsSync(v)).toBe(true);
          // Finalized: the context closed before the result was written, so the file is complete.
          expect(statSync(v).size).toBeGreaterThan(0);
        }
        const persisted = PersistedMissionResultSchema.parse(JSON.parse(readFileSync(run.resultPath, "utf8")));
        expect(persisted.result.videoPaths).toEqual(videos);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
