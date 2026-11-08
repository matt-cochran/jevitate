import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type JudgmentState } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { SuccessCheck } from "../success-checks.js";
import { runGoalBasedMission, type GoalBasedResult } from "../missions/goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "../testkit.js";
import { MAX_EARLY_BLOCKED_REFUSALS } from "./helpers.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #769 — a refused `blocked` must always yield another model decision. A refused `blocked` leaves
 * `lastActedOp` naming the last REAL action; the next no-progress check used to count that same
 * action again, so the refusal itself produced the no-progress stop. The refusal hint must also name
 * the control the goal explicitly names ahead of a control the page instruction merely suggests.
 */
const GOAL = "Check the demo, then press Show the demo.";

const START_HTML = `<!doctype html><html><body>
<h1>Welcome</h1>
<a href="/step">Start</a>
</body></html>`;
// Instruction text names both "check" and "show the demo"; the control labels are stripped back out.
// DOM order puts the merely plausible "Check in" before the goal's own "Show the demo".
const STEP_HTML = `<!doctype html><html><body>
<h1>Demo check</h1>
<p>Check in to continue, then show the demo.</p>
<button type="button">Refresh</button>
<button type="button">Check in</button>
<a href="/shown">Show the demo</a>
</body></html>`;
// #769's page: its instruction names `Check in` and never the goal's `Show`, whose name is a phrase of the goal.
const OFF_INSTRUCTION_HTML = `<!doctype html><html><body>
<h1>Prospect</h1>
<p>Check in to continue.</p>
<button type="button">Refresh</button>
<button type="button">Check in</button>
<a href="/shown">Show</a>
<button type="button">Share</button>
<button type="button">Business info</button>
</body></html>`;
const SHOWN_HTML = `<!doctype html><html><body>
<h1>Demo shown</h1>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const pages: Readonly<Record<string, string>> = { "/step": STEP_HTML, "/off": OFF_INSTRUCTION_HTML, "/shown": SHOWN_HTML };
    const html = pages[req.url ?? ""] ?? START_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface RunOptions {
  readonly startPath?: string;
  readonly maxDecisions?: number;
  readonly successChecks?: SuccessCheck[];
}

/** A page check that only holds on /shown — a normal (not read-only find-out) goal with an oracle. */
const DEMO_SHOWN: SuccessCheck = { kind: "page", assertion: { kind: "textIncludes", target: { css: "h1" }, text: "Demo shown" } };

async function run(prefs: (n: number, s: JudgmentState) => readonly Preference[], opts: RunOptions = {}): Promise<GoalBasedResult> {
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = 0.1;
  return withSession(
    "blocked-refusal-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}${opts.startPath ?? "/start"}`,
        waitOpMs: 300,
        bounds: { maxDecisions: opts.maxDecisions ?? 12 },
        successChecks: opts.successChecks ?? [DEMO_SHOWN],
      });
    },
    origin,
  );
}

/** Start, two no-op clicks (building the unchanged-page streak), two `blocked`s, then the goal's control. */
const streakThenRefusedThenGoalControl = (n: number): readonly Preference[] => {
  if (n === 0) return [{ op: "click", name: "Start" }];
  if (n === 1 || n === 2) return [{ op: "click", name: "Refresh" }];
  if (n === 5) return [{ op: "click", name: "Show the demo" }];
  return [];
};

const actedOn = (result: GoalBasedResult, name: string): boolean =>
  result.transcript.some((e) => e.op === "click" && e.actOk === true && (e.target ?? "").includes(`"${name}"`));

const refusedBlocked = (result: GoalBasedResult): number =>
  result.transcript.filter((e) => e.op === "blocked" && e.actOk === false && /blocked refused/.test(e.reason ?? "")).length;

describe("#769 — a refused blocked always yields another model decision", () => {
  it(
    "takes the model's next action after the refusal instead of stopping no-progress",
    async () => {
      const result = await run(streakThenRefusedThenGoalControl);
      expect(actedOn(result, "Show the demo")).toBe(true);
    },
    90_000,
  );

  it(
    "names the goal's control in the refusal hint before a merely plausible page-instruction match",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Start" }] : []));
      const reasons = result.transcript.filter((e) => e.op === "blocked").map((e) => e.reason ?? "");
      expect(reasons.some((r) => /blocked refused: "Show the demo"/.test(r))).toBe(true);
    },
    90_000,
  );

  it(
    "refuses a blocked beside the control the goal names when the page's instruction names another",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Refresh" }] : []), { startPath: "/off" });
      const reasons = result.transcript.filter((e) => e.op === "blocked").map((e) => e.reason ?? "");
      expect(reasons.some((r) => /blocked refused: "Show"/.test(r))).toBe(true);
    },
    90_000,
  );

  it(
    "goes on to the goal's control, and passes only when the success check holds, when the page's instruction does not name it",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Refresh" }] : n === 2 ? [{ op: "click", name: "Show" }] : []), { startPath: "/off" });
      expect(actedOn(result, "Show")).toBe(true);
      expect(result.outcome).toBe("succeeded");
    },
    90_000,
  );

  it(
    "does not treat a shared word as the goal naming a control the page's instruction does not name",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Refresh" }] : []), { startPath: "/off" });
      const reasons = result.transcript.filter((e) => e.op === "blocked").map((e) => e.reason ?? "");
      expect(reasons.some((r) => /blocked refused: "Share"|blocked refused: "Business info"/.test(r))).toBe(false);
    },
    90_000,
  );

  it(
    "reports an exhausted budget, not no-progress, when the budget runs out straight after a refusal",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Start" }] : []), { maxDecisions: 2 });
      expect(result.run.stop).toBe("exhausted");
    },
    90_000,
  );

  it(
    "still stops within the bounded early-blocked refusals when the model returns blocked repeatedly",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Start" }] : []));
      expect(refusedBlocked(result)).toBe(MAX_EARLY_BLOCKED_REFUSALS);
    },
    90_000,
  );

  it(
    "passes only after the independent success check holds",
    async () => {
      const result = await run(streakThenRefusedThenGoalControl);
      expect(result.outcome).toBe("succeeded");
    },
    90_000,
  );
});
