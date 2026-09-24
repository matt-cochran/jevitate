import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession } from "./testkit.js";
import type { VerifySession } from "./verify-fix.js";

/**
 * #126 item 1 — a hang met on the SEED load that does NOT reproduce (0/N) must not end a goal
 * mission: it is recorded as an intermittent finding, and the run tries the goal once more (a
 * fresh navigate of the seed). Here the first ever load of `/seed` hits a request that never
 * answers (a `request-pending` hang) — a one-off, slow-host-style stall — but every FRESH replay
 * of that same seed answers normally, so the reproduction is 0/N and the mission must go on to
 * meet its goal on the retried load.
 */

let server: Server;
let origin: string;
let gateHits = 0;
// The FIRST ever call to /api/gate never answers; every later call answers fast.
const pendingResponses: Array<(v: unknown) => void> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/gate") {
      gateHits += 1;
      if (gateHits === 1) {
        pendingResponses.push(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
        return; // never answered in this test run
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/seed") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>
        <h1>Seed</h1>
        <p id="status">Waiting</p>
        <button type="button">Refresh</button>
        <script>
          fetch("/api/gate").then(() => { document.getElementById("status").textContent = "Ready"; });
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
  // Never leave the first request hanging past the test (it does not matter to the assertions).
  for (const resolve of pendingResponses) resolve(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const port = new PlaywrightBrowserPort();
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

describe("#126 — a non-reproducing seed hang lets the goal run continue", () => {
  it(
    "a request-pending hang on the seed that does not reproduce (0/N) does not end the mission — the goal is still met on the retried seed",
    async () => {
      gateHits = 0;
      const result = await withSession(
        "goal-seed-hang-",
        async (session) => {
          const actor = CastActor.named("goal").whoCan(new BrowseTheWeb(session, [origin]));
          return runGoalBasedMission({
            actor,
            judge: new ScriptedJudge([{ op: "done" }]),
            gen: new FakeGenerationGateway(),
            goal: "wait for the page to be ready",
            allowlist: [origin],
            startUrl: `${origin}/seed`,
            successAssertion: { kind: "visible", target: { text: "Ready" } },
            openFreshSession: freshSession,
            hangReplays: 2,
            renderWaitMs: 800,
            requestBoundMs: 400,
            hangProbeMs: 300,
            oracleTimeoutMs: 2_000,
            bounds: { maxDecisions: 6 },
          });
        },
        origin,
      );

      // The seed hang did NOT end the mission: it is an intermittent finding, and the retried
      // seed load reached the goal.
      expect(result.outcome).toBe("succeeded");
      expect(result.assertionPassed).toBe(true);
      expect(result.intermittentHangs).toBeDefined();
      expect(result.intermittentHangs).toHaveLength(1);
      const finding = result.intermittentHangs![0]!;
      expect(finding.hangKind).toBe("request-pending");
      expect(finding.reproduction.status).toBe("intermittent");
      expect(finding.reproduction.reproduced).toBe(0);
      expect(finding.reproduction.ran).toBeGreaterThan(0);
      // The run itself never reports the mission-ending `hang` field for a non-reproducing seed hang.
      expect(result.hang).toBeUndefined();
    },
    60_000,
  );

  it(
    "a seed hang that DOES reproduce still ends the mission as a hang (unchanged behaviour)",
    async () => {
      // Every call to /api/gate on THIS origin never answers (a fresh, dedicated server): the hang
      // reproduces on every fresh-context replay too.
      const alwaysHangs = createServer((req, res) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (path === "/seed") {
          res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>
            <h1>Seed</h1>
            <button type="button">Refresh</button>
            <script>fetch("/api/gate");</script>
          </body></html>`);
          return;
        }
        // /api/gate: never answered.
      });
      await new Promise<void>((resolve) => alwaysHangs.listen(0, "127.0.0.1", resolve));
      const addr = alwaysHangs.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      const badOrigin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
      const badPort = new PlaywrightBrowserPort();
      const badFreshSession = async (): Promise<VerifySession> => {
        const session = await badPort.open({ headless: true, allowedOrigins: [badOrigin], baseUrl: badOrigin });
        const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [badOrigin]));
        return { page: session.page, actor, close: () => session.close() };
      };
      try {
        const result = await withSession(
          "goal-seed-hang-reproduced-",
          async (session) => {
            const actor = CastActor.named("goal").whoCan(new BrowseTheWeb(session, [badOrigin]));
            return runGoalBasedMission({
              actor,
              judge: new ScriptedJudge([{ op: "done" }]),
              gen: new FakeGenerationGateway(),
              goal: "wait for the page to be ready",
              allowlist: [badOrigin],
              startUrl: `${badOrigin}/seed`,
              successAssertion: { kind: "visible", target: { text: "Ready" } },
              openFreshSession: badFreshSession,
              hangReplays: 1,
              renderWaitMs: 700,
              requestBoundMs: 300,
              hangProbeMs: 300,
              oracleTimeoutMs: 1_000,
              bounds: { maxDecisions: 4 },
            });
          },
          badOrigin,
        );
        expect(result.outcome).toBe("hang");
        expect(result.hang).toBeDefined();
        expect(result.hang!.reproduction.status).toBe("reproduced");
      } finally {
        await new Promise<void>((resolve) => alwaysHangs.close(() => resolve()));
      }
    },
    60_000,
  );
});
