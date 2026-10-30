import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock, type StartupAttempt } from "@jevitate/domain";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import type { BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { DEFAULT_STARTUP_RETRY, navigateWithStartupRetry, startupRetryBudgetMs } from "./startup-retry.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

/**
 * #742 — the bounded first-navigation retry. A direct target can refuse the FIRST navigation (a
 * transient DNS/connect hiccup, a navigation timeout, a browser launch failure) before any action or
 * write, even while a plain HTTP probe answers. The retry is bounded, clock-driven, recorded in
 * `attempts[]`, never widens the allowlist, and never retries a gate-blocked departure.
 */

const actorWith = (session: Partial<BrowserSession> = {}) => CastActor.named("retry").whoCan(new BrowseTheWeb(session as BrowserSession, []));

describe("startup retry policy (#742)", () => {
  it("keeps the default worst case within the 60 second bound", () => {
    expect(startupRetryBudgetMs(DEFAULT_STARTUP_RETRY)).toBeLessThanOrEqual(60_000);
  });
});

describe("bounded startup retry on the clock (#742)", () => {
  let fake: FakeClock;
  beforeEach(() => {
    fake = new FakeClock();
    installClock(fake);
  });
  afterEach(() => resetClock());

  it("stops after the policy's attempt count", async () => {
    const attempts: StartupAttempt[] = [];
    const p = navigateWithStartupRetry(actorWith(), "http://app.test/", {
      policy: { maxAttempts: 3, perAttemptTimeoutMs: 15_000, backoffMs: 500 },
      navigate: async () => {
        throw new Error("page.goto: net::ERR_CONNECTION_RESET at http://app.test/");
      },
      onAttempt: (a) => attempts.push(a),
    }).catch((e: unknown) => e);
    await fake.runUntilIdle();
    await p;
    expect(attempts).toHaveLength(3);
  });

  it("waits between attempts on the installed clock, so the worst case elapses in fake time", async () => {
    const started = fake.now();
    const p = navigateWithStartupRetry(actorWith(), "http://app.test/", {
      policy: { maxAttempts: 3, perAttemptTimeoutMs: 15_000, backoffMs: 500 },
      navigate: async () => {
        throw new Error("page.goto: net::ERR_CONNECTION_RESET at http://app.test/");
      },
    }).catch((e: unknown) => e);
    await fake.runUntilIdle();
    await p;
    expect(fake.now() - started).toBe(1_000);
  });

  it("labels a browser failure under a healthy origin as origin-readiness", async () => {
    const attempts: StartupAttempt[] = [];
    await navigateWithStartupRetry(actorWith(), "http://app.test/", {
      policy: { maxAttempts: 1 },
      navigate: async () => {
        throw new Error("page.goto: Timeout 15000ms exceeded.");
      },
      probeOriginReadiness: async () => ({ class: "ready", status: 200, detail: "origin answered HTTP 200" }),
      onAttempt: (a) => attempts.push(a),
    }).catch((e: unknown) => e);
    expect(attempts[0]?.errorClass).toBe("origin-readiness");
  });

  it("does not retry a navigation the allowlist guard blocked", async () => {
    const attempts: StartupAttempt[] = [];
    const blocked = actorWith({ drainBlockedNavigations: () => [{ url: "http://elsewhere.test/", at: 0, frame: "main" }] });
    await navigateWithStartupRetry(blocked, "http://app.test/", {
      policy: { maxAttempts: 3, backoffMs: 0 },
      navigate: async () => {
        throw new Error("page.goto: net::ERR_ABORTED at http://app.test/");
      },
      onAttempt: (a) => attempts.push(a),
    }).catch((e: unknown) => e);
    expect(attempts).toHaveLength(1);
  });
});

describe("bounded first-navigation retry over a served origin (#742)", () => {
  useSkippingTime({ per: "all" });

  let server: Server;
  let origin = "";
  let navigationsFailed = 0;
  const FAIL_UNTIL = 2;
  const POLICY = { maxAttempts: 4, perAttemptTimeoutMs: 5_000, backoffMs: 50 } as const;

  beforeAll(async () => {
    server = createServer((req, res) => {
      // The plain readiness probe is a Node GET with no `sec-fetch-mode`; only the BROWSER's
      // navigation is failed, so the origin reads healthy and the retry stays a startup retry.
      if (req.headers["sec-fetch-mode"] === "navigate" && navigationsFailed < FAIL_UNTIL) {
        navigationsFailed += 1;
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><html><body><h1>Arrived</h1></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    navigationsFailed = 0;
  });

  it("lands on the target page after a transiently failed first navigation", async () => {
    await withSession(
      "startup-retry-",
      async (session) => {
        const actor = CastActor.named("retry").whoCan(new BrowseTheWeb(session, [origin]));
        await navigateWithStartupRetry(actor, origin, { policy: POLICY });
        expect(await session.page.content()).toContain("Arrived");
      },
      origin,
    );
  });

  it("records the failed attempt before the attempt that reached the target", async () => {
    const attempts: StartupAttempt[] = [];
    await withSession(
      "startup-retry-",
      async (session) => {
        const actor = CastActor.named("retry").whoCan(new BrowseTheWeb(session, [origin]));
        await navigateWithStartupRetry(actor, origin, { policy: POLICY, onAttempt: (a) => attempts.push(a) });
      },
      origin,
    );
    expect(attempts.some((a) => a.errorClass !== null)).toBe(true);
  });

  it("a served goal mission records the transiently failed first try in its run result's attempts[]", async () => {
    await withSession(
      "startup-retry-mission-",
      async (session) => {
        const actor = CastActor.named("retry").whoCan(new BrowseTheWeb(session, [origin]));
        const result = await runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "wait" }]),
          gen: new FakeGenerationGateway(),
          goal: "land on the page",
          allowlist: [origin],
          startUrl: origin,
          bounds: { maxDecisions: 2 },
          waitOpMs: 50,
        });
        expect(result.attempts?.some((a) => a.errorClass !== null)).toBe(true);
      },
      origin,
    );
  });
});
