import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #172 — the no-progress stop fired after scrolls that MOVED the page (the control set, hence the
 * signature, is the same while the model reads down a long page), so find-out goals ended `blocked`
 * with the answer on the page. A moved scroll is progress (bounded); before a no-progress stop the
 * model gets one last-chance turn, and a find-out goal that still only idles makes a report attempt.
 */

const LONG_HTML = `<!doctype html><html><body style="margin:0">
<h1>Settings</h1>
<button id="a">Profile</button>
<div style="height:3600px">Plan details are listed below.</div>
<p>Design Partner: $300/month, price locked for 24 months.</p>
<button id="approve">Submit approval</button>
<p id="out"></p>
<script>
  document.getElementById("approve").addEventListener("click", () => { document.getElementById("out").textContent = "Approved"; });
</script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LONG_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FIND_OUT = "Find out: what does the Design Partner plan cost per month, and for how long is that price locked? Report the answer.";

async function run(steps: ScriptedStep[], goal: string, gen?: FakeGenerationGateway): Promise<{ result: GoalBasedResult; judge: ScriptedJudge }> {
  const judge = new ScriptedJudge(steps);
  const result = await withSession(
    "scroll-progress-",
    async (session) => {
      const actor = CastActor.named("reader").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen:
          gen ??
          new FakeGenerationGateway({
            "goal.answer": {
              answer: "Design Partner costs $300/month, and that price is locked for 24 months.",
              claims: [{ claim: "Design Partner costs $300/month, locked for 24 months", quote: "Design Partner: $300/month, price locked for 24 months" }],
            },
          }),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/settings`,
        waitOpMs: 300,
        bounds: { maxDecisions: 30 },
      });
    },
    origin,
  );
  return { result, judge };
}

const movedScrolls = (r: GoalBasedResult): number => r.transcript.filter((e) => e.op === "scroll_down" && /the page moved/.test(e.reason ?? "")).length;

describe("#172 — a scroll that moved the page is progress; no-progress gives one last chance", () => {
  it(
    "a find-out goal that scrolls to the bottom is never stopped mid-page; idling after it is turned into a grounded report",
    async () => {
      const { result, judge } = await run([{ op: "scroll_down" }], FIND_OUT);
      // Every scroll that moved the page was allowed (the page is ~6 scrolls long), not cut at 3.
      expect(movedScrolls(result)).toBeGreaterThanOrEqual(5);
      // The model got the last-chance turn …
      expect(judge.states.some((s) => s.history.some((h) => /you have seen the whole page/.test(h)))).toBe(true);
      // … and its idle choice became a report attempt, grounded by code on the observed page.
      expect(result.transcript.some((e) => e.op === "report" && /report accepted/.test(e.reason ?? ""))).toBe(true);
      expect(result.outcome).toBe("succeeded");
      expect(result.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(result.run.answer?.text).toContain("$300/month");
    },
    90_000,
  );

  it(
    "a goal run scrolls down a long list to the control it needs, then acts (no no-progress stop after 3 moved scrolls)",
    async () => {
      // Controls: [0] Profile, [1] Submit approval.
      const steps: ScriptedStep[] = [
        { op: "scroll_down" },
        { op: "scroll_down" },
        { op: "scroll_down" },
        { op: "scroll_down" },
        { op: "scroll_down" },
        { op: "click", target: "1" },
        { op: "done" },
      ];
      const { result } = await run(steps, "Submit the approval for the proposal");
      expect(movedScrolls(result)).toBe(5);
      expect(result.transcript.some((e) => e.op === "click" && e.actOk)).toBe(true);
      expect(result.run.stop).toBe("done");
      expect(result.outcome).toBe("succeeded");
    },
    90_000,
  );

  it(
    "a goal that keeps scrolling past the bottom still stops as no-progress, after one last-chance turn",
    async () => {
      const { result, judge } = await run([{ op: "scroll_down" }], "Submit the approval for the proposal");
      expect(result.run.stop).toBe("no-progress");
      expect(result.outcome).not.toBe("succeeded");
      expect(judge.states.filter((s) => s.history.some((h) => /you have seen the whole page/.test(h))).length).toBeGreaterThanOrEqual(1);
    },
    90_000,
  );
});
