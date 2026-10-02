/**
 * The goal loop's decision (#172, #192, #207): the model's next op on the page view — retried within
 * a refused choice cap, and turned into a grounded report attempt for a find-out goal that would
 * only idle or give up. Moved out of `explore.ts` unchanged (#232).
 */

import { decide, type Decision } from "../decide.js";
import { describeStatus, isEmptyStatus } from "../status.js";
import type { RunContext } from "./context.js";
import { TOO_MANY_CHOICES, TOO_MANY_CHOICES_RETRY, firstLine } from "./helpers.js";
import type { PageView } from "./page-view.js";
import type { Perceived } from "./step.js";

export async function decideStep(ctx: RunContext, step: Perceived, view: PageView): Promise<Decision | "stop"> {
  const { cfg } = ctx;
  const { perception, snap } = step;
  const { modelControls, offered, unsubmitted, visibleText } = view;
  let decision: Awaited<ReturnType<typeof decide>>;
  try {
    // #192: the choice cap is bounded in decide(); should the API still refuse the count (a
    // lower limit than documented), retry with a tighter budget instead of ending the run.
    const decideWith = (maxChoices?: number): Promise<Decision> =>
      decide(cfg.judge, {
        goal: cfg.goal,
        snapshot: modelControls === snap.controls ? snap : { ...snap, controls: modelControls },
        history: ctx.history,
        missionContext: ctx.missionContext,
        secrets: ctx.secrets,
        // One fixture ⇒ one upload: once attached, upload actions leave the candidate set (the
        // model had kept re-choosing it after a successful attach instead of proceeding).
        uploadAvailable: ctx.fixture !== null && !ctx.fixtureAttached,
        offered,
        unsubmitted,
        ...(ctx.conversation.latestReply === null && ctx.conversation.sent.length === 0
          ? {}
          : { conversation: { latestReply: ctx.conversation.latestReply, sentMessages: ctx.conversation.sent } }),
        ...(isEmptyStatus(ctx.status) ? {} : { pageStatus: describeStatus(ctx.status) }),
        ...(maxChoices === undefined ? {} : { maxChoices }),
        ...(ctx.findOut ? { pageText: visibleText } : {}),
        ...(ctx.deltas === null ? {} : { actionDeltas: true }),
      });
    decision = await decideWith().catch(async (e: unknown) => {
      const refusal = firstLine(e);
      if (!TOO_MANY_CHOICES.test(refusal)) throw e;
      // The refusal names the limit it enforces ("at most N choices"): retry within it.
      const stated = Number(/at most (\d+)/i.exec(refusal)?.[1]);
      const budget = Number.isInteger(stated) && stated > 0 ? stated : TOO_MANY_CHOICES_RETRY;
      ctx.history.push(`the decision had too many choices for the model: retried with the ${budget} most relevant`);
      return decideWith(budget);
    });
  } catch (e) {
    // The decision IS the goal loop's engine: without it the run can prove nothing more, so it
    // ends `inconclusive` (typed) with everything recorded so far — never a throw, never clean.
    ctx.failure = { kind: "exception", message: `model decision unavailable: ${firstLine(e)}` };
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "model",
      actOk: false,
      reason: ctx.failure.message,
      snapshot: snap,
      timing: perception.timing,
    });
    ctx.stop = "inconclusive";
    return "stop";
  }
  ctx.tracker.countDecision();
  if (
    ctx.lastChanceTurn &&
    cfg.readOnly === true &&
    (decision.op === "scroll_down" || decision.op === "scroll_up" || decision.op === "wait" || decision.op === "blocked")
  ) {
    // #172 — a find-out goal that has seen the whole page and still only idles (or gives up)
    // ends with a report ATTEMPT, grounded by code like any report, never a bare `blocked`.
    ctx.history.push(`last chance: "${decision.op}" became a report attempt — the answer must be on the pages already seen`);
    decision = { ...decision, op: "report", control: null, targetMissing: false };
  }
  if (ctx.findOut && decision.op === "blocked" && !ctx.blockedReported.has(snap.signature)) {
    // #207 — a find-out goal's `blocked` is never a bare give-up while the page may show the
    // answer as plain text: one report ATTEMPT on this page state first, grounded by code.
    ctx.blockedReported.add(snap.signature);
    ctx.history.push(`"blocked" became a report attempt — a find-out goal is answered from the pages already seen`);
    decision = { ...decision, op: "report", control: null, targetMissing: false };
  }

  return decision;
}
