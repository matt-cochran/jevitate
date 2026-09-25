import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { runGoalBasedMission } from "./goal-based.js";
import { runInductionMission } from "./induction.js";
import { monitorFor } from "../page-monitor.js";
import { perceive } from "../perceive.js";
import { verifyFix, type VerifySession } from "../verify-fix.js";
import { ScriptedJudge, withSession } from "../testkit.js";

/**
 * Owner ruling 7 — a hang is a first-class finding, proven by reproducing it in FRESH contexts.
 */

const state = { neverRespond: true, flakyHits: 0 };
const held: ServerResponse[] = [];

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    switch (path) {
      case "/api/never":
        if (state.neverRespond) {
          held.push(res); // never answered (until the server closes)
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      case "/api/flaky":
        state.flakyHits += 1;
        if (state.flakyHits === 1) {
          held.push(res); // only the FIRST load hangs
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      case "/stuck":
        res.writeHead(200, { "content-type": "text/html" }).end(
          // The page cannot be used until its data arrives: a stuck request here IS a hang (on an
          // interactive page the same pending request would be a long-poll, not a hang).
          html(`<h1>Report</h1><p id="s">Loading…</p><script>fetch("/api/never").then(() => { document.getElementById("s").innerHTML = '<button type="button">Refresh</button>'; });</script>`),
        );
        return;
      case "/flaky":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Report</h1><p id="s">Loading…</p><script>fetch("/api/flaky").then(() => { document.getElementById("s").innerHTML = '<button type="button">Refresh</button>'; });</script>`),
        );
        return;
      case "/hub":
        // One route that hangs (twice, under two names) and one route that 500s.
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Hub</h1><a href="/stuck">Stuck report</a><a href="/stuck?again=1">Stuck report again</a><a href="/broken">Broken page</a>`),
        );
        return;
      case "/btn-hub":
        // #193: a BUTTON (not a link, so misuse never filters it as leaving the scope) that
        // navigates to the hanging route, which sits outside the run's scope.
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Hub</h1><button type="button" onclick="location.href='/stuck'">Open stuck report</button>`),
        );
        return;
      case "/broken":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Broken</h1><a href="/hub">Hub</a><script>fetch("/api/boom");</script>`),
        );
        return;
      case "/api/boom":
        res.writeHead(500, { "content-type": "application/json" }).end("{}");
        return;
      case "/busy":
        res.writeHead(200, { "content-type": "text/html" }).end(
          // A main thread busy for 6s — long past the probe's bound, but bounded, so a test run's
          // CPU is not burned for longer than it needs (the browser pool's admission control backs
          // off under CPU pressure, which would stall other browser suites running alongside).
          html(`<button type="button">Go</button><script>setTimeout(() => { const end = Date.now() + 6000; while (Date.now() < end) {} }, 150);</script>`),
        );
        return;
      case "/lay-hub":
        // A hub linking to three routes that all share ONE layout widget — a persistent,
        // indeterminate busy indicator that never resolves (#87).
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Layout hub</h1><a href="/lay-a">Route A</a><a href="/lay-b">Route B</a><a href="/lay-c">Route C</a>`),
        );
        return;
      case "/lay-a":
      case "/lay-b":
      case "/lay-c":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(
            `<div class="layout"><div role="progressbar" data-testid="global-progress" style="width:20px;height:20px"></div><h1>${path.slice(-1).toUpperCase()}</h1></div>`,
          ),
        );
        return;
      case "/import":
        // Upload → Confirm → back to the start: an action that silently undoes itself.
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<div id="root"></div><script>
            const root = document.getElementById("root");
            const show = (label, next) => { root.innerHTML = ""; const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = next; root.appendChild(b); };
            const start = () => show("Process & Import", () => show("Confirm & Continue", start));
            start();
          </script>`),
        );
        return;
      default:
        res.writeHead(404).end();
    }
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

const port = new PlaywrightBrowserPort();
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

/**
 * Bounds for the test: short enough that a real hang's ceiling passes quickly, generous enough that
 * a healthy page on a loaded host always settles well inside them (no load-dependent verdicts).
 */
const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

function hunt(path: string) {
  return withSession(
    "hang-served-",
    async (session) => {
      const actor = CastActor.named("hang").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}${path}`,
        allowlist: [origin],
        strategies: ["nav-during-pending"],
        bounds: { maxDecisions: 2 },
        openFreshSession: freshSession,
        ...FAST,
      });
    },
    origin,
  );
}

describe("hangs are detected, classified and REPRODUCED in fresh contexts", () => {
  it(
    "an endpoint that never responds is a request-pending hang, reproduced 2/2",
    async () => {
      state.neverRespond = true;
      const result = await hunt("/stuck");
      expect(result.outcome).toBe("hang");
      expect(result.stop).toBe("hang");
      expect(result.hangs).toHaveLength(1);
      const h = result.hangs[0];
      expect(h?.hangKind).toBe("request-pending");
      expect(h?.signal.pending[0]?.endpoint).toBe("GET /api/never");
      expect(h?.reproduction).toMatchObject({ attempts: 2, reproduced: 2, status: "reproduced" });
      expect(h?.repro.recordingStepIndex).toBe(0);
      expect(h?.signal.lastState.controls).toEqual([]);
      // Its own transcript step says why the run stopped.
      expect(result.transcript.at(-1)?.reason).toMatch(/^hang \(request-pending\): GET \/api\/never was still pending/);

      // verify-fix covers hangs: still reproduces now…
      const check = () =>
        verifyFix({
          recording: result.recording,
          recordingStepIndex: h?.repro.recordingStepIndex ?? 0,
          fingerprint: h?.fingerprint ?? "",
          defectKind: "hang",
          ...(h === undefined ? {} : { hang: h.signal }),
          openSession: freshSession,
          perceive: FAST,
        });
      expect((await check()).verdict).toBe("still-reproduces");
      // …and passes only once the replay settles within the bound.
      state.neverRespond = false;
      const fixed = await check();
      expect(fixed.verdict).toBe("fixed");
      state.neverRespond = true;
    },
    180_000,
  );

  it(
    "a page that hangs only on its FIRST load is reported intermittent (0/2), never dropped or clean",
    async () => {
      state.flakyHits = 0;
      const result = await hunt("/flaky");
      expect(result.outcome).toBe("intermittent");
      expect(result.hangs[0]?.hangKind).toBe("request-pending");
      // Both replays RAN fully and settled: that is a genuine non-reproduction.
      expect(result.hangs[0]?.reproduction).toMatchObject({ attempts: 2, ran: 2, reproduced: 0, status: "intermittent" });
      expect(result.hangs[0]?.reproduction.runs.map((r) => r.detail)).toEqual([
        "same-kind rule: the page settled — no hang",
        "same-kind rule: the page settled — no hang",
      ]);
    },
    180_000,
  );

  it(
    "a busy-looping page is a main-thread-unresponsive hang",
    async () => {
      await withSession(
        "hang-busy-",
        async (session) => {
          await monitorFor(session.page).instrument();
          await session.page.goto(`${origin}/busy`, { waitUntil: "load" });
          await new Promise((resolve) => setTimeout(resolve, 400)); // the loop starts at 150ms
          const p = await perceive(session.page, FAST);
          expect(p.hang?.kind).toBe("main-thread-unresponsive");
          expect(p.rendered).toBe(false);
          expect(p.hang?.detail).toBe("the page's main thread did not answer a trivial probe within 2000ms");
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "an action that silently undoes itself (the stalled-import pattern) is a ui-no-progress hang, reproduced 2/2",
    async () => {
      const judge = new ScriptedJudge([
        { op: "click", target: "0" }, // Process & Import
        { op: "click", target: "0" }, // Confirm & Continue → back to the start
        { op: "scroll_down" },
      ]);
      const result = await withSession(
        "hang-stall-",
        async (session) => {
          const actor = CastActor.named("stall").whoCan(new BrowseTheWeb(session, [origin]));
          return runGoalBasedMission({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "import the file",
            allowlist: [origin],
            startUrl: `${origin}/import`,
            successAssertion: { kind: "visible", target: { text: "Imported" } },
            openFreshSession: freshSession,
            stallMs: 600,
            oracleTimeoutMs: 200,
          });
        },
        origin,
      );
      expect(result.outcome).toBe("hang");
      expect(result.run.stop).toBe("hang");
      expect(result.hang?.hangKind).toBe("ui-no-progress");
      expect(result.hang?.signal.detail).toMatch(/^after "click Confirm & Continue" the page returned to an earlier state/);
      expect(result.hang?.reproduction).toMatchObject({ attempts: 2, reproduced: 2, status: "reproduced" });
      // The repro replays up to the action that undid itself (navigate, click, click).
      expect(result.hang?.repro.recordingStepIndex).toBe(2);
    },
    180_000,
  );
});

describe("the adversarial mission KEEPS HUNTING after a hang", () => {
  it(
    "one hanging route and one 500 route yield BOTH findings in one run; the repeated hang is deduped",
    async () => {
      state.neverRespond = true;
      const result = await withSession(
        "hang-keep-hunting-",
        async (session) => {
          const actor = CastActor.named("hunter").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/hub`,
            allowlist: [origin],
            strategies: ["visit-route"],
            // The hub links to the routes under test: this run is scoped to the whole app.
            routeGlobs: ["/**"],
            bounds: { maxDecisions: 3 },
            openFreshSession: freshSession,
            hangReplays: 1,
            ...FAST,
          });
        },
        origin,
      );

      // Both kinds of finding, in one run; a hang is not the end of the hunt.
      expect(result.hangs).toHaveLength(1);
      expect(result.hangs[0]).toMatchObject({ hangKind: "request-pending", occurrences: 2 });
      expect(result.hangs[0]?.reproduction).toMatchObject({ attempts: 1, reproduced: 1, status: "reproduced" });
      const boom = result.defects.find((d) => d.title === "HTTP 500 from /api/boom");
      expect(boom).toBeDefined();
      expect(result.outcome).toBe("hang"); // the most severe finding; the defect is still reported
      expect(result.stop).toBe("step-budget");

      // The defect was found AFTER a reset: its repro is its own segment's Recording, which replays
      // from the start URL (never through the hang) — and verify-fix confirms it still reproduces.
      expect(boom?.repro.recording).toBeDefined();
      const check = await verifyFix({
        recording: boom?.repro.recording ?? result.recording,
        recordingStepIndex: boom?.repro.recordingStepIndex ?? 0,
        fingerprint: boom?.fingerprint ?? "",
        defectKind: boom?.kind ?? "",
        openSession: freshSession,
        perceive: FAST,
      });
      expect(check.verdict).toBe("still-reproduces");
    },
    180_000,
  );
});

describe("coverage exploration KEEPS EXPLORING after a hang", () => {
  it(
    "the induction mission records the hang (deduped, reproduced) and still reaches the other route",
    async () => {
      state.neverRespond = true;
      const result = await withSession(
        "hang-coverage-",
        async (session) => {
          const actor = CastActor.named("coverage").whoCan(new BrowseTheWeb(session, [origin]));
          return runInductionMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
            seedUrl: `${origin}/hub`,
            allowlist: [origin],
            // The hub links to the routes under test: this run is scoped to the whole app (only
            // in-scope pages are hang-checked — #193).
            routeGlobs: ["/**"],
            maxDepth: 1,
            openFreshSession: freshSession,
            hangReplays: 1,
            renderWaitMs: FAST.renderWaitMs,
          });
        },
        origin,
      );
      expect(result.outcome).toBe("exhausted");
      expect(result.hangs).toHaveLength(1);
      expect(result.hangs[0]).toMatchObject({ hangKind: "request-pending", occurrences: 2 });
      expect(result.hangs[0]?.reproduction, JSON.stringify(result.hangs[0]?.reproduction.runs)).toMatchObject({
        reproduced: 1,
        status: "reproduced",
      });
      // Its repro starts at the seed and replays the click that led to the hang.
      expect(result.hangs[0]?.repro.recording?.pages[0]?.steps[0]?.step.kind).toBe("navigate");
      // The frontier went on after the hang: the broken page (after both hangs in link order) was reached.
      expect(result.coverage.transitionsExercised).toBe(3);
      expect(result.transcript.some((e) => e.target === 'link "Broken page"')).toBe(true);
    },
    180_000,
  );
});

describe("#193 — a page reached only by an out-of-scope departure is never hang-checked", () => {
  it(
    "coverage: the hanging route outside the scope is a departure with an advisory note — no hang finding, the run goes on",
    async () => {
      state.neverRespond = true;
      const result = await withSession(
        "hang-out-of-scope-",
        async (session) => {
          const actor = CastActor.named("coverage").whoCan(new BrowseTheWeb(session, [origin]));
          return runInductionMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
            seedUrl: `${origin}/hub`,
            allowlist: [origin],
            // Scope: the hub and /broken only — /stuck (the hanging route) is outside it.
            routeGlobs: ["/broken"],
            maxDepth: 1,
            openFreshSession: freshSession,
            hangReplays: 1,
            renderWaitMs: FAST.renderWaitMs,
          });
        },
        origin,
      );
      expect(result.hangs).toEqual([]);
      expect(result.outcome).toBe("exhausted");
      const stuck = result.coverage.scope.departures.filter((d) => d.url.includes("/stuck"));
      expect(stuck.length).toBeGreaterThan(0);
      const notes = result.transcript.filter((e) => e.reason?.includes("out-of-scope page not checked (advisory, not a finding)") === true);
      expect(notes.length).toBeGreaterThan(0);
      // It went on after the departure: the in-scope broken page was still reached.
      expect(result.transcript.some((e) => e.target === 'link "Broken page"')).toBe(true);
    },
    180_000,
  );

  it(
    "adversarial: a departure onto the hanging route is not a hang finding; the hunt goes on in scope",
    async () => {
      state.neverRespond = true;
      const result = await withSession(
        "hang-out-of-scope-adv-",
        async (session) => {
          const actor = CastActor.named("hunter").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/btn-hub`,
            allowlist: [origin],
            strategies: ["exercise-controls"],
            bounds: { maxDecisions: 3 },
            openFreshSession: freshSession,
            hangReplays: 1,
            ...FAST,
          });
        },
        origin,
      );
      expect(result.hangs).toEqual([]);
      expect(result.stop).not.toBe("hang");
      expect(result.scope.departures.some((d) => d.url.includes("/stuck"))).toBe(true);
      expect(
        result.transcript.some((e) => e.strategy === "scope-reset" && e.reason?.includes("out-of-scope page not checked") === true),
      ).toBe(true);
    },
    180_000,
  );
});

describe("#87 — a global hang element is ONE finding across every route it appears on", () => {
  it(
    "a persistent busy indicator shared by the layout, met on 3 routes, is 1 hang finding listing all 3 routes, reproduced once",
    async () => {
      const result = await withSession(
        "hang-global-element-",
        async (session) => {
          const actor = CastActor.named("coverage").whoCan(new BrowseTheWeb(session, [origin]));
          return runInductionMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
            seedUrl: `${origin}/lay-hub`,
            allowlist: [origin],
            routeGlobs: ["/lay-*"],
            maxDepth: 1,
            openFreshSession: freshSession,
            hangReplays: 1,
            renderWaitMs: FAST.renderWaitMs,
          });
        },
        origin,
      );
      // ONE finding — never one per route — even though the frontier visited all three routes.
      expect(result.hangs).toHaveLength(1);
      const h = result.hangs[0];
      expect(h?.hangKind).toBe("ui-no-progress");
      expect(h?.occurrences).toBe(3);
      expect([...(h?.routes ?? [])].sort()).toEqual(["/lay-a", "/lay-b", "/lay-c"]);
      // Confirmed once, from the FIRST route it was met on: no replay budget spent re-confirming the
      // same element again on the 2nd and 3rd routes.
      expect(h?.reproduction).toMatchObject({ attempts: 1, status: "reproduced" });
      expect(result.outcome).toBe("exhausted");
    },
    180_000,
  );
});

describe("hang evidence carries the host's resource pressure", () => {
  it(
    "a busy-looping page found while the (injected) host sampler reports pressure is recorded with it",
    async () => {
      const result = await withSession(
        "hang-host-",
        async (session) => {
          const actor = CastActor.named("hang").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/busy`,
            allowlist: [origin],
            strategies: ["nav-during-pending"],
            bounds: { maxDecisions: 1 },
            hostProbe: async () => ({ sample: null, overThreshold: "memory pressure full avg10=9% > 5% (source=test)" }),
            ...FAST,
          });
        },
        origin,
      );
      const h = result.hangs[0];
      // Which kind the busy loop is caught as depends on when the probe lands (before/inside it).
      expect(["main-thread-unresponsive", "never-settled"]).toContain(h?.hangKind);
      expect(h?.signal.host?.overThreshold).toBe("memory pressure full avg10=9% > 5% (source=test)");
      // No way to replay here: nothing ran, so the reproduction is inconclusive (never a non-reproduction).
      expect(h?.reproduction).toMatchObject({ attempts: 0, ran: 0, status: "inconclusive" });
      expect(result.outcome).toBe("inconclusive");
    },
    120_000,
  );
});
