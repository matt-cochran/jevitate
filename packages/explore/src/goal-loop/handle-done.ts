/**
 * `done` and the goal-already-met check (#91, #188, #286, guardrail #4): the goal loop's done
 * handling, moved out of `explore.ts` unchanged (#232). "next" when the decision is not settled
 * here (it is acted on as usual).
 */
import { GOAL_CHECK_TRIGGER } from "../conversation.js";
import type { RunContext } from "./context.js";
import { MAX_DONE_REJECTIONS } from "./limits.js";
import type { Flow, Step } from "./step.js";

export async function handleDone(ctx: RunContext, step: Step): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record, signIn, pendingNote, acceptedBy, groundGoal } = step;
  // The decision's advisory "already met?" signal (#91): the loop used to act past a met goal
  // because the model never proposed `done`. Code grounds it BEFORE acting — once per page
  // state — and stops `done` only on the same grounded verdict a proposed `done` needs.
  // Also grounded (#188): a model `blocked` — giving up on a page that already shows the goal met
  // must not end the run incomplete — and a state where code observed the run's sign-in complete.
  if (
    (decision.op === "blocked" ||
      signIn?.completed === true ||
      (decision.goalMet !== null && decision.goalMet >= GOAL_CHECK_TRIGGER)) &&
    decision.op !== "done" &&
    decision.op !== "report" &&
    // #235: an in-run check over nothing (every check is judged after the run) shows nothing held.
    cfg.successCheckDeferred !== true &&
    // #286: a goal that asks for a report is never "already met" without its answer.
    cfg.requireAnswer !== true &&
    // #207: a find-out goal is verified by a grounded answer; its `blocked` (after a report
    // attempt on this state found none) never becomes an answerless "goal already met".
    !(ctx.findOut && decision.op === "blocked") &&
    !ctx.goalChecked.has(snap.signature)
  ) {
    ctx.goalChecked.add(snap.signature);
    const { verdict, judgments } = await groundGoal();
    if (verdict.accept) {
      record(
        true,
        `goal already met — stopped instead of "${decision.op}": ${acceptedBy(verdict.outcome)}`,
        {
          op: "done",
          control: null,
          strategy: "goal-check",
          judgments: {
            ...(judgments ?? {}),
            ...(decision.goalMet === null
              ? {}
              : { goalAlreadyMet: { value: decision.goalMet >= GOAL_CHECK_TRIGGER, probability: decision.goalMet } }),
          },
        },
      );
      ctx.outcome = verdict.outcome;
      ctx.stop = "done";
      return "stop";
    }
  }

  // #286: the goal asks for a report — `done` is no ending; the answer is (grounded by `report`).
  if (decision.op === "done" && cfg.requireAnswer === true) {
    ctx.doneRejections += 1;
    const why = "the goal asks you to report what you found: end with `report` (a grounded answer), not `done`";
    ctx.history.push(`done rejected: ${why}`);
    record(false, `done rejected (${ctx.doneRejections}/${MAX_DONE_REJECTIONS}): ${why}`);
    if (ctx.doneRejections >= MAX_DONE_REJECTIONS) {
      ctx.incomplete = `the model proposed done ${ctx.doneRejections} times, but ${why}`;
      ctx.endedOnRejectedDone = true;
      ctx.stop = "done";
      return "stop";
    }
    return "continue";
  }
  // `done` is a PROPOSAL (guardrail #4), grounded by `groundGoal`.
  if (decision.op === "done") {
    const { verdict, judgments } = await groundGoal();
    if (verdict.accept) {
      record(true, `done accepted${pendingNote(verdict.outcome) === null ? "" : " provisionally"}: ${acceptedBy(verdict.outcome)}`, {
        ...(judgments === undefined ? {} : { judgments }),
      });
      ctx.outcome = verdict.outcome;
      ctx.stop = "done";
      return "stop";
    }
    // #225: the model's `done` failed the independent success check, but the job itself is judged
    // done on this page (the advisory judgment / code-observed save, never the verdict): stop here
    // rather than spend the rest of the budget — the check's failure is the finding, and the
    // mission names it (`failed`, success-check-failed).
    if (cfg.stopWhenJudgedDone === true && cfg.successCheck !== undefined && ctx.unsent.pending().size === 0) {
      const advisory = await groundGoal(true);
      if (advisory.verdict.accept) {
        const reason = `the job was judged done on this page (${acceptedBy(advisory.verdict.outcome).replace(/^goal verified by /, "")}), but ${verdict.reason}`;
        record(false, `done rejected: ${reason} — stopped (the success check decides; it failed)`, {
          ...(advisory.judgments === undefined ? {} : { judgments: advisory.judgments }),
        });
        ctx.incomplete = reason;
        ctx.endedOnRejectedDone = true;
        ctx.stop = "done";
        return "stop";
      }
    }
    ctx.doneRejections += 1;
    ctx.history.push(`done rejected: ${verdict.reason} — keep working toward the goal`);
    record(false, `done rejected (${ctx.doneRejections}/${MAX_DONE_REJECTIONS}): ${verdict.reason}`, {
      ...(judgments === undefined ? {} : { judgments }),
    });
    if (ctx.doneRejections >= MAX_DONE_REJECTIONS) {
      ctx.incomplete = `the model proposed done ${ctx.doneRejections} times, but ${verdict.reason}`;
      ctx.endedOnRejectedDone = true;
      // #217: the loop ended on the model's `done` (code rejected it) — the stop says so; it
      // never reads `blocked` (the model did not give up). The outcome stays incomplete.
      ctx.stop = "done";
      return "stop";
    }
    return "continue";
  }
  return "next";
}
