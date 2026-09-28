import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { HostHealthSampler } from "../host-health.js";
import { ScriptedJudge, withSession } from "../testkit.js";
import type { VerifySession } from "../verify-fix.js";

/**
 * #230 item 1 — the app's server FREEZES mid-GOAL run (alive, accepting connections, never
 * answering — what a SIGSTOP on its process looks like). #226 typed this for adversarial; a goal run
 * still recorded a `request-pending` hang (and, on a starved host, blamed the host). The app stopped
 * answering: `inconclusive` / `target-unresponsive`, a plain reason, no hang finding — with host
 * attribution off AND on a starved host (the app not answering a fresh request at all wins over
 * starvation). A genuinely slow app that still answers stays `degraded-environment` on a starved host.
 *
 * The fixture holds its responses (never SIGSTOPs a shared process).
 */

const state = { frozen: false };
const held: ServerResponse[] = [];
/** The slow-but-answering app: every response is late by this much (the API one past the request bound). */
const SLOW_PAGE_MS = 1_000;
const SLOW_API_MS = 7_000;

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
      // Freezes right after serving the start page: the goal's first click meets a frozen backend.
      setTimeout(() => {
        state.frozen = true;
      }, 300);
      res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>App</h1><a href="/other">Other page</a>`));
      return;
    }
    if (path === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Slow</h1><p id="s">loading</p><script>fetch("/api/slow").then(() => { document.getElementById("s").textContent = "ready"; });</script>`),
        );
      }, SLOW_PAGE_MS);
      return;
    }
    if (path === "/api/slow") {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), SLOW_API_MS);
      return;
    }
    setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>Other</h1>`)), path === "/" ? SLOW_PAGE_MS : 0);
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

const starvedHost = (): HostHealthSampler =>
  new HostHealthSampler({
    probe: async () => ({ sample: null, overThreshold: null, loadPerCore: 3.5 }),
    eventLoopLagMs: () => 0,
    intervalMs: 0,
    attribute: true,
    cores: 4,
  });

const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

async function frozenGoal(hostHealth?: HostHealthSampler) {
  state.frozen = false;
  return withSession(
    "frozen-goal-",
    async (session) => {
      const actor = CastActor.named("frozen").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "click", target: "0" }, { op: "scroll_down" }]),
        gen: new FakeGenerationGateway(),
        goal: "open the other page",
        allowlist: [origin],
        startUrl: `${origin}/app`,
        successAssertion: { kind: "visible", target: { text: "Other" } },
        openFreshSession: freshSession,
        oracleTimeoutMs: 200,
        ...FAST,
        ...(hostHealth === undefined ? {} : { hostHealth }),
      });
    },
    origin,
  );
}

function expectTargetUnresponsive(result: Awaited<ReturnType<typeof frozenGoal>>): void {
  expect(result.hang).toBeUndefined();
  expect(result.intermittentHangs ?? []).toEqual([]);
  expect(result.outcome).toBe("inconclusive");
  expect(result.run.stop).toBe("inconclusive");
  expect(result.run.failure?.kind).toBe("target-unresponsive");
  expect(result.run.failure?.message).toMatch(/stopped responding/);
  expect(result.run.failure?.message).not.toMatch(/\n|\s+at\s|Timeout \d+ms|not an app finding/);
  expect(result.run.failure?.stack).toBeUndefined();
}

describe("#230 — a backend that freezes mid-GOAL ends target-unresponsive, never a hang finding", () => {
  it(
    "host attribution off: inconclusive / target-unresponsive, not a request-pending hang",
    async () => {
      const t0 = Date.now();
      const result = await frozenGoal();
      state.frozen = false;
      expect(Date.now() - t0).toBeLessThan(240_000);
      expectTargetUnresponsive(result);
    },
    300_000,
  );

  it(
    "starved host: the app not answering at all wins over host starvation (no environment-degraded finding)",
    async () => {
      const health = starvedHost();
      const result = await frozenGoal(health);
      state.frozen = false;
      expectTargetUnresponsive(result);
      expect(health.findings()).toEqual([]);
    },
    300_000,
  );

  it(
    "a slow-but-answering app on a starved host stays degraded-environment",
    async () => {
      state.frozen = false;
      const health = starvedHost();
      const result = await withSession(
        "slow-goal-",
        async (session) => {
          const actor = CastActor.named("slow").whoCan(new BrowseTheWeb(session, [origin]));
          return runGoalBasedMission({
            actor,
            judge: new ScriptedJudge([{ op: "scroll_down" }]),
            gen: new FakeGenerationGateway(),
            goal: "wait for the page to be ready",
            allowlist: [origin],
            startUrl: `${origin}/slow`,
            successAssertion: { kind: "visible", target: { text: "ready" } },
            openFreshSession: freshSession,
            oracleTimeoutMs: 200,
            ...FAST,
            hostHealth: health,
          });
        },
        origin,
      );
      expect(result.outcome).toBe("inconclusive");
      expect(result.run.failure?.kind).toBe("degraded-environment");
      expect(result.hang).toBeUndefined();
      expect(health.findings()).toEqual([expect.objectContaining({ kind: "environment-degraded", finding: "hang", advisory: true })]);
    },
    300_000,
  );
});
