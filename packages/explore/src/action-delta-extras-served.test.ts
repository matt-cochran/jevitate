import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { explore } from "./explore.js";
import { verifyFix, type VerifySession } from "./verify-fix.js";
import { signalFingerprint } from "./adversarial/defect-fingerprint.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { runInductionMission } from "./missions/induction.js";
import { PreferenceJudge, ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #303 extras, served in real Chromium (all behind `actionDeltas`): the persistence re-check after
 * a write (stored → yes, not stored → no), report grounding on a toast that vanished before the
 * report, verify-fix's delta comparison as evidence, and deltas in the adversarial and coverage
 * missions (defect evidence; actions with no effect).
 */

const items: Record<string, string[]> = { keep: [], lose: [] };
const LIST = (kind: string): string => `<main><h1>Items</h1><section aria-label="Groceries"><ul id="l"></ul><button id="add">Add</button></section></main><script>
  fetch("/api/items/${kind}").then((r) => r.json()).then((xs) => { for (const x of xs) { const li = document.createElement("li"); li.textContent = x; document.getElementById("l").appendChild(li); } });
  document.getElementById("add").onclick = async () => {
    const r = await fetch("/api/items/${kind}", { method: "POST", body: "Milk" });
    if (r.ok) { const li = document.createElement("li"); li.textContent = "Milk"; document.getElementById("l").appendChild(li); }
  };</script>`;

const PAGES: Record<string, string> = {
  "/keep": LIST("keep"),
  "/lose": LIST("lose"),
  "/toast": `<main><h1>Codes</h1><button id="g">Generate</button></main><script>
    document.getElementById("g").onclick = () => { const t = document.createElement("div"); t.setAttribute("role", "status"); t.textContent = "Your code is ZX4471Q";
      document.body.appendChild(t); setTimeout(() => t.remove(), 300); };</script>`,
  "/boom": `<main><h1>Boom</h1><button id="go">Go</button></main><script>document.getElementById("go").onclick = () => { fetch("/api/boom"); };</script>`,
  "/dead": `<main><h1>Dead</h1><button type="button">Nothing</button><a href="/dead2">Next</a></main>`,
  "/dead2": `<main><h1>Second</h1><a href="/dead">Back</a></main>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const m = /^\/api\/items\/(keep|lose)$/.exec(url);
    if (m !== null) {
      const kind = m[1]!;
      if (req.method === "POST") {
        if (kind === "keep") items.keep!.push("Milk"); // "lose" answers 201 and stores nothing
        return void res.writeHead(201, { "content-type": "application/json" }).end("{}");
      }
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(items[kind]));
    }
    if (url === "/api/boom") return void res.writeHead(500, { "content-type": "application/json" }).end("{}");
    const body = PAGES[url.split("?")[0] ?? ""] ?? "<p>none</p>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function addOnce(path: string) {
  const judge = new PreferenceJudge((n) => (n === 0 ? [{ op: "click", name: "Add" }] : [{ op: "blocked" }]));
  judge.goalMetProbability = 0.1;
  return withSession(
    "delta-persist-",
    async (session) =>
      explore({
        actor: CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin])),
        judge,
        gen: new FakeGenerationGateway(),
        goal: "add milk to the list",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        bounds: { maxDecisions: 3 },
        actionDeltas: { volatilityGapMs: 300 },
      }),
    origin,
  );
}

describe("#303 persistence re-check after a write (served)", () => {
  it("a write the server stored: persisted yes, after a reload (a GET — never a re-post)", async () => {
    const before = items.keep!.length;
    const run = await addOnce("/keep");
    const click = run.transcript.find((e) => e.op === "click" && e.delta !== undefined);
    expect(click?.delta?.verdict).toBe("relevant-change");
    expect(click?.delta?.persisted).toBe("yes");
    expect(items.keep!.length).toBe(before + 1); // the reload re-sent nothing
    expect(run.transcript.some((e) => e.strategy === "persistence-check")).toBe(true);
    expect(run.actionDeltas?.notPersisted).toBeUndefined();
  }, 120_000);

  it("a 2xx write the server did not store: persisted no — saved but not stored (evidence)", async () => {
    const run = await addOnce("/lose");
    const click = run.transcript.find((e) => e.op === "click" && e.delta !== undefined);
    expect(click?.delta?.persisted).toBe("no");
    expect(click?.delta?.persistedWhy).toMatch(/saved but not stored/);
    expect(run.actionDeltas?.notPersisted?.[0]?.action).toBe("click Add");
    const steps = run.recording.pages.flatMap((p) => p.steps);
    expect(steps.some((s) => s.delta?.persisted === "no")).toBe(true);
  }, 120_000);
});

describe("#303 report grounding on a delta (served)", () => {
  const reportRun = (deltas: boolean) => {
    const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "report" }]);
    const gen = new FakeGenerationGateway({ "goal.answer": { answer: "ZX4471Q", claims: [{ claim: "The generated code is ZX4471Q", quote: "Your code is ZX4471Q", absent: null }] } });
    return withSession(
      "delta-ground-",
      async (session) =>
        explore({
          actor: CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin])),
          judge,
          gen,
          goal: "find out the generated code",
          allowlist: [origin],
          startUrl: `${origin}/toast`,
          bounds: { maxDecisions: 4 },
          ...(deltas ? { actionDeltas: { volatilityGapMs: 300 } } : {}),
        }),
      origin,
    );
  };

  it("a quote found only in a toast that vanished before the report grounds the answer", async () => {
    const run = await reportRun(true);
    expect(run.answer?.text).toBe("ZX4471Q");
    expect(run.outcome.status).toBe("completed");
  }, 120_000);

  it("without deltas the same quote is on no observed page: the report is not grounded", async () => {
    const run = await reportRun(false);
    expect(run.answer).toBeUndefined();
    const report = run.transcript.find((e) => e.op === "report");
    expect(report?.actOk).toBe(false);
  }, 120_000);
});

describe("#303 verify-fix: the defect step's delta vs the recorded one is evidence (served)", () => {
  const port = new PlaywrightBrowserPort();
  const fresh = async (): Promise<VerifySession> => {
    const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
    const actor = CastActor.named("verify").whoCan(new BrowseTheWeb(session, [origin]));
    return { page: session.page, actor, close: () => session.close() };
  };
  const recording: Recording = {
    version: "1.0.0",
    site: "test",
    pages: [
      {
        url: "/boom",
        steps: [
          { step: { kind: "navigate", url: "/boom", expect: { kind: "urlIncludes", text: "/boom" } } },
          {
            step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "urlIncludes", text: "/boom" } },
            delta: { verdict: "relevant-change", why: "recorded", changes: ['+ status: Done'], overheadMs: 0 },
          },
        ],
      },
    ],
  };
  const boom = signalFingerprint({ kind: "http-5xx", detail: "500", url: `${origin}/api/boom`, status: 500 });

  it("a replay whose defect step changes the page differently from the recording says so on each attempt", async () => {
    const r = await verifyFix({ recording, recordingStepIndex: 1, fingerprint: boom, defectKind: "http-5xx", openSession: fresh, replays: 1, actionDeltas: true });
    const delta = r.attempts?.[0]?.delta;
    expect(delta?.matchesRecorded).toBe(false);
    expect(delta?.differences?.join(" ")).toMatch(/missing: \+ status: Done/);
    expect(r.reason).toMatch(/action delta differs from the recording/);
  }, 120_000);

  it("off: no delta evidence", async () => {
    const r = await verifyFix({ recording, recordingStepIndex: 1, fingerprint: boom, defectKind: "http-5xx", openSession: fresh, replays: 1 });
    expect(r.attempts?.[0]?.delta).toBeUndefined();
  }, 120_000);
});

describe("#303 deltas in the adversarial and coverage missions (served)", () => {
  it("adversarial: the defect carries the delta of the action it was first seen at", async () => {
    const result = await withSession(
      "delta-adv-",
      async (session) =>
        runAdversarialMission({
          page: session.page,
          actor: CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin])),
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/boom`,
          allowlist: [origin],
          bounds: { maxDecisions: 2 },
          strategies: ["exercise-controls"],
          actionDeltas: true,
        }),
      origin,
    );
    const defect = result.defects.find((d) => d.kind === "http-5xx");
    expect(defect?.actionDelta).toBeDefined();
    expect(defect?.actionDelta?.requests?.some((q) => /GET \/api\/boom → 500/.test(q))).toBe(true);
    expect(result.actionDeltas?.actions).toBeGreaterThanOrEqual(1);
    expect(result.transcript.some((e) => e.delta !== undefined)).toBe(true);
  }, 180_000);

  it("coverage: a control that changes nothing is listed as no-effect; the frontier is unchanged", async () => {
    const result = await withSession(
      "delta-cov-",
      async (session) =>
        runInductionMission({
          page: session.page,
          actor: CastActor.named("cov").whoCan(new BrowseTheWeb(session, [origin])),
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/dead`,
          allowlist: [origin],
          routeGlobs: ["/**"],
          maxDepth: 2,
          actionDeltas: true,
        }),
      origin,
    );
    expect(result.actionDeltas?.noEffect).toContain("click Nothing");
    expect(result.transcript.some((e) => e.delta?.verdict === "relevant-change")).toBe(true);
  }, 180_000);
});
