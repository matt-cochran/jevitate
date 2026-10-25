import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type JudgmentState } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { snapshot } from "../index.js";
import { collectActionableControlEvidence } from "../goal-loop/handle-blocked.js";
import type { ActionableControlEvidence } from "../goal-loop/context/types.js";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, useSkippingTime, withSession, type Preference } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #688 — the actionable-control recovery evidence contract. A served fixture carries one control of
 * each class the recovery must tell apart: a visible enabled safe control, and hidden, disabled,
 * ambiguous, destructive, financial and approval controls. `collectActionableControlEvidence`
 * OBSERVES the page only — it never selects, clicks or otherwise executes a candidate. Each piece of
 * evidence carries a durable locator, a screenshot, the safety predicate, and the exact resume
 * identity (page URL + page-state signature + the control's locator).
 */

const FIXTURE_HTML = `<!doctype html><html><body>
<main>
  <h1>Recovery fixture</h1>
  <button data-testid="safe" id="safe">Save draft</button>
  <button data-testid="hidden" id="hidden" style="display:none">Hidden action</button>
  <button data-testid="disabled" id="disabled" disabled>Disabled action</button>
  <button data-testid="ambiguous-a" id="amb-a">Duplicate action</button>
  <button data-testid="ambiguous-b" id="amb-b">Duplicate action</button>
  <button data-testid="destructive" id="destructive">Delete account</button>
  <button data-testid="financial" id="financial">Buy plan</button>
  <button data-testid="approval" id="approval">Approve request</button>
</main>
</body></html>`;

/** #688 — a page a blocked run can recover through: one visible enabled safe control (`Done`) and one of each excluded class. */
const RECOVERY_WORK_HTML = `<!doctype html><html><body>
<main>
  <h1>Work</h1>
  <button data-testid="done" id="done">Done</button>
  <button data-testid="hidden" id="hidden" style="display:none">Hidden action</button>
  <button data-testid="disabled" id="disabled" disabled>Disabled action</button>
  <button data-testid="ambiguous-a" id="amb-a">Duplicate action</button>
  <button data-testid="ambiguous-b" id="amb-b">Duplicate action</button>
  <button data-testid="destructive" id="destructive">Delete account</button>
  <button data-testid="financial" id="financial">Buy plan</button>
  <button data-testid="approval" id="approval">Approve request</button>
</main>
</body></html>`;

/** #688 — a page with NO safe candidate: every control is hidden, disabled, ambiguous, destructive, financial or approval. */
const RECOVERY_NO_SAFE_HTML = `<!doctype html><html><body>
<main>
  <h1>No safe control</h1>
  <button data-testid="destructive" id="destructive">Delete account</button>
  <button data-testid="financial" id="financial">Buy plan</button>
  <button data-testid="approval" id="approval">Approve request</button>
  <button data-testid="ambiguous-a" id="amb-a">Duplicate action</button>
  <button data-testid="ambiguous-b" id="amb-b">Duplicate action</button>
  <button data-testid="disabled" id="disabled" disabled>Disabled action</button>
</main>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const html = req.url === "/work" ? RECOVERY_WORK_HTML : req.url === "/no-safe" ? RECOVERY_NO_SAFE_HTML : FIXTURE_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let evidence: readonly ActionableControlEvidence[] = [];
let pageState = "";

beforeAll(async () => {
  await withSession(
    "actionable-recovery-",
    async (session) => {
      await session.page.goto(`${origin}/fixture`, { waitUntil: "domcontentloaded" });
      pageState = (await snapshot(session.page)).signature;
      evidence = await collectActionableControlEvidence(session.page);
    },
    origin,
  );
});

function evidenceFor(testId: string): ActionableControlEvidence {
  const found = evidence.find((e) => e.locator === `[data-testid="${testId}"]`);
  if (found === undefined) throw new Error(`no recovery evidence for ${testId}`);
  return found;
}

const kindOf = (testId: string): string => evidenceFor(testId).kind;

describe("#688 — the served fixture tells the control classes apart", () => {
  it("classifies a visible enabled safe control as safe", () => {
    expect(kindOf("safe")).toBe("safe");
  });

  it("classifies a hidden control as hidden", () => {
    expect(kindOf("hidden")).toBe("hidden");
  });

  it("classifies a disabled control as disabled", () => {
    expect(kindOf("disabled")).toBe("disabled");
  });

  it("classifies a control whose name another control shares as ambiguous", () => {
    expect(kindOf("ambiguous-a")).toBe("ambiguous");
  });

  it("classifies a destructive control as destructive", () => {
    expect(kindOf("destructive")).toBe("destructive");
  });

  it("classifies a control that costs money as financial", () => {
    expect(kindOf("financial")).toBe("financial");
  });

  it("classifies a control that grants approval as approval", () => {
    expect(kindOf("approval")).toBe("approval");
  });
});

let workState = "";
let noSafeState = "";
beforeAll(async () => {
  await withSession(
    "actionable-recovery-states-",
    async (session) => {
      await session.page.goto(`${origin}/work`, { waitUntil: "domcontentloaded" });
      workState = (await snapshot(session.page)).signature;
      await session.page.goto(`${origin}/no-safe`, { waitUntil: "domcontentloaded" });
      noSafeState = (await snapshot(session.page)).signature;
    },
    origin,
  );
});

/** Drives one goal-based mission from `startPath`; `prefs` scripts the model's per-decision intent. */
async function runRecovery(
  startPath: string,
  prefs: (n: number, s: JudgmentState) => readonly Preference[],
): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = 0.1;
  const result = await withSession(
    "actionable-recovery-run-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Submit the task on this page to complete it.",
        allowlist: [origin],
        startUrl: `${origin}${startPath}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 12 },
      });
    },
    origin,
  );
  return { result, judge };
}

// One reload makes the run's own actions non-zero, so a later `blocked` is the model's, not the
// #237 early refusal; every later decision is `blocked`, so the run's only way on is recovery.
let safeRun: { result: GoalBasedResult; judge: PreferenceJudge };
let noSafeRun: { result: GoalBasedResult; judge: PreferenceJudge };
beforeAll(async () => {
  safeRun = await runRecovery("/work", (n) => (n === 0 ? [{ op: "reload" }] : []));
  noSafeRun = await runRecovery("/no-safe", (n) => (n === 0 ? [{ op: "reload" }] : []));
});

describe("#688 — one bounded recovery turn after blocked", () => {
  it("gives the model exactly one recovery turn beside a visible enabled safe control", () => {
    expect(safeRun.judge.calls).toHaveLength(3);
  });

  it("withholds excluded controls from the recovery turn", () => {
    expect(safeRun.judge.states[2]?.controls.join("\n")).not.toContain("Delete account");
  });

  it("preserves the exact terminal resume identity of the safe control", () => {
    const identity = JSON.stringify({ url: `${origin}/work`, state: workState, locator: '[data-testid="done"]' });
    expect(safeRun.result.run.outcome.status === "incomplete" ? safeRun.result.run.outcome.reason : "").toContain(identity);
  });

  it("does not grant a recovery turn when no safe candidate exists", () => {
    expect(noSafeRun.judge.calls).toHaveLength(2);
  });

  it("never automatically selects an excluded control", () => {
    const acted = noSafeRun.result.transcript.filter(
      (e) => e.op === "click" || e.op === "type" || e.op === "select" || e.op === "upload" || e.op === "send" || e.op === "edit_text",
    );
    expect(acted).toHaveLength(0);
  });

  it("preserves the exact terminal resume identity when no safe candidate exists", () => {
    const identity = JSON.stringify({ url: `${origin}/no-safe`, state: noSafeState, locator: '[data-testid="destructive"]' });
    expect(noSafeRun.result.run.outcome.status === "incomplete" ? noSafeRun.result.run.outcome.reason : "").toContain(identity);
  });
});

describe("#688 — every safe outcome carries its recovery evidence", () => {
  it("carries a durable locator for the safe control", () => {
    expect(evidenceFor("safe").locator).toBe('[data-testid="safe"]');
  });

  it("carries a screenshot for the safe control", () => {
    expect(evidenceFor("safe").screenshot).toMatch(/^data:image\/png;base64,/);
  });

  it("carries a non-empty safety predicate for the safe control", () => {
    expect(evidenceFor("safe").predicate.length).toBeGreaterThan(0);
  });

  it("carries the exact resume identity for the safe control", () => {
    expect(evidenceFor("safe").resume).toEqual({
      url: `${origin}/fixture`,
      state: pageState,
      locator: '[data-testid="safe"]',
    });
  });
});
