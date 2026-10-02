import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, useSkippingTime, withSession } from "../testkit.js";

/**
 * Waits that are the app WORKING, not hung — and the frozen UIs that must still be hangs:
 *
 *  - #289: "Save changes" writes (200) and returns to the hub it came from — progress, not a page
 *          that "returned to an earlier state". The same return after a REJECTED write stays a hang.
 *  - #258: the page DOCUMENTS its wait ("This usually takes less than a minute…") — waited out, its
 *          stated duration bounding the wait; a documented wait that never ends is still a hang.
 *  - #288: a long paid job's spinner with live progress ("Drafting…" while the app polls the job) is
 *          working; the same spinner over a silent page is still a hang after the 15s-class ceiling,
 *          and a polled job that never ends is a hang once the job-wait budget is spent.
 */

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
let server: Server;
let origin: string;

/** Project settings: "Save changes" writes, then the app returns to the project hub (as designed). */
const settingsPage = (endpoint: string): string =>
  html(`<h1>Project settings</h1><label>Name <input name="name" value="Alpha"></label>
    <button type="button" id="save">Save changes</button><script>
    document.getElementById("save").onclick = () =>
      fetch("${endpoint}", { method: "POST", body: "{}" }).then(() => { location.href = "/hub"; });
  </script>`);

/** After the answer is accepted (202) the page documents its wait; the next question arrives after `doneMs` (never if null). */
const interviewPage = (copy: string, doneMs: number | null): string =>
  html(`<h1>Interview</h1><p>Question 1</p><button type="button" id="send">Submit answer</button><div id="st"></div><script>
    document.getElementById("send").onclick = () => fetch("/api/answer", { method: "POST", body: "{}" }).then(() => {
      document.getElementById("send").remove();
      document.getElementById("st").innerHTML = '<span class="spinner" style="display:inline-block;width:12px;height:12px"></span><p>' + ${JSON.stringify(copy)} + '</p>';
      ${doneMs === null ? "" : `setTimeout(() => { document.getElementById("st").innerHTML = '<p>Question 2</p><button type="button">Finish</button>'; }, ${doneMs});`}
    });
  </script>`);

/** "Confirm and draft": a spinner + "Drafting…" while the page polls the job; done after `doneMs` (never if null). */
const draftJobPage = (opts: { poll: boolean; doneMs: number | null }): string =>
  html(`<h1>Draft</h1><button type="button" id="go">Confirm and draft</button><div id="st"></div><script>
    document.getElementById("go").onclick = () => fetch("/api/draft", { method: "POST", body: "{}" }).then(() => {
      document.getElementById("go").remove();
      const started = Date.now();
      document.getElementById("st").innerHTML = '<span class="animate-spin" style="display:inline-block;width:12px;height:12px"></span><span>Drafting…</span>';
      const finish = () => { document.getElementById("st").innerHTML = '<p>Draft ready</p><button type="button">Open draft</button>'; };
      ${opts.poll ? `const t = setInterval(() => fetch("/api/job").then(() => { ${opts.doneMs === null ? "" : `if (Date.now() - started >= ${opts.doneMs}) { clearInterval(t); finish(); }`} }), 1000);` : opts.doneMs === null ? "" : `setTimeout(finish, ${opts.doneMs});`}
    });
  </script>`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const page = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    switch (path) {
      case "/hub":
        return page(html(`<h1>Alpha hub</h1><a href="/settings">Settings</a><a href="/settings-broken">Settings (broken)</a>`));
      case "/settings":
        return page(settingsPage("/api/save"));
      case "/settings-broken":
        return page(settingsPage("/api/save-broken"));
      case "/interview":
        return page(interviewPage("Your answer is saved. We're reading it carefully before the next question. This usually takes less than a minute…", 9_000));
      case "/interview-stuck":
        return page(interviewPage("Your answer is saved. We're reading it carefully. This usually takes 2 seconds…", null));
      case "/draft-job":
        return page(draftJobPage({ poll: true, doneMs: 9_000 }));
      case "/draft-job-silent":
        return page(draftJobPage({ poll: false, doneMs: null }));
      case "/draft-job-endless":
        return page(draftJobPage({ poll: true, doneMs: null }));
      case "/api/answer":
        return void res.writeHead(202, { "content-type": "application/json" }).end("{}");
      case "/api/draft":
      case "/api/job":
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      case "/api/save":
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      case "/api/save-broken":
        return void res.writeHead(500, { "content-type": "application/json" }).end("{}");
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

// #304: Node and page time (`page.clock`) skip idle waits — documented waits, job polls and hang
// ceilings elapse as soon as nothing else is happening; every bound and assertion is unchanged.
useSkippingTime();

describe("#289 — save-and-return navigation is progress, not a hang", () => {
  const saveAndReturn = (settingsLink: string) =>
    withSession(
      "hang-wait-save-",
      async (session) => {
        const actor = CastActor.named("save").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([
            { op: "click", target: settingsLink }, // hub → settings (new)
            { op: "click", target: "1" }, // Save changes → back to the hub (visited earlier)
            { op: "scroll_down" },
            { op: "scroll_down" },
          ]),
          gen: new FakeGenerationGateway(),
          goal: "rename the project",
          allowlist: [origin],
          startUrl: `${origin}/hub`,
          successAssertion: { kind: "visible", target: { text: "Renamed" } },
          stallMs: 300,
          oracleTimeoutMs: 100,
          ...FAST,
        });
      },
      origin,
    );

  it("Save changes (200) returning to the hub is not a ui-no-progress hang", async () => {
    const r = await saveAndReturn("0");
    expect(r.transcript.some((e) => e.target?.includes("Save changes") && e.actOk)).toBe(true);
    expect(r.hang).toBeUndefined();
    expect(r.run.stop).not.toBe("hang");
  }, 90_000);

  it("the same return after a REJECTED save (500) is still a ui-no-progress hang", async () => {
    const r = await saveAndReturn("1");
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("ui-no-progress");
    expect(r.hang?.signal.detail).toMatch(/returned to an earlier state/);
  }, 90_000);
});

/** One click on the page's first control, then `done` — succeeded only if `success` text shows. */
const clickAndWait = (path: string, success: string, jobWaitMs?: number) =>
  withSession(
    "hang-wait-job-",
    async (session) => {
      const actor = CastActor.named("job").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }, { op: "done" }]),
        gen: new FakeGenerationGateway(),
        goal: "start the job and wait for its result",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successAssertion: { kind: "visible", target: { text: success } },
        ...(jobWaitMs === undefined ? {} : { jobWaitMs }),
        oracleTimeoutMs: 2_000,
        bounds: { maxDecisions: 6 },
        ...FAST,
      });
    },
    origin,
  );
const deferred = (r: Awaited<ReturnType<typeof clickAndWait>>): boolean => r.transcript.some((e) => /not a hang yet/.test(e.reason ?? ""));

describe("#258 — a wait the page documents is waited out, bounded by what it states", () => {
  it("'This usually takes less than a minute…' after a 202 is not a hang: the next question arrives", async () => {
    const r = await clickAndWait("/interview", "Question 2");
    expect(r.hang).toBeUndefined();
    expect(r.transcript.some((e) => /documented wait/.test(e.reason ?? ""))).toBe(true);
    expect(r.outcome).toBe("succeeded");
  }, 120_000);

  it("a documented wait that never ends is still a hang once its stated time (x2 + grace) has passed", async () => {
    const r = await clickAndWait("/interview-stuck", "Question 2", 1_000);
    expect(deferred(r)).toBe(true);
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("ui-no-progress");
    expect(r.hang?.signal.detail).toMatch(/job-wait budget; raise --job-wait-ms/);
  }, 180_000);
});

describe("#288 — a long job's spinner with live progress is working, a frozen one is a hang", () => {
  it("a spinner + 'Drafting…' while the app polls the job is waited out (job-wait budget): the draft arrives", async () => {
    const r = await clickAndWait("/draft-job", "Draft ready", 60_000);
    expect(r.hang).toBeUndefined();
    expect(r.transcript.some((e) => /while the app kept working/.test(e.reason ?? ""))).toBe(true);
    expect(r.outcome).toBe("succeeded");
  }, 120_000);

  it("the same spinner over a SILENT page (no polling, no progress) is still a hang at the ceiling", async () => {
    const r = await clickAndWait("/draft-job-silent", "Draft ready", 60_000);
    expect(deferred(r)).toBe(false);
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("ui-no-progress");
  }, 120_000);

  it("a polled job that never finishes is a hang once the job-wait budget is spent, saying how to raise it", async () => {
    const r = await clickAndWait("/draft-job-endless", "Draft ready", 6_000);
    expect(deferred(r)).toBe(true);
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.signal.detail).toMatch(/past the 6s job-wait budget; raise --job-wait-ms/);
  }, 120_000);
});
