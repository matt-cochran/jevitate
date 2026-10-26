import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, useSkippingTime, withSession } from "../testkit.js";

/**
 * #687 / #689 — the job-wait budget and the ui-no-progress ceiling. "Approve" is accepted at once
 * and the job runs server-side: the page shows `role=status aria-busy=true data-testid=taste-busy`
 * with static text ("Approving… Working for 0:00"), no request pending and none completing, until
 * the result arrives:
 *
 *  - with an explicit --job-wait-ms the budget owns that state (a busy region the app declares), so
 *    the generic ceiling never ends the run before the job does;
 *  - without the flag the same page is still a ui-no-progress hang at the ceiling (#153);
 *  - an --ignore-no-progress pattern may name the indicator's visible words ("Approving*");
 *  - a hang that stands before the budget is spent says so, never "past the budget" (#689).
 */

/** How long the job runs after Approve (ms): real time, past the scaled-down ceiling. */
const JOB_MS = 6_000;

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

/** Approve (202 at once) → a declared busy status, nothing pending → "Design approved" + Done after JOB_MS. */
const approvePage = html(`<nav><a href="/approve">Taste</a></nav><h1>Taste</h1><button type="button" id="go">Approve</button><div id="st"></div><script>
  document.getElementById("go").onclick = () => {
    document.getElementById("go").remove();
    document.getElementById("st").innerHTML = '<div role="status" aria-busy="true" data-testid="taste-busy">Approving… Working for 0:00</div>';
    // BROWSER CODE: the server-side job's result lands after JOB_MS (a push in the field).
    fetch("/api/approve", { method: "POST", body: "{}" }).then(() => setTimeout(() => {
      document.getElementById("st").innerHTML = '<p>Design approved</p><p>Deploy it from Launch</p><button type="button">Done</button>';
    }, ${JOB_MS}));
  };
</script>`);

/** Approve answers at once; a spinner (not declared busy) + status stay while the page polls a job for 4s, then polling stops and they stay. */
const pollThenSilentPage = html(`<nav><a href="/poll-then-silent">Taste</a></nav><h1>Taste</h1><button type="button" id="go">Approve</button><div id="st"></div><script>
  document.getElementById("go").onclick = () => fetch("/api/approve-now", { method: "POST", body: "{}" }).then(() => {
    document.getElementById("go").remove();
    document.getElementById("st").innerHTML = '<span class="animate-spin" data-testid="taste-busy" style="display:inline-block;width:12px;height:12px"></span><span role="status">Generating designs…</span>';
    const started = Date.now();
    const t = setInterval(() => { if (Date.now() - started > 4000) clearInterval(t); else fetch("/api/job"); }, 1000);
  });
</script>`);

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const json = (): void => void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (path === "/api/approve" || path === "/api/approve-now" || path === "/api/job") return json();
    if (path === "/approve") return void res.writeHead(200, { "content-type": "text/html" }).end(approvePage);
    if (path === "/poll-then-silent") return void res.writeHead(200, { "content-type": "text/html" }).end(pollThenSilentPage);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** One click on Approve, then `done` — succeeded only once "Design approved" shows. */
const approve = (path: string, opts: { jobWaitMs?: number; ignore?: readonly string[] } = {}): Promise<GoalBasedResult> =>
  withSession(
    "job-wait-busy-",
    async (session) => {
      const actor = CastActor.named("approver").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        // [0] the nav link, [1] Approve.
        judge: new ScriptedJudge([{ op: "click", target: "1" }, { op: "done" }, { op: "done" }]),
        gen: new FakeGenerationGateway(),
        goal: "approve the design and wait for the result",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successAssertion: { kind: "visible", target: { text: "Design approved" } },
        ...(opts.jobWaitMs === undefined ? {} : { jobWaitMs: opts.jobWaitMs }),
        ...(opts.ignore === undefined ? {} : { hangs: { ignoreNoProgress: opts.ignore } }),
        oracleTimeoutMs: 2_000,
        bounds: { maxDecisions: 6 },
        renderWaitMs: 2_000,
        requestBoundMs: 1_500,
        hangProbeMs: 1_000,
      });
    },
    origin,
  );

const deferredFor = (r: GoalBasedResult): string | undefined => r.transcript.find((e) => /not a hang yet/.test(e.reason ?? ""))?.reason;

// #304 [realtime]: the job really runs 6s in the page; bounds scaled down (a 2s ceiling).
describe("[realtime] #687 — an explicit job-wait budget owns a busy state the app declares", () => {
  it("a 6s server-side Approve under a 20s --job-wait-ms is waited out past the 2s ceiling: the result arrives", async () => {
    const r = await approve("/approve", { jobWaitMs: 20_000 });
    expect(r.hang).toBeUndefined();
    expect(deferredFor(r)).toMatch(/aria-busy region "Approving… Working for 0:00", declared by the app/);
    expect(r.outcome).toBe("succeeded");
  }, 120_000);

  it("without --job-wait-ms the same frozen busy status is still a ui-no-progress hang at the ceiling", async () => {
    const r = await approve("/approve");
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("ui-no-progress");
    expect(r.hang?.signal.detail).toMatch(/\(\[data-testid=taste-busy\]\) never went away/);
  }, 120_000);

  it("an --ignore-no-progress pattern on the indicator's visible words ('Approving*') exempts it", async () => {
    const r = await approve("/approve", { ignore: ["Approving*"] });
    expect(r.hang).toBeUndefined();
    expect(r.run.stop).not.toBe("hang");
  }, 120_000);
});

describe("#689 — a hang that stands inside the budget says so, with its timings", () => {
  // #304: Node and page time skip idle waits (the job-wait slices, the polls).
  useSkippingTime();

  it("a busy status whose job stops answering is a hang that names the budget used, never 'past' it", async () => {
    // A budget longer than one 60s job-wait slice: the polling stops inside the first slice.
    const r = await approve("/poll-then-silent", { jobWaitMs: 300_000 });
    expect(deferredFor(r)).toMatch(/while the app kept working/);
    expect(r.run.stop).toBe("hang");
    const detail = r.hang?.signal.detail ?? "";
    expect(detail).toMatch(/the page stopped showing work code recognizes .* of the 300s job-wait budget, \d+s since the first deferral; the app's last request completed \d+s ago/);
    expect(detail).not.toMatch(/past the/);
  }, 120_000);
});
