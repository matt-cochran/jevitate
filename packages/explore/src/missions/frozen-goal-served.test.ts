import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
/** #213: the first /cold load answers after this — past the test's 3s page-load timeout, but it answers. */
const COLD_FIRST_MS = 5_000;
let coldHits = 0;

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
    if (path === "/cold") {
      // A cold start: the FIRST load answers late (past the page-load timeout), every later one at once.
      coldHits += 1;
      const late = coldHits === 1 ? COLD_FIRST_MS : 0;
      setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>Cold</h1>`)), late);
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

/**
 * #304 [realtime]: a backend that really holds its responses and a page call that really never
 * returns — behaviour that only exists in real time, so these keep the real clock. The page-liveness
 * bound (60 s by default) is scaled down to 15 s here (still past the FAST hang bounds, so the hang path is met first).
 */
describe("[realtime] #230 — a backend that freezes mid-GOAL ends target-unresponsive, never a hang finding", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.JEVITATE_PAGE_UNRESPONSIVE_MS;
    process.env.JEVITATE_PAGE_UNRESPONSIVE_MS = "15000";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.JEVITATE_PAGE_UNRESPONSIVE_MS;
    else process.env.JEVITATE_PAGE_UNRESPONSIVE_MS = previous;
  });

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

/**
 * #213 item 5 — a start page that does not load in time on a STARVED host is the host, not the
 * target: `degraded-environment` (an `environment-degraded` page-load-timeout), never
 * `target-unreachable` (which a persona matrix read as an access difference). On a calm host (no
 * sampler) the same timeout stays `target-unreachable`.
 */
describe("#213 — a page-load timeout on a starved host is degraded-environment, not target-unreachable", () => {
  async function coldGoal(hostHealth?: HostHealthSampler) {
    coldHits = 0;
    return withSession(
      "cold-goal-",
      async (session) => {
        session.page.setDefaultNavigationTimeout(3_000);
        const actor = CastActor.named("cold").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "done" }]),
          gen: new FakeGenerationGateway(),
          goal: "open the cold page",
          allowlist: [origin],
          startUrl: `${origin}/cold`,
          successAssertion: { kind: "visible", target: { text: "Cold" } },
          oracleTimeoutMs: 200,
          ...FAST,
          ...(hostHealth === undefined ? {} : { hostHealth }),
        });
      },
      origin,
    );
  }

  it(
    "starved host: inconclusive / degraded-environment with a page-load-timeout environment-degraded entry",
    async () => {
      const health = starvedHost();
      const result = await coldGoal(health);
      expect(result.outcome).toBe("inconclusive");
      expect(result.run.failure?.kind).toBe("degraded-environment");
      expect(result.run.failure?.message).toMatch(/start page did not load in time.*not an app or access finding/);
      expect(health.findings()).toEqual([expect.objectContaining({ kind: "environment-degraded", finding: "page-load-timeout", advisory: true })]);
    },
    120_000,
  );

  it(
    "calm host (no sampler): the same timeout stays target-unreachable",
    async () => {
      const result = await coldGoal();
      expect(result.outcome).toBe("inconclusive");
      expect(result.run.failure?.kind).toBe("target-unreachable");
    },
    120_000,
  );
});
