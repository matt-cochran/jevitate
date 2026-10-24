/**
 * `done` and the goal-already-met check (#91, #188, #286, guardrail #4): the goal loop's done
 * handling, moved out of `explore.ts` unchanged (#232). "next" when the decision is not settled
 * here (it is acted on as usual).
 */
import { GOAL_CHECK_TRIGGER, type DoneVerdict, type RunOutcome } from "../conversation.js";
import type { RunContext } from "./context.js";
import { MAX_DONE_REJECTIONS } from "./limits.js";
import { deferEnding } from "./min-effort.js";
import { readBackProbe, unreadShown } from "./read-back.js";
import type { Flow, Step } from "./step.js";

/**
 * #647: why an ending judged from the page must wait — the page shows what the run sent and a reload
 * (the read-back probe) did not show it again: a 2xx is not proof the app kept it. Null when the page
 * shows none of it (a write-only form), the probe read it all back, or the operator's success check
 * decided.
 */
/** #667: why a write goal's done cannot hold before any write of the run succeeded. */
export const NO_WRITE_YET =
  "no write of this run has succeeded yet — the goal asks for a change the app must receive: go back and press the control that submits it (Import, Save, Send…)";

async function unreadWriteHold(ctx: RunContext, step: Step, outcome: RunOutcome): Promise<string | null> {
  if (outcome.status === "completed" && outcome.verifiedBy === "success-condition") return null;
  await readBackProbe(ctx, step);
  const unread = unreadShown(ctx, step);
  if (unread.length === 0) return null;
  return `what the run sent (${unread.map((v) => `"${v}"`).join(", ")}) has not shown on a page loaded since the write — the app may not have kept it (open the page where the app lists it)`;
}

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
    !ctx.goalChecked.has(snap.signature) &&
    // #424: without a success check, "already met" is a conclusion — not before the minimum effort.
    !(cfg.successCheck === undefined && ctx.minEffort !== null && ctx.depth.report(ctx.tracker.actions, ctx.tracker.decisions, ctx.minEffort).minimum?.met === false)
  ) {
    ctx.goalChecked.add(snap.signature);
    const { verdict, judgments } = await groundGoal();
    // #647: never "already met" on what the run sent before it is read back.
    if (verdict.accept && (await unreadWriteHold(ctx, step, verdict.outcome)) === null) {
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
  // #424: without a success check, the model's `done` concludes the run — deferred below the minimum
  // exploration effort (a goal with checks is decided by them, never by the minimum).
  if (decision.op === "done" && cfg.successCheck === undefined) {
    const deferred = deferEnding(ctx, step, "done");
    if (deferred !== null) {
      record(false, deferred, { origin: "engine" });
      return "continue";
    }
  }
  // `done` is a PROPOSAL (guardrail #4), grounded by `groundGoal`.
  if (decision.op === "done") {
    // #514: a proposed `done` also weighs the job's own write evidence.
    const grounded = await groundGoal(false, true);
    const { judgments } = grounded;
    let verdict: DoneVerdict = grounded.verdict;
    // #647: judged done on what the run sent, before any page loaded since has shown it. The first
    // time the run is asked to read it back (not a rejection); after that it is one.
    const hold = verdict.accept ? await unreadWriteHold(ctx, step, verdict.outcome) : null;
    if (hold !== null) {
      if (!ctx.readBackAsked) {
        ctx.readBackAsked = true;
        ctx.history.push(`done deferred: ${hold}`);
        record(false, `done deferred: ${hold}`, { origin: "engine" });
        return "continue";
      }
      verdict = { accept: false, reason: hold };
    }
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
    // #667: a write goal ended before anything was sent — say so (code knows it), not only that the
    // page does not look done: the model otherwise wanders away from the step that writes.
    const why = ctx.writeGoal && !ctx.wroteOk ? `${verdict.reason}; ${NO_WRITE_YET}` : verdict.reason;
    ctx.history.push(`done rejected: ${why} — keep working toward the goal`);
    record(false, `done rejected (${ctx.doneRejections}/${MAX_DONE_REJECTIONS}): ${why}`, {
      ...(judgments === undefined ? {} : { judgments }),
    });
    if (ctx.doneRejections >= MAX_DONE_REJECTIONS) {
      ctx.incomplete = `the model proposed done ${ctx.doneRejections} times, but ${why}`;
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
