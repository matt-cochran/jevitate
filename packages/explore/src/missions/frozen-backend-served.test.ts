import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { withSession, useSkippingTime } from "../testkit.js";
import type { VerifySession } from "../verify-fix.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #226: the app's server FREEZES mid-run (alive, accepting connections, never answering — what a
 * SIGSTOP on its process looks like from the browser). The run must end bounded and TYPED —
 * `inconclusive`, `failure.kind: "target-unresponsive"`, a plain reason with no stack trace — never
 * `crashed: exception` with a raw "page.goto: Timeout …" and never a false `main-thread-unresponsive`
 * hang (the browser's main thread was fine; the app never answered).
 *
 * The fixture pauses its responses (every request is held) instead of SIGSTOPping a shared process.
 */

const state = { frozen: false };
const held: ServerResponse[] = [];

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (state.frozen) {
      held.push(res); // the server stopped answering: accepted, never responded
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") {
      // Freezes right after serving the start page: the run is mid-hunt when the backend stops.
      setTimeout(() => {
        state.frozen = true;
      }, 300);
      res.writeHead(200, { "content-type": "text/html" }).end(
        html(`<h1>App</h1><a href="/other">Other page</a><a href="/third">Third page</a><button type="button" onclick="location.href='/other'">Go</button>`),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>Other</h1><a href="/app">Back</a>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of held) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const port = new PlaywrightBrowserPort();
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

describe("#226 — a backend that freezes mid-adversarial ends typed, never an engine crash", () => {
  it(
    "ends inconclusive with failure.kind target-unresponsive, a plain reason (no stack) and no main-thread hang",
    async () => {
      state.frozen = false;
      const t0 = Date.now();
      const result = await withSession(
        "frozen-backend-",
        async (session) => {
          const actor = CastActor.named("frozen").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/app`,
            allowlist: [origin],
            strategies: ["visit-route", "nav-during-pending", "exercise-controls"],
            bounds: { maxDecisions: 6 },
            openFreshSession: freshSession,
            ...FAST,
          });
        },
        origin,
      );
      state.frozen = false;
      expect(Date.now() - t0).toBeLessThan(240_000);
      expect(result.stop).toBe("target-unresponsive");
      expect(result.hangs.filter((h) => h.hangKind === "main-thread-unresponsive")).toEqual([]);
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("target-unresponsive");
      expect(result.failure?.message).not.toMatch(/\n|\s+at\s|page\.goto|Timeout \d+ms/);
      expect(result.failure?.message).toMatch(/stopped responding/);
    },
    300_000,
  );
});
