/**
 * The no-ops a planned misuse step can be before it fires (#116, #150, #188, #193, #300): its control
 * is gone, disabled right now, switched the identity earlier, refused by the safety policy, or would
 * cross the spend budget — each recorded, none counted as an action. Moved out of `runEpisode`
 * unchanged (#232). "stop" ends the episode (its former `break`).
 */

import { controlKey, type MisuseStep } from "../../adversarial/form-misuse.js";
import { controlIdentity } from "../../coverage/fingerprint.js";
import type { HuntState } from "./context.js";
import type { EpisodeState, Turn } from "./episode.js";
import { isDisabledNow, joinReasons } from "./helpers.js";

/** Refuses a planned step that must not fire ("stop": the episode ends), else "next". */
export async function refuseMisuseStep(ctx: HuntState, ep: EpisodeState, turn: Turn, s: MisuseStep): Promise<"stop" | "next"> {
  const { ran, episode } = turn;
  // An earlier step of this episode removed this step's control (a Cancel closed the dialog
  // the Save lived in): the rest of the episode was planned for a state that is gone. It ends
  // here, without spending an action — never a failed act that reads as a broken control.
  const gone = s.control;
  if (ep.refreshed && gone !== null && !ep.stepSnap.controls.some((c) => controlKey(c) === controlKey(gone))) {
    ctx.transcript.record({
      op: null,
      control: gone,
      confidence: null,
      chosenBy: "strategy",
      strategy: ran,
      actOk: false,
      reason: joinReasons([s.note, "no longer on the page after the previous step — episode ends"]),
      snapshot: ep.stepSnap,
      ...(ep.stepTiming === undefined ? {} : { timing: ep.stepTiming }),
    });
    ep.stepTiming = undefined;
    return "stop";
  }
  // A click on a control that is disabled RIGHT NOW is never attempted: it can never mutate
  // anything, so it is a no-op, not an action — counted against no budget, and the episode
  // moves on rather than spending its remaining steps (and the next loop turn's strategy pick)
  // on a target that cannot be clicked. Checked live (not from the planning snapshot), because
  // an earlier step in THIS episode may just have made it enabled (e.g. filling the last
  // required field) — the same live truth `act()`'s own gate re-checks right before clicking.
  if (s.op === "click" && s.control !== null && (await isDisabledNow(ctx.sessions.page, s.control))) {
    const id = controlIdentity(s.control);
    const again = ctx.disabledNow.has(id);
    ctx.disabledNow.add(id);
    if (again) {
      ep.stepTiming = undefined;
      return "stop";
    }
    // #155/#193: a submit that could not be attempted is recorded with WHY — never silently.
    if (s.submitsForm !== undefined) ctx.cov.blocked(ep.stepSnap.url, s.submitsForm, "the submit control is disabled", "disabled");
    ctx.transcript.record({
      op: null,
      control: s.control,
      confidence: null,
      chosenBy: "strategy",
      strategy: ran,
      actOk: false,
      reason: joinReasons([s.note, "target disabled — no-op, choosing another action"]),
      snapshot: ep.stepSnap,
      ...(ep.stepTiming === undefined ? {} : { timing: ep.stepTiming }),
    });
    ep.stepTiming = undefined;
    return "stop";
  }
  if (s.op === "click" && s.control !== null) ctx.disabledNow.delete(controlIdentity(s.control));
  // #300: a control that switched the signed-in identity is never acted on again (a strategy
  // that re-plans it from the live snapshot gets a no-op, counted against no budget).
  if (s.control !== null && ctx.identitySwitchers.has(controlIdentity(s.control))) {
    ctx.transcript.record({
      op: null,
      control: s.control,
      confidence: null,
      chosenBy: "strategy",
      strategy: ran,
      actOk: false,
      reason: joinReasons([s.note, "this control switched the signed-in identity earlier in the run — not acted on again"]),
      snapshot: ep.stepSnap,
      ...(ep.stepTiming === undefined ? {} : { timing: ep.stepTiming }),
    });
    ep.stepTiming = undefined;
    return "stop";
  }
  // The shared safety policy (#116): a paid / session-ending / destructive / --deny'd control is
  // never clicked — a no-op like a disabled target, counted against no budget.
  const unsafe = ctx.safety.gate(s.op, s.control);
  if (unsafe !== null) {
    if (s.control !== null) {
      ctx.refusedIds.add(controlIdentity(s.control));
      ctx.cov.refused(ep.stepSnap.url, s.control, unsafe.risk);
    }
    if (s.submitsForm !== undefined) ctx.cov.blocked(ep.stepSnap.url, s.submitsForm, unsafe.reason, "denied");
    ctx.transcript.record({
      op: null,
      control: s.control,
      confidence: null,
      chosenBy: "strategy",
      strategy: ran,
      actOk: false,
      reason: joinReasons([s.note, unsafe.reason]),
      snapshot: ep.stepSnap,
      ...(ep.stepTiming === undefined ? {} : { timing: ep.stepTiming }),
    });
    ep.stepTiming = undefined;
    return "stop";
  }
  // #150 — mission spend budget, pre-action: a paid control (#116) whose declared cost estimate
  // would cross what remains of the budget is refused BEFORE it fires — code decides, never a
  // model routing around it. The run stops cleanly, with `stop: "budget"`.
  if (ctx.budget !== null) {
    const risk = s.control === null ? null : ctx.safety.policy.riskOf(s.control);
    const g = await ctx.budget.guard(ctx.sessions.page, { op: s.op, control: s.control?.name ?? s.op, paid: risk === "paid" });
    if (g.refuse) {
      ctx.transcript.record({
        op: null,
        control: s.control,
        confidence: null,
        chosenBy: "strategy",
        strategy: ran,
        actOk: false,
        reason: joinReasons([s.note, g.reason]),
        snapshot: ep.stepSnap,
        ...(ep.stepTiming === undefined ? {} : { timing: ep.stepTiming }),
      });
      ep.stepTiming = undefined;
      ctx.stop = "budget";
      return "stop";
    }
  }
  return "next";
}
