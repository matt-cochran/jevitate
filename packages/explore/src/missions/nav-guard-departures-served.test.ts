import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { runAdversarialMission } from "./adversarial.js";
import { runInductionMission } from "./induction.js";
import { PreferenceJudge, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #521 option A — every mission loop consumes the opt-in navigation guard: a page navigation to an
 * origin off the allowlist is answered 204 (the page stays put) and drained after the settle as a
 * departure, exactly like a settled off-scope URL. Real Chromium, two local origins.
 */

let app: Server;
let other: Server;
let APP = "";
let OTHER = "";

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  other = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(html("<h1>Other origin</h1>"));
  });
  app = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const body =
      path === "/seed-redirect"
        ? `<h1>Loading</h1><script>location.href = "${OTHER}/login?next=%2Fapp";</script>`
        : path === "/jump"
          ? `<h1>Jump</h1><a href="#" onclick="location.href='${OTHER}/elsewhere?token=secret'; return false;">Change workspace</a>`
          : `<h1>Home</h1><a id="leave" href="${OTHER}/elsewhere?token=secret">Leave</a>`;
    res.writeHead(200, { "content-type": "text/html" }).end(html(body));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  OTHER = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  APP = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all([app, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const port = new PlaywrightBrowserPort({ liveness: false });

/** A mission session with the guard armed (what `--block-off-allowlist-navigation` opens). */
async function guarded<T>(fn: (session: BrowserSession, actor: CastActor) => Promise<T>): Promise<T> {
  const session = await port.open({ headless: true, allowedOrigins: [APP], baseUrl: APP, blockOffAllowlistNavigation: true });
  try {
    return await fn(session, CastActor.named("guarded").whoCan(new BrowseTheWeb(session, [APP])));
  } finally {
    await session.close();
  }
}

describe("#521 — a blocked navigation is a departure in every mission loop (real Chromium)", () => {
  it(
    "goal: the run stops blocked, the transcript names the blocked URL, and the page never left for chrome-error",
    async () => {
      const seen = await guarded(async (session, actor) => {
        const judge = new PreferenceJudge([{ op: "click", name: "Leave" }]);
        judge.goalMetProbability = 0.1;
        const result = await runGoalBasedMission({
          actor,
          judge,
          gen: new FakeGenerationGateway(),
          goal: "Open the other page.",
          allowlist: [APP],
          startUrl: `${APP}/home`,
          bounds: { maxDecisions: 6 },
        });
        return {
          stop: result.run.stop,
          named: result.transcript.some((e) => e.strategy === "origin-guard" && (e.reason ?? "").includes(`${OTHER}/elsewhere`)),
          pageUrl: session.page.url(),
        };
      });
      expect(seen).toEqual({ stop: "blocked", named: true, pageUrl: `${APP}/home` });
    },
    90_000,
  );

  it(
    "adversarial: the departure is recorded in scope.departures with the blocked URL",
    async () => {
      const departures = await guarded(async (session, actor) => {
        const result = await runAdversarialMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${APP}/jump`,
          allowlist: [APP],
          strategies: ["exercise-controls"],
          bounds: { maxDecisions: 3 },
        });
        return result.scope.departures.map((d) => d.url);
      });
      expect(departures).toContain(`${OTHER}/elsewhere`);
    },
    90_000,
  );

  it(
    "coverage: the departure is recorded with the blocked URL",
    async () => {
      const departures = await guarded(async (session, actor) => {
        const result = await runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${APP}/home`,
          allowlist: [APP],
          bounds: { maxActions: 4, maxDecisions: 8, maxCandidates: 50 },
        });
        return result.coverage.scope.departures.map((d) => d.url);
      });
      expect(departures).toContain(`${OTHER}/elsewhere`);
    },
    90_000,
  );

  it(
    "a seed that redirects by script to a login IdP keeps the #82 login-like reason (never target unreachable)",
    async () => {
      const message = await guarded(async (session, actor) => {
        const result = await runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${APP}/seed-redirect`,
          allowlist: [APP],
          bounds: { maxActions: 2, maxDecisions: 4, maxCandidates: 50 },
        });
        return result.failure?.message;
      });
      expect(message).toBe("seed /seed-redirect redirected to /login — the --storage-state session is not authenticated");
    },
    90_000,
  );
});
