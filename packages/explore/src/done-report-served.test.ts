import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { GOAL_MET_THRESHOLD } from "./conversation.js";
import { GOAL_MET_INSTRUCTIONS } from "./decide.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * Done recognition (#91) and the `report` op (#101) on served fixtures, with a scripted judge.
 *
 * #91 (Preveti J3): the bet was approved — "APPROVED" on screen — yet the loop clicked "Double down"
 * three times afterwards. #101 (Preveti J10): the answer to a find-out goal was on screen, but the run
 * had no way to end with it.
 */

/** A decision lifecycle page: Approve shows the APPROVED badge; Double down does nothing. */
const DECISION_HTML = `<!doctype html><html><body>
<h1>Bet: Raise Pro to $149</h1>
<p>Status: <span id="badge">Draft</span></p>
<p id="note"></p>
<button id="approve">Approve</button>
<button id="dd">Double down</button>
<script>
  document.getElementById("approve").addEventListener("click", () => {
    document.getElementById("badge").textContent = "APPROVED";
    document.getElementById("note").textContent = "Rationale recorded";
  });
  document.getElementById("dd").addEventListener("click", () => {});
</script>
</body></html>`;

/** A find-out goal's answer, spread over two pages. */
const SETTINGS_HTML = `<!doctype html><html><body>
<h1>Settings</h1>
<p>Plan: Pro</p>
<p>Design Partner pricing: book one customer interview per month to keep it.</p>
<a href="/billing">Billing</a>
</body></html>`;
const BILLING_HTML = `<!doctype html><html><body>
<h1>Billing</h1>
<p>Credits left: 1,200</p>
<a href="/settings">Settings</a>
</body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(url.startsWith("/settings") ? SETTINGS_HTML : url.startsWith("/billing") ? BILLING_HTML : DECISION_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function run(judge: ScriptedJudge, path: string, goal: string, gen = new FakeGenerationGateway()): Promise<ExploreRun> {
  return withSession(
    "explore-done-report-",
    async (session) => {
      const actor = CastActor.named("done-report").whoCan(new BrowseTheWeb(session, [base]));
      return explore({ actor, judge, gen, goal, allowlist: [base], startUrl: `${base}${path}`, bounds: { maxDecisions: 8 } });
    },
    base,
  );
}

const APPROVE_GOAL = "Approve the 'Raise Pro to $149' bet so it is committed with your reasoning recorded.";
const clicks = (r: ExploreRun): string[] =>
  r.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).flatMap((s) => (s.kind === "click" ? [s.target.name ?? ""] : []));

describe("done recognition (#91)", () => {
  it(
    "stops once the goal is met — the decision's 'already met' signal is grounded before acting, accepted at the threshold",
    async () => {
      const judge = new ScriptedJudge([
        { op: "click", target: "0", goalMet: 0.2 }, // Approve (nothing met yet: no check)
        { op: "click", target: "1", goalMet: 0.9 }, // Double down — but the goal is already met
        { op: "click", target: "1" },
      ]);
      judge.goalMetProbability = GOAL_MET_THRESHOLD; // exactly the calibrated threshold: accepted
      const r = await run(judge, "/decision", APPROVE_GOAL);

      expect(r.stop).toBe("done");
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-judgment" });
      // No action fired past the met goal: Approve only, never Double down.
      expect(clicks(r)).toEqual(["Approve"]);
      const last = r.transcript.at(-1);
      expect(last?.op).toBe("done");
      expect(last?.strategy).toBe("goal-check");
      expect(last?.reason).toMatch(/goal already met — stopped instead of "click"/);
      expect(last?.judgments?.goalMet).toEqual({ value: true, probability: GOAL_MET_THRESHOLD });

      // The goal judgment got a real question and the completion evidence (the badge).
      expect(judge.goalCalls).toHaveLength(1);
      const q = Object.values(judge.goalCalls[0]?.questions ?? {})[0];
      expect(q?.kind === "noul" && q.instructions).toBe(GOAL_MET_INSTRUCTIONS);
      expect(judge.goalCalls[0]?.state.controls.some((c) => c.includes("APPROVED") && c.includes("Rationale recorded"))).toBe(true);
    },
    60_000,
  );

  it(
    "a proposed done on the completed state is accepted at the threshold",
    async () => {
      const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]);
      judge.goalMetProbability = GOAL_MET_THRESHOLD;
      const r = await run(judge, "/decision", APPROVE_GOAL);
      expect(r.stop).toBe("done");
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-judgment" });
      expect(r.transcript.at(-1)?.judgments?.goalMet).toEqual({ value: true, probability: GOAL_MET_THRESHOLD });
    },
    60_000,
  );

  it(
    "a coin-flip judgment (p=0.50) never ends the run done — the signal is only a trigger, code adjudicates",
    async () => {
      const judge = new ScriptedJudge([
        { op: "click", target: "0" },
        { op: "click", target: "1", goalMet: 0.9 },
        { op: "done" },
      ]);
      judge.goalMetProbability = 0.5;
      const r = await run(judge, "/decision", APPROVE_GOAL);
      expect(clicks(r)).toEqual(["Approve", "Double down"]);
      expect(r.outcome.status).toBe("incomplete");
      const rejected = r.transcript.find((e) => e.op === "done");
      expect(rejected?.actOk).toBe(false);
      // The transcript's reading matches the verdict: p=0.50 is "not met", never "true beside rejected".
      expect(rejected?.judgments?.goalMet).toEqual({ value: false, probability: 0.5 });
    },
    60_000,
  );
});

const FIND_GOAL =
  "Find out which plan you are on, how many credits you have left, and what you need to do this month to keep your Design Partner pricing.";

describe("report — a find-out goal ends with a grounded answer (#101)", () => {
  it(
    "ends the run with the answer and its evidence when every claim is on an observed page",
    async () => {
      const gen = new FakeGenerationGateway({
        "goal.answer": {
          answer:
            "You are on the Pro plan with 1,200 credits left; to keep Design Partner pricing, book one customer interview per month.",
          claims: [
            { claim: "You are on the Pro plan", quote: "Plan: Pro" },
            { claim: "1,200 credits left", quote: "Credits left: 1,200" },
            { claim: "Book one customer interview per month to keep Design Partner pricing", quote: "book one customer interview per month." },
          ],
        },
      });
      const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "report" }]); // Billing, then report
      const r = await run(judge, "/settings", FIND_GOAL, gen);

      expect(r.stop).toBe("done");
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.answer?.text).toContain("1,200 credits left");
      // Grounded across the pages the run saw: the plan on /settings, the credits on /billing.
      const urls = (r.answer?.evidence ?? []).map((e) => new URL(e.url ?? "http://x/").pathname);
      expect(urls).toEqual(["/settings", "/billing", "/settings"]);
      expect(r.answer?.evidence.every((e) => e.grounded)).toBe(true);
      const last = r.transcript.at(-1);
      expect(last?.op).toBe("report");
      expect(last?.actOk).toBe(true);
      expect(last?.answer?.accepted).toBe(true);
      // `report` is offered to the model as a target-free action.
      expect(judge.actionOptions[0]).toContain("report");
    },
    60_000,
  );

  it(
    "rejects an ungrounded answer — never recorded as the result; repeated, the run ends incomplete",
    async () => {
      const gen = new FakeGenerationGateway({
        "goal.answer": {
          answer: "You are on the Pro plan with 5,000 credits left.",
          claims: [
            { claim: "You are on the Pro plan", quote: "Plan: Pro" },
            { claim: "5,000 credits left", quote: "Credits left: 5,000" },
          ],
        },
      });
      const judge = new ScriptedJudge([{ op: "report" }]);
      const r = await run(judge, "/settings", FIND_GOAL, gen);

      expect(r.answer).toBeUndefined();
      expect(r.stop).toBe("blocked");
      expect(r.outcome.status).toBe("incomplete");
      expect(r.outcome.status === "incomplete" && r.outcome.reason).toMatch(
        /reported an answer 3 times, but the answer is not grounded: "5,000 credits left" — quote not found/,
      );
      const reports = r.transcript.filter((e) => e.op === "report");
      expect(reports).toHaveLength(3);
      expect(reports.every((e) => !e.actOk && e.answer?.accepted === false)).toBe(true);
      expect(reports[0]?.reason).toMatch(/report rejected \(1\/3\)/);
      // The model is told why, so it can look further.
      expect(judge.states[1]?.history.some((h) => h.startsWith("report rejected:"))).toBe(true);
    },
    60_000,
  );
});
