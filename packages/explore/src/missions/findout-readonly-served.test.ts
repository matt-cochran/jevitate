import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SafetyConfig } from "../safety.js";
import { goalAsksForChange } from "../read-only.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #157 / #158 on a served pricing page. Allumata dogfood round 2: asked what the Design Partner plan
 * costs, the goal model clicked "Upgrade to Design Partner" (a checkout session reserved one of 250
 * seats) and "Manage subscription", though the answer was on the page; and a correct answer naming
 * "no2fa" was rejected because the "2" inside the word counted as a stated figure.
 */

const BILLING_HTML = `<!doctype html><html><body>
<h1>Billing</h1>
<p>Design Partner: $299/mo · 24 months, then Validate.</p>
<p>Every plan includes 2FA and the v2 API.</p>
<button id="up">Upgrade to Design Partner</button>
<button id="manage">Manage subscription</button>
<button id="details">Show details</button>
<p id="out"></p>
<script>
  const post = (u) => fetch(u, { method: "POST" }).then(() => { document.getElementById("out").textContent = "sent " + u; }, () => {});
  document.getElementById("up").addEventListener("click", () => post("/api/checkout"));
  document.getElementById("manage").addEventListener("click", () => post("/api/portal"));
  // A harmless-looking control that still writes: only the network guard can stop it.
  document.getElementById("details").addEventListener("click", () => post("/api/track"));
</script>
</body></html>`;

let server: Server;
let origin: string;
let writes: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      writes.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(BILLING_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  writes = [];
});

const GOAL = "Find out: what does the Design Partner plan cost, and for how long? What happens after that period? Report the answer.";

const ANSWER = {
  "goal.answer": {
    answer: "Design Partner costs $299/mo for 24 months, then moves to Validate. It includes 2FA and the v2 API.",
    claims: [
      { claim: "Design Partner costs $299/mo for 24 months, then Validate", quote: "Design Partner: $299/mo · 24 months, then Validate" },
      { claim: "It includes 2FA and the v2 API", quote: "Every plan includes 2FA and the v2 API" },
    ],
  },
};

async function run(steps: ScriptedStep[], safety?: SafetyConfig): Promise<{ result: GoalBasedResult; judge: ScriptedJudge }> {
  const judge = new ScriptedJudge(steps);
  const result = await withSession(
    "findout-readonly-",
    async (session) => {
      const actor = CastActor.named("findout").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(ANSWER),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}/settings/billing`,
        waitOpMs: 300,
        bounds: { maxDecisions: 10 },
        ...(safety === undefined ? {} : { safety }),
      });
    },
    origin,
  );
  return { result, judge };
}

describe("a find-out goal is read-only by default (#158) and answers with 2FA/v2 are grounded (#157)", () => {
  it(
    "never clicks Upgrade / Manage subscription, blocks a write a harmless control fires, and still answers from the page",
    async () => {
      // Controls: [0] Upgrade to Design Partner, [1] Manage subscription, [2] Show details.
      const { result, judge } = await run([
        { op: "click", target: "0" },
        { op: "click", target: "1" },
        { op: "click", target: "2" },
        { op: "report" },
      ]);

      // No write ever reached the server.
      expect(writes).toEqual([]);
      // Both flow controls were refused by code, before any interaction — recorded as engine refusals.
      const refusals = result.transcript.filter((e) => e.origin === "engine" && /read-only/.test(e.reason ?? ""));
      expect(refusals.some((e) => e.op === "click" && /Upgrade to Design Partner/.test(e.reason ?? ""))).toBe(true);
      expect(refusals.some((e) => e.op === "click" && /Manage subscription/.test(e.reason ?? ""))).toBe(true);
      // Show details was clicked, but the POST it fired was aborted in the browser and recorded.
      expect(refusals.some((e) => e.strategy === "read-only" && /POST \/api\/track/.test(e.reason ?? ""))).toBe(true);
      // The model was told the goal is read-only, and about each refusal.
      const history = judge.states.at(-1)?.history ?? [];
      expect(history.some((h) => /READ-ONLY/.test(h))).toBe(true);
      expect(history.some((h) => /Upgrade to Design Partner/.test(h) && /read-only/.test(h))).toBe(true);

      // The grounded answer — "2FA" and "v2" are words, not figures (#157).
      expect(result.outcome).toBe("succeeded");
      expect(result.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(result.run.answer?.text).toContain("2FA");
    },
    60_000,
  );

  it(
    "--allow-writes lets the find-out goal write (the #116 safety policy still holds)",
    async () => {
      const { result } = await run([{ op: "click", target: "2" }, { op: "click", target: "0" }, { op: "report" }], { allowWrites: true });

      expect(writes).toEqual(["/api/track"]);
      expect(result.transcript.some((e) => e.strategy === "read-only")).toBe(false);
      // Upgrade is still a paid control the goal does not ask for: refused by #116, not by the read-only guard.
      const upgrade = result.transcript.find((e) => e.op === "click" && /Upgrade/.test(e.reason ?? ""));
      expect(upgrade?.reason).toMatch(/refused by the safety policy/);
      expect(result.outcome).toBe("succeeded");
    },
    60_000,
  );
});

describe("goalAsksForChange", () => {
  it("a goal that asks for a change is not read-only; one that only asks about it is", () => {
    expect(goalAsksForChange("Create a new API key named 'ci'")).toBe(true);
    expect(goalAsksForChange("Upgrade to the Pro plan and report the price")).toBe(true);
    expect(goalAsksForChange(GOAL)).toBe(false);
    expect(goalAsksForChange("Find out how to add a teammate")).toBe(false);
    expect(goalAsksForChange("What happens if I delete my workspace?")).toBe(false);
    expect(goalAsksForChange("Find out what the plan is set to and when the quota resets")).toBe(false);
  });
});
