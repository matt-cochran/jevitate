import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference } from "../testkit.js";

/**
 * #272 — a goal run spent ~108 steps re-clicking two buttons that sat BEHIND an open dialog: every
 * click failed ("<p> intercepts pointer events"), the page signature flickered (the failed click
 * scrolled the page), so no-progress never fired, and the dialog's Close was never tried.
 *
 *  - a control outside an open modal is never offered (wherever it sits: below the fold too);
 *  - a covered target that failed twice is withheld and the model is told to dismiss what covers it;
 *  - failed actions in a row end the run, naming the overlay, instead of burning the budget.
 */

const page = (overlay: string): string => `<!doctype html><html><body style="margin:0">
<h1>Decision</h1>
<a href="/home">Home</a>
<p>Questions to investigate are listed below.</p>
<div style="height:1500px"></div>
<button id="q1">Whether the product currently records signups</button>
<div style="height:1500px"></div>
<button id="q2">What observable signals would show growth</button>
<div style="height:1500px"></div>
<button id="q3">Which segment converts</button>
<p id="out"></p>
${overlay}
<script>
  for (const b of document.querySelectorAll("#q1,#q2,#q3")) b.addEventListener("click", () => {
    document.getElementById("out").textContent = "Next to investigate: " + b.textContent;
    for (const q of document.querySelectorAll("#q1,#q2,#q3")) q.remove();
  });
  const close = document.getElementById("close");
  if (close) close.addEventListener("click", (e) => { e.preventDefault(); document.getElementById("ov").remove(); });
</script>
</body></html>`;

/** A modal the snapshot can recognise (aria-modal). */
const MODAL = `<div id="ov" role="dialog" aria-modal="true" aria-label="What would help move this decision forward?"
  style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
  <div style="background:#fff;margin:40px;padding:20px;height:80vh"><p style="height:70vh">Pick what to look into next.</p>
  <a href="#" id="close">Close</a></div></div>`;
/** A dialog drawn as an overlay but not marked modal: only the click failures can tell. */
const UNMARKED = MODAL.replace(' aria-modal="true"', "");
/** The same overlay with no way out. */
const NO_EXIT = UNMARKED.replace('<a href="#" id="close">Close</a>', "");

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const html = req.url === "/modal" ? page(MODAL) : req.url === "/unmarked" ? page(UNMARKED) : page(NO_EXIT);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const GOAL = "Answer the follow-up questions until you can see what will be investigated next.";

async function run(path: string, prefs: readonly Preference[], fallback: Preference["op"] = "done"): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge(prefs, fallback);
  const result = await withSession(
    "overlay-click-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 20 },
      });
    },
    origin,
  );
  return { result, judge };
}

const QUESTIONS: Preference[] = [
  { op: "click", name: "Whether the product currently records signups" },
  { op: "click", name: "What observable signals would show growth" },
  { op: "click", name: "Which segment converts" },
];
const clicked = (r: GoalBasedResult, name: string): number =>
  r.transcript.filter((e) => e.op === "click" && e.actOk && (e.target ?? "").includes(`"${name}"`)).length;
const failedClicks = (r: GoalBasedResult): number => r.transcript.filter((e) => e.op === "click" && !e.actOk).length;

describe("#272 — controls behind an open dialog", () => {
  it(
    "a control outside an open modal is never offered: the model dismisses the dialog first, then answers",
    async () => {
      const { result, judge } = await run("/modal", [...QUESTIONS, { op: "click", name: "Close" }]);
      // While the dialog was open, none of the covered buttons was a candidate.
      expect(judge.chosen[0]).toContain('"Close"');
      expect(failedClicks(result)).toBe(0);
      expect(clicked(result, "Whether the product currently records signups")).toBe(1);
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );

  it(
    "an unmarked overlay: each covered target is withheld after two failed clicks, and the model is pointed at dismissing it",
    async () => {
      const { result, judge } = await run("/unmarked", [QUESTIONS[0]!, QUESTIONS[1]!, { op: "click", name: "Close" }]);
      // The covered buttons fail fast and named (never a 5s timeout each), get withheld after two
      // failures, the model is pointed at dismissing what covers them, and it does.
      expect(failedClicks(result)).toBeGreaterThanOrEqual(2);
      expect(failedClicks(result)).toBeLessThanOrEqual(4);
      expect(result.transcript.filter((e) => !e.actOk && e.op === "click").every((e) => /target obscured by|intercepts pointer events/.test(e.reason ?? ""))).toBe(true);
      expect(judge.states.some((s) => s.history.some((h) => /something covers it .* dismiss what covers it/.test(h)))).toBe(true);
      expect(clicked(result, "Close")).toBe(1);
      expect(clicked(result, "Whether the product currently records signups")).toBe(1);
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );

  it(
    "with no way past the overlay, failed actions in a row end the run blocked, naming the dialog — never the whole budget",
    async () => {
      const { result } = await run("/none", QUESTIONS, "wait");
      expect(failedClicks(result)).toBe(5);
      expect(result.run.stop).toBe("blocked");
      expect(result.run.outcome.status).toBe("incomplete");
      const reason = result.run.outcome.status === "incomplete" ? result.run.outcome.reason : "";
      expect(reason).toMatch(/blocked by an overlay: 5 actions in a row failed because dialog "What would help move this decision forward\?" covers the page/);
      expect(result.transcript.length).toBeLessThanOrEqual(6);
    },
    120_000,
  );
});
