import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { runGoalBasedMission } from "./goal-based.js";
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
          html(`<h1>Report</h1><button type="button">Refresh</button><script>fetch("/api/never");</script>`),
        );
        return;
      case "/flaky":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<h1>Report</h1><button type="button">Refresh</button><script>fetch("/api/flaky");</script>`),
        );
        return;
      case "/busy":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<button type="button">Go</button><script>setTimeout(() => { for (;;) {} }, 150);</script>`),
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

/** Small bounds so the ceiling is reached quickly in a test. */
const FAST = { renderWaitMs: 1_500, requestBoundMs: 1_000, hangProbeMs: 1_000 };

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
      expect(h?.signal.lastState.controls).toEqual(['button "Refresh"']);
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
      expect(result.hangs[0]?.reproduction).toMatchObject({ attempts: 2, reproduced: 0, status: "intermittent" });
      expect(result.hangs[0]?.reproduction.runs.map((r) => r.detail)).toEqual([
        "the page settled — no hang",
        "the page settled — no hang",
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
          expect(p.hang?.detail).toBe("the page's main thread did not answer a trivial probe within 1000ms");
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
