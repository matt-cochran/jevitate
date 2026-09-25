import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { monitorFor } from "../page-monitor.js";
import { perceive } from "../perceive.js";
import { ScriptedJudge, withSession } from "../testkit.js";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { verifyFix, type VerifySession } from "../verify-fix.js";

/**
 * #153 — long-running LEGITIMATE work is not a hang: a started server stream (gRPC-web, NDJSON), a
 * slow job the page visibly acknowledges ("Drafting..." disabled + Cancel), and a link back to a
 * route visited earlier. Genuine hangs stay hangs (the same slow page whose job never ends).
 */

const held: ServerResponse[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

let server: Server;
let origin: string;
let simHits = 0;

/** A page whose content arrives over a server stream that then stays open. */
const streamPage = (endpoint: string): string =>
  html(`<div id="root"><p>Connecting…</p></div><script>
    fetch("${endpoint}", { method: "POST", headers: { "content-type": "application/grpc-web+proto" }, body: "x" })
      .then((r) => r.body.getReader().read())
      .then(() => { document.getElementById("root").innerHTML = '<p>Receiving</p><button type="button">Stop</button>'; });
  </script>`);

/** A slow job the page acknowledges: the pressed button disabled as "Drafting...", a spinner, and Cancel. */
const draftPage = (endpoint: string): string =>
  html(`<div id="root"><button type="button" id="go">Draft</button></div><script>
    document.getElementById("go").onclick = () => {
      const root = document.getElementById("root");
      root.innerHTML = '<button type="button" disabled>Drafting...</button><span class="animate-spin" style="display:inline-block;width:10px;height:10px"></span><button type="button">Cancel</button>';
      fetch("${endpoint}", { method: "POST" }).then(() => { root.innerHTML = '<p>Draft ready</p><button type="button">Edit</button>'; });
    };
  </script>`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    switch (path) {
      case "/sim":
        // A paid action whose job then hangs: the page loses its controls while the request never ends.
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<div id="root"><button type="button" id="run">Run simulation (paid)</button></div><script>
            document.getElementById("run").onclick = () => {
              document.getElementById("root").innerHTML = "<p>Please hold</p>";
              fetch("/api/sim", { method: "POST" });
            };
          </script>`),
        );
        return;
      case "/api/sim":
        simHits += 1; // every hit is one more paid simulation
        held.push(res);
        return;
      case "/rpc/Stream":
        // A gRPC-web SERVER STREAM: headers + a first message now, then it stays open.
        res.writeHead(200, { "content-type": "application/grpc-web+proto" });
        res.write(Buffer.from([0, 0, 0, 0, 1, 7]));
        held.push(res);
        return;
      case "/stream":
        res.writeHead(200, { "content-type": "text/html" }).end(streamPage("/rpc/Stream"));
        return;
      case "/api/draft":
        // A slow unary job (the 7-minute draft, scaled down): answers after 6s.
        timers.push(setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 6_000));
        return;
      case "/api/draft-never":
        held.push(res); // the same job, genuinely stuck
        return;
      case "/draft":
        res.writeHead(200, { "content-type": "text/html" }).end(draftPage("/api/draft"));
        return;
      case "/draft-stuck":
        res.writeHead(200, { "content-type": "text/html" }).end(draftPage("/api/draft-never"));
        return;
      case "/billing":
        res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>Billing</h1><a href="/activity">All credit activity</a>`));
        return;
      case "/activity":
        res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>Activity</h1><a href="/billing">Billing settings</a>`));
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
  for (const t of timers) clearTimeout(t);
  for (const r of held) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

describe("#153 — a started stream is not pending work", () => {
  it("a gRPC-web server stream whose response has started settles and is not a hang", async () => {
    const p = await withSession(
      "hang-legit-stream-",
      async (session) => {
        await monitorFor(session.page).instrument();
        await session.page.goto(`${origin}/stream`, { waitUntil: "domcontentloaded" });
        return perceive(session.page, FAST);
      },
      origin,
    );
    expect(p.settle.settled).toBe(true);
    expect(p.hang).toBeNull();
    expect(p.settle.background).toMatchObject([{ why: "stream" }]);
  });
});

describe("#153 — a job the page acknowledges is working, not hung (bounded)", () => {
  const draft = (path: string, jobWaitMs: number) =>
    withSession(
      "hang-legit-draft-",
      async (session) => {
        const actor = CastActor.named("draft").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
          gen: new FakeGenerationGateway(),
          goal: "draft it",
          allowlist: [origin],
          startUrl: `${origin}${path}`,
          successAssertion: { kind: "visible", target: { text: "Draft ready" } },
          jobWaitMs,
          oracleTimeoutMs: 2_000,
          bounds: { maxDecisions: 6 },
          ...FAST,
        });
      },
      origin,
    );

  it("a slow job with 'Drafting...' disabled + Cancel is waited out: the goal succeeds, no hang", async () => {
    const r = await draft("/draft", 30_000);
    expect(r.hang).toBeUndefined();
    expect(r.run.stop).not.toBe("hang");
    expect(r.outcome).toBe("succeeded");
    expect(r.transcript.some((e) => /not a hang yet .*the app is still working/.test(e.reason ?? ""))).toBe(true);
  }, 90_000);

  it("the SAME page whose job never ends is still a hang once the job-wait budget is spent", async () => {
    const r = await draft("/draft-stuck", 2_000);
    // It WAS given the benefit of the doubt first (the page acknowledges the job) …
    expect(r.transcript.some((e) => /not a hang yet/.test(e.reason ?? ""))).toBe(true);
    // … and past the budget the hang stands.
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("request-pending");
    // No fresh-session opener here: the hang is unconfirmed — inconclusive, never clean.
    expect(r.outcome).toBe("inconclusive");
  }, 90_000);
});

describe("#153 — a link to a route visited earlier is navigation, not an action that undid itself", () => {
  it("billing → activity → (link) billing is plain no-progress, not a ui-no-progress hang", async () => {
    const r = await withSession(
      "hang-legit-link-",
      async (session) => {
        const actor = CastActor.named("nav").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([
            { op: "click", target: "0" }, // All credit activity → /activity (new)
            { op: "click", target: "0" }, // Billing settings → /billing (visited earlier)
            { op: "scroll_down" },
          ]),
          gen: new FakeGenerationGateway(),
          goal: "find the credit activity",
          allowlist: [origin],
          startUrl: `${origin}/billing`,
          successAssertion: { kind: "visible", target: { text: "Done" } },
          stallMs: 300,
          oracleTimeoutMs: 100,
          ...FAST,
        });
      },
      origin,
    );
    expect(r.hang).toBeUndefined();
    expect(r.run.stop).toBe("no-progress");
  }, 90_000);
});

describe("#153 — a hang replay never re-sends a paid/destructive write by default", () => {
  const port = new PlaywrightBrowserPort();
  let opened = 0;
  const freshSession = async (): Promise<VerifySession> => {
    opened += 1;
    const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
    const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin]));
    return { page: session.page, actor, close: () => session.close() };
  };
  const simulate = (safety?: { hangReplayWrites: boolean }) =>
    withSession(
      "hang-legit-paid-",
      async (session) => {
        const actor = CastActor.named("sim").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
          gen: new FakeGenerationGateway(),
          goal: "run the simulation", // the goal asks for the paid action, so the run may click it once
          allowlist: [origin],
          startUrl: `${origin}/sim`,
          successAssertion: { kind: "visible", target: { text: "Results" } },
          openFreshSession: freshSession,
          oracleTimeoutMs: 200,
          ...(safety === undefined ? {} : { safety }),
          ...FAST,
        });
      },
      origin,
    );

  it("a hang reached after 'Run simulation (paid)' is NOT replayed: inconclusive, with the reason", async () => {
    simHits = 0;
    opened = 0;
    const r = await simulate();
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("request-pending");
    expect(r.outcome).toBe("inconclusive"); // never reproduced, never "not reproduced"
    expect(r.hang?.reproduction).toMatchObject({ ran: 0, reproduced: 0, status: "inconclusive", runs: [] });
    expect(r.hang?.reproduction.withheld).toMatchObject({ step: 2, control: "Run simulation (paid)", risk: "paid" });
    expect(r.reason).toContain("inconclusive: replay would repeat a paid/destructive write (step 2");
    expect(simHits).toBe(1); // the run's own click only
    expect(opened).toBe(0); // no fresh context was even opened

    // verify-fix applies the same rule: never replayed, never "fixed".
    const check = await verifyFix({
      recording: r.recording,
      recordingStepIndex: r.hang?.repro.recordingStepIndex ?? 0,
      fingerprint: r.hang?.fingerprint ?? "",
      defectKind: "hang",
      ...(r.hang === undefined ? {} : { hang: r.hang.signal }),
      openSession: freshSession,
      perceive: FAST,
    });
    expect(check.verdict).toBe("inconclusive");
    expect(check.reason).toContain("replay would repeat a paid/destructive write");
    expect(simHits).toBe(1);
    expect(opened).toBe(0);
  }, 120_000);

  it("with safety.hangReplayWrites (--hang-replay-writes) it replays, re-sending the write", async () => {
    simHits = 0;
    const r = await simulate({ hangReplayWrites: true });
    expect(r.run.stop).toBe("hang");
    expect(r.outcome).toBe("hang");
    expect(r.hang?.reproduction).toMatchObject({ attempts: 2, reproduced: 2, status: "reproduced" });
    expect(r.hang?.reproduction.withheld).toBeUndefined();
    expect(simHits).toBe(3); // the run + 2 replays, as the operator allowed
  }, 180_000);
});
