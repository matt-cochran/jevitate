import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./missions/goal-based.js";
import { evaluateOutcomeChecks } from "./outcome-checks.js";
import type { HttpProbe } from "./http-check.js";
import type { SuccessCheck } from "./success-checks.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #543 — an `http` success check: the goal mission defers it to the final oracle (probing it once
 * before the first action for vacuity), and the shared oracle evaluates it last, after the reload.
 * Served pages, real Chromium, scripted judges only. The "outbox" is a JSON endpoint the page's
 * write fills — the app UI never shows it.
 */

const FORGOT = `<!doctype html><html><body><h1>Forgot password</h1>
  <p id="s">idle</p>
  <button type="button" onclick="fetch('/api/reset', { method: 'POST' }).then(() => { document.getElementById('s').textContent = 'Sent'; })">Send reset link</button>
  </body></html>`;

let server: Server;
let origin: string;
let outbox: string[] = [];
let pageLoads = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/reset" && req.method === "POST") {
      outbox.push("Reset your password");
      res.writeHead(202, { "content-type": "application/json" }).end("{}");
    } else if (path === "/outbox") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ messages: outbox.map((Subject) => ({ Subject })) }));
    } else if (path === "/forgot") {
      pageLoads += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORGOT);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  outbox = [];
  pageLoads = 0;
});

const resetMail = (): SuccessCheck => ({
  kind: "http",
  method: "GET",
  url: `${origin}/outbox`,
  json: [{ path: "$.messages[*].Subject", op: "includes", value: "Reset" }],
  withinMs: 2_000,
});

/** A plain fetch probe, counting its calls (the CLI's own probe is tested in the cli package). */
function countingProbe(onCall: () => void = () => undefined): { probe: HttpProbe; calls: () => number } {
  let n = 0;
  return {
    probe: async (url) => {
      n += 1;
      onCall();
      const r = await fetch(url, { redirect: "manual" });
      return { status: r.status, bodyText: await r.text() };
    },
    calls: () => n,
  };
}

async function runGoal(steps: ScriptedStep[], probe: HttpProbe): Promise<GoalBasedResult> {
  return withSession(
    "http-check-",
    async (session) => {
      const actor = CastActor.named("http").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({}),
        goal: "send a password reset email",
        allowlist: [origin],
        startUrl: `${origin}/forgot`,
        successChecks: [resetMail()],
        httpProbe: probe,
        oracleTimeoutMs: 300,
        waitOpMs: 300,
        bounds: { maxDecisions: 8 },
      });
    },
    origin,
  );
}

describe("#543 goal mission: an http success check", () => {
  it(
    "passes when the run's own write puts the mail in the outbox",
    async () => {
      const result = await runGoal([{ op: "click", target: "0" }, { op: "done" }], countingProbe().probe);
      expect(result.outcome).toBe("succeeded");
    },
    120_000,
  );

  it(
    "is probed once before the first action and otherwise only by the final oracle",
    async () => {
      const p = countingProbe();
      await runGoal([{ op: "click", target: "0" }, { op: "click", target: "0" }, { op: "done" }], p.probe);
      expect(p.calls()).toBe(2);
    },
    120_000,
  );

  it(
    "fails as vacuous when it already held before the first action",
    async () => {
      outbox = ["Reset your password"];
      const result = await runGoal([{ op: "click", target: "0" }, { op: "done" }], countingProbe().probe);
      expect(result.checks[0]?.detail).toMatch(/^vacuous:/);
    },
    120_000,
  );
});

describe("#543 evaluateOutcomeChecks: an http check", () => {
  async function evaluate(checks: SuccessCheck[], probe?: HttpProbe) {
    return withSession(
      "http-oracle-",
      async (session) => {
        await session.page.goto(`${origin}/forgot`);
        const actor = CastActor.named("oracle").whoCan(new BrowseTheWeb(session, [origin]));
        return evaluateOutcomeChecks(checks, { actor, page: session.page, capture: null, settleMs: 500, ...(probe === undefined ? {} : { httpProbe: probe }) });
      },
      origin,
    );
  }

  it(
    "fails closed as unevaluable without a probe",
    async () => {
      const [r] = await evaluate([resetMail()]);
      expect(r).toMatchObject({ passed: false, unevaluable: true });
    },
    120_000,
  );

  it(
    "is evaluated after the reloadThen reload",
    async () => {
      let loadsAtProbe = 0;
      outbox = ["Reset your password"];
      const p = countingProbe(() => {
        loadsAtProbe = pageLoads;
      });
      await evaluate([resetMail(), { kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "h1" }, text: "Forgot" } }], p.probe);
      expect(loadsAtProbe).toBe(2);
    },
    120_000,
  );

  it(
    "keeps the results in the order the checks were given",
    async () => {
      outbox = ["Reset your password"];
      const page: SuccessCheck = { kind: "page", assertion: { kind: "textIncludes", target: { css: "h1" }, text: "Forgot" } };
      const results = await evaluate([resetMail(), page], countingProbe().probe);
      expect(results.map((r) => r.check.split(":")[0])).toEqual(["http", "textIncludes"]);
    },
    120_000,
  );
});
