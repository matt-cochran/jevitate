import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type JudgmentState } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "../testkit.js";
import { LAST_CHANCE_NOTE } from "../goal-loop/limits.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #747 — when no-progress fires beside a unique safe forward control, the #172 last-chance turn
 * becomes the targeted #688-style recovery turn: one bounded, model-mediated attempt through that
 * control. Hidden, disabled, ambiguous, destructive, financial and approval controls stay excluded,
 * and code never clicks a candidate. Without a unique safe forward control the generic last chance
 * is unchanged.
 */

/** #747 — one unique safe forward control (`Open workspace`), named by the goal and the page's own instruction, beside one of each excluded class. */
const RECOVERY_HTML = `<!doctype html><html><body>
<main>
  <h1>Workspace</h1>
  <p>Open the workspace to continue.</p>
  <button data-testid="open" id="open" onclick="document.getElementById('result').textContent='Task complete'">Open workspace</button>
  <div id="result"></div>
  <button data-testid="hidden" id="hidden" style="display:none">Hidden action</button>
  <button data-testid="disabled" id="disabled" disabled>Disabled action</button>
  <button data-testid="ambiguous-a" id="amb-a">Duplicate action</button>
  <button data-testid="ambiguous-b" id="amb-b">Duplicate action</button>
  <button data-testid="destructive" id="destructive">Delete account</button>
  <button data-testid="financial" id="financial">Buy plan</button>
  <button data-testid="approval" id="approval">Approve request</button>
</main>
</body></html>`;

/** #747 — no unique safe forward control: the only safe control is named by neither the goal nor the page's instruction. */
const NO_FORWARD_HTML = `<!doctype html><html><body>
<main>
  <h1>Workspace</h1>
  <p>Open the workspace to continue.</p>
  <button data-testid="side" id="side">Read the help article</button>
  <button data-testid="destructive" id="destructive">Delete account</button>
</main>
</body></html>`;

/** #747 — ambiguity refusal: two safe controls both match the goal and the page's instruction, so neither is uniquely the way on. */
const AMBIGUOUS_HTML = `<!doctype html><html><body>
<main>
  <h1>Workspace</h1>
  <p>Open the workspace or open the project to continue.</p>
  <button data-testid="workspace" id="workspace">Open workspace</button>
  <button data-testid="project" id="project">Open project</button>
</main>
</body></html>`;

const GOAL = "Open the workspace and finish.";

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(req.url === "/no-forward" ? NO_FORWARD_HTML : req.url === "/ambiguous" ? AMBIGUOUS_HTML : RECOVERY_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Drives one goal-based mission from `startPath`; `prefs` scripts the model's per-decision intent. */
async function run(
  startPath: string,
  prefs: (n: number, s: JudgmentState) => readonly Preference[],
): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = 0.1;
  const result = await withSession(
    "no-progress-recovery-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}${startPath}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 20 },
        successChecks: [{ kind: "page", assertion: { kind: "textIncludes", target: { css: "#result" }, text: "Task complete" } }],
      });
    },
    origin,
  );
  return { result, judge };
}

// Four non-moving scrolls raise the no-progress streak to its bound (the first warms the baseline),
// so the next decision is the #172 last-chance turn; with a unique safe forward control it becomes
// the targeted recovery turn.
let safeRun: { result: GoalBasedResult; judge: PreferenceJudge };
let noForwardRun: { result: GoalBasedResult; judge: PreferenceJudge };
let ambiguousRun: { result: GoalBasedResult; judge: PreferenceJudge };
beforeAll(async () => {
  safeRun = await run("/recovery", (n) =>
    n <= 3 ? [{ op: "scroll_down" }] : n === 4 ? [{ op: "click", name: "Open workspace" }] : n === 5 ? [{ op: "done" }] : [],
  );
  noForwardRun = await run("/no-forward", (n) => (n <= 3 ? [{ op: "scroll_down" }] : []));
  ambiguousRun = await run("/ambiguous", (n) => (n <= 3 ? [{ op: "scroll_down" }] : []));
});

/** The decision the targeted recovery turn was made on, found by its note in the decision history. */
const recoveryAt = (judge: PreferenceJudge): number =>
  judge.states.findIndex((s) => s.history.some((h) => /unique safe forward control/.test(h)));

/** How many decisions were newly told this is the targeted recovery turn (history accumulates). */
const targetedTurns = (judge: PreferenceJudge): number =>
  judge.states.filter((s, i) => {
    const before = judge.states[i - 1]?.history.length ?? 0;
    return s.history.slice(before).some((h) => /unique safe forward control/.test(h));
  }).length;

/** The control descriptions a decision actually offered, without the prompt-injection trust guard. */
const offeredControls = (judge: PreferenceJudge, n: number): readonly string[] =>
  (judge.states[n]?.controls ?? []).filter((c) => !c.startsWith("SECURITY:"));

describe("#747 — the no-progress last chance becomes a targeted recovery turn", () => {
  it("offers only the unique safe forward control to the recovery decision", () => {
    expect(offeredControls(safeRun.judge, recoveryAt(safeRun.judge))).toHaveLength(1);
  });

  it("withholds an excluded destructive control from the recovery decision", () => {
    expect(offeredControls(safeRun.judge, recoveryAt(safeRun.judge)).join("\n")).not.toContain("Delete account");
  });

  it("gives exactly one targeted recovery turn", () => {
    expect(targetedTurns(safeRun.judge)).toBe(1);
  });

  it("reaches the goal after the model acts through the safe control", () => {
    expect(safeRun.result.outcome).toBe("succeeded");
  });

  it("never clicks an excluded control", () => {
    expect(safeRun.result.transcript.filter((e) => e.op === "click" && /Delete account/.test(e.target ?? ""))).toHaveLength(0);
  });
});

describe("#747 — without a unique safe forward control the generic last chance is unchanged", () => {
  it("keeps the generic last-chance note", () => {
    expect(noForwardRun.judge.states.some((s) => s.history.includes(LAST_CHANCE_NOTE))).toBe(true);
  });

  it("does not arm a targeted recovery turn", () => {
    expect(noForwardRun.judge.states.some((s) => s.history.some((h) => /unique safe forward control/.test(h)))).toBe(false);
  });

  it("does not arm a targeted recovery turn when two controls equally match", () => {
    expect(ambiguousRun.judge.states.some((s) => s.history.some((h) => /unique safe forward control/.test(h)))).toBe(false);
  });
});
