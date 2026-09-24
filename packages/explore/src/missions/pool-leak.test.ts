import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, createBrowserPool, type PlaywrightBrowserPool, type ResourceSample } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runInductionMission } from "./induction.js";
import type { VerifySession } from "../verify-fix.js";

/**
 * #68 — a mission must never exhaust its own browser pool. Hang reproduction (fresh contexts, N per
 * hang) and resets after each hang open contexts; every one of them must be released, so a run with
 * K hangs × N replays holds no context once it ends — even on a pool with only 3 slots.
 */

const HANGS = 4;
const held: ServerResponse[] = [];
const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/never") {
      held.push(res); // never answered (until the server closes)
      return;
    }
    if (path === "/hub") {
      const links = Array.from({ length: HANGS }, (_, i) => `<a href="/stuck${i}">Stuck report ${i}</a>`).join("");
      res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>Hub</h1>${links}`));
      return;
    }
    if (/^\/stuck\d+$/.test(path)) {
      res.writeHead(200, { "content-type": "text/html" }).end(
        html(`<h1>Report</h1><p id="s">Loading…</p><script>fetch("/api/never").then(() => { document.getElementById("s").textContent = "ok"; });</script>`),
      );
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
  for (const r of held) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const calm: ResourceSample = {
  cpuPressure: 0,
  cpuMetric: "psi-cpu-some-avg10",
  memPressure: 0,
  memMetric: "psi-memory-full-avg10",
  memAvailableBytes: 64 * 1024 ** 3,
  source: "fixture:calm",
};

describe("a mission never exhausts its own browser pool (#68)", () => {
  it(
    `a coverage run with ${HANGS} hangs × 2 replays on a 3-slot pool finishes and releases every context`,
    async () => {
      // 3 slots: the mission's own page + the current reset page + one replay. A leaked context
      // would starve admission (short timeout → the run would end `crashed`).
      const pool: PlaywrightBrowserPool = createBrowserPool({
        signals: { sample: async () => calm },
        maxContexts: 3,
        admissionTimeoutMs: 20_000,
      });
      const port = new PlaywrightBrowserPort({ pool });
      let peak = 0;
      const freshSession = async (): Promise<VerifySession> => {
        const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
        peak = Math.max(peak, pool.inUse);
        const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin]));
        return { page: session.page, actor, close: () => session.close() };
      };

      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        const actor = CastActor.named("coverage").whoCan(new BrowseTheWeb(session, [origin]));
        const result = await runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          seedUrl: `${origin}/hub`,
          allowlist: [origin],
          maxDepth: 1,
          openFreshSession: freshSession,
          hangReplays: 2,
          renderWaitMs: 4_000,
        });
        expect(result.outcome, JSON.stringify(result.failure)).toBe("exhausted");
        expect(result.hangs).toHaveLength(HANGS);
        for (const h of result.hangs) expect(h.reproduction).toMatchObject({ attempts: 2, reproduced: 2 });
        // Only the caller's own session is still open once the mission returns.
        expect(pool.inUse).toBe(1);
        expect(peak).toBeLessThanOrEqual(3);
      } finally {
        await session.close();
        await pool.close();
      }
      expect(pool.inUse).toBe(0);
    },
    300_000,
  );
});
