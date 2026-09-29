import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { withSession } from "../testkit.js";

/**
 * Owner ruling 6 — a deliberately slow endpoint must show up in the run's timing summary, keyed by
 * its normalized endpoint pattern; the navigation's own timing lands in the transcript and in the
 * Recording. Measurements only: the slow endpoint is NOT a defect.
 */

// Far slower than anything a loaded host can make the 150 small asset requests (which queue on
// Chromium's 6-connections-per-host limit), so "the slowest endpoint" never depends on host load.
const SLOW_MS = 3_000;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path.startsWith("/api/slow/")) {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), SLOW_MS);
      return;
    }
    if (path.startsWith("/asset/")) {
      res.writeHead(200, { "content-type": "image/png" }).end("x");
      return;
    }
    if (path === "/api/fast") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>
        <button type="button" onclick="fetch('/api/slow/' + Date.now())">Reload report</button>
        <script>
          // 150 asset requests first: the slow API call comes late in the window and must still
          // reach the summary (no per-step sample cap truncates it).
          Promise.all(Array.from({ length: 150 }, (_, i) => fetch("/asset/" + i))).then(() => {
            fetch("/api/fast"); fetch("/api/slow/" + Math.floor(Math.random() * 1e6));
          });
        </script>
      </body></html>`);
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

describe("page timing — the slow endpoint is found and measured (owner ruling 6)", () => {
  it(
    "the summary ranks the slow endpoint first by its pattern, with p50/max; timings reach transcript and Recording",
    async () => {
      const result = await withSession(
        "timing-served-",
        async (session) => {
          const actor = CastActor.named("timing").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/app`,
            allowlist: [origin],
            // The seed load itself calls the slow endpoint. ordering-violation finds nothing to do (so
            // two steps are decided on the same perception); nav-during-pending scrolls.
            strategies: ["ordering-violation", "nav-during-pending"],
            bounds: { maxDecisions: 3 },
          });
        },
        origin,
      );

      // Measurements are not verdicts: a slow endpoint is not a defect. (The run never touched the
      // page's one control, so its silence proves nothing either: inconclusive, never clean.)
      expect(result.defects).toEqual([]);
      expect(result.outcome).toBe("inconclusive");
      expect(result.coverage.shortfalls).toContain("no target control was exercised");

      const slow = result.timing.endpoints["GET /api/slow/:id"];
      expect(slow).toBeDefined();
      expect(slow?.maxMs).toBeGreaterThanOrEqual(SLOW_MS - 50);
      expect(slow?.statuses).toEqual([200]);
      // Ranked among the slowest endpoints (the 150 assets are ONE pattern, so they take one slot
      // however long a loaded host makes them queue).
      expect(result.timing.slowestEndpoints.map((e) => e.endpoint)).toContain("GET /api/slow/:id");
      // API endpoints and assets are ranked apart: the 150 images are assets, never "endpoints".
      expect(result.timing.slowestEndpoints.every((e) => e.kind === "api")).toBe(true);
      expect(result.timing.slowestAssets.map((e) => e.endpoint)).toEqual(["GET /asset/:id"]);
      expect(result.timing.endpoints["GET /api/slow/:id"]?.kind).toBe("api");
      expect(result.timing.endpoints["GET /api/fast"]?.maxMs).toBeLessThan(SLOW_MS);

      // The seed load is a navigation: Navigation Timing is in the first transcript step…
      const seed = result.transcript[0]?.timing;
      expect(seed?.kind).toBe("navigation");
      expect(seed?.route).toBe("/app");
      expect(seed?.navigation?.ttfbMs).toBeGreaterThanOrEqual(0);
      expect(seed?.navigation?.domContentLoadedMs).toBeGreaterThanOrEqual(seed?.navigation?.ttfbMs ?? 0);
      expect(seed?.requests.slowest).toHaveLength(3);
      expect(seed?.requests.count).toBeGreaterThanOrEqual(152);
      // The transcript keeps count/pending/slowest; the per-request list feeds the summary only.
      expect(seed?.requests.samples).toEqual([]);
      expect(result.timing.endpoints["GET /asset/:id"]?.samples).toBe(150);
      expect(result.timing.slowestPages[0]?.key).toBe("navigation /app");
      // One page load is ONE sample, however many steps were decided on that perception.
      expect(result.timing.pages["navigation /app"]?.samples).toBe(1);
      expect(result.transcript.filter((e) => e.timing?.kind === "navigation")).toHaveLength(1);
      // …and on the Recording's navigate step (measurement only; never replayed).
      const navigateStep = result.recording.pages[0]?.steps[0];
      expect(navigateStep?.step.kind).toBe("navigate");
      expect(navigateStep?.timing?.page?.kind).toBe("navigation");
      expect(navigateStep?.timing?.page?.requests.count).toBeGreaterThanOrEqual(152);
    },
    120_000,
  );
});
