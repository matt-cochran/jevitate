import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";
import type { SuccessCheck } from "../success-checks.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #286 — "Refine one of your customer types … Stop at the price and don't pay. Finish by reporting the
 * price shown", checked by `requestMade:POST /v1/billing/action-quote` under `--success-when held`.
 * The model never opened the expand flow: it navigated to an UNRELATED page that fires the same quote
 * request on load, the check held mid-run ("goal already met") and the run ended `succeeded` with no
 * price reported. Now a goal that asks for a report needs its grounded answer too: checks holding
 * never end it by themselves. Real Chromium, served pages, a deterministic generator.
 */

const quote = (label: string): string =>
  `fetch("/v1/billing/action-quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "${label}" }) })`;

const PAGES: Record<string, string> = {
  "/library": `<!doctype html><html><body><main><h1>Library</h1>
<a href="/purpose">Customer purpose</a> <a href="/expand">Expand a customer type</a></main></body></html>`,
  // Unrelated: fires the quote request on LOAD, for its own "Discover / refresh" control.
  "/purpose": `<!doctype html><html><body><main><h1>Customer purpose</h1><button type="button">Discover / refresh</button></main>
<script>${quote("discover")};</script></body></html>`,
  "/expand": `<!doctype html><html><body><main><h1>Expand a customer type</h1>
<button type="button" id="q">Get price</button><p id="p"></p></main>
<script>document.getElementById("q").addEventListener("click", async () => {
  await ${quote("expand")};
  document.getElementById("p").textContent = "Price: 40 credits";
});</script></body></html>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/v1/billing/action-quote") {
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"credits":40}'));
      return;
    }
    const html = PAGES[path];
    res.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const QUOTED: SuccessCheck = { kind: "requestMade", method: "POST", pathGlob: "/v1/billing/action-quote" };
const GOAL = "Refine one of your customer types into more specific variations. Stop at the price and don't pay. Finish by reporting the price shown.";
const PRICE = { answer: "40 credits", claims: [{ claim: "The price shown is 40 credits", quote: "Price: 40 credits" }] };

async function run(steps: ScriptedStep[], goal = GOAL): Promise<GoalBasedResult> {
  return withSession(
    "goal-report-check-",
    async (session) => {
      const actor = CastActor.named("pricer").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "goal.answer": PRICE }),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/library`,
        waitOpMs: 300,
        successChecks: [QUOTED],
        successWhen: "held",
        bounds: { maxDecisions: 6 },
      });
    },
    origin,
  );
}

// /library: [0] Customer purpose, [1] Expand a customer type. /expand: [0] Get price.
describe("#286 — a goal that asks for a report is not met by its checks alone", () => {
  it(
    "the check held by an unrelated page's load-time request: the run does not stop 'goal already met', and without a price it never succeeds",
    async () => {
      const r = await run([{ op: "click", target: "0" }, { op: "scroll_down" }, { op: "done" }, { op: "blocked" }]);
      expect(r.transcript.some((e) => /goal already met/.test(e.reason ?? ""))).toBe(false);
      expect(r.transcript.some((e) => /done rejected \(1\/\d\): the goal asks you to report what you found/.test(e.reason ?? ""))).toBe(true);
      expect(r.outcome).not.toBe("succeeded");
      expect(r.checks.find((c) => c.check.startsWith("report"))).toMatchObject({ passed: false });
      expect(r.reason).toMatch(/reported no grounded answer/);
    },
    90_000,
  );

  it(
    "the expand flow, its price on the page, then `report`: the check holds and the grounded answer is the price — succeeded",
    async () => {
      const r = await run([{ op: "click", target: "1" }, { op: "click", target: "0" }, { op: "report" }]);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.text).toBe("40 credits");
      expect(r.checks.every((c) => c.passed)).toBe(true);
    },
    90_000,
  );

  it(
    "a goal that does not ask for a report still stops as soon as its checks held (#174 unchanged)",
    async () => {
      const r = await run([{ op: "click", target: "1" }, { op: "click", target: "0" }, { op: "scroll_down" }], "Get a price quote for expanding a customer type. Don't pay.");
      expect(r.transcript.some((e) => /goal already met — stopped before the next action/.test(e.reason ?? ""))).toBe(true);
      expect(r.outcome).toBe("succeeded");
    },
    90_000,
  );
});
