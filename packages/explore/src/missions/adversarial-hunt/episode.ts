/**
 * One misuse episode of the hunt (#86, #116, #150, #155, #161, #188, #193, #245, #300, #301, #303):
 * its planned steps run through the gated act(), each settled step adjudicated by the independent
 * oracle, until the episode ends or the run stops. Moved out of `runAdversarialHunt` unchanged (#232).
 */

import { redactUrl } from "@jevitate/ai-core";
import { normalizeRoute } from "../../adversarial/defect-fingerprint.js";
import {
  controlKey,
  planMisuseEpisode,
  type EpisodeContext,
  type MisuseStep,
} from "../../adversarial/form-misuse.js";
import { canaryPayloadOf, canaryTokenOf } from "../../adversarial/markup-canary.js";
import type { MisuseStrategy } from "../../adversarial/misuse.js";
import { controlIdentity } from "../../coverage/fingerprint.js";
import type { DemoOverlay } from "../../demo-overlay.js";
import { monitorFor } from "../../page-monitor.js";
import type { Snapshot } from "../../snapshot.js";
import type { PageTiming } from "../../timing.js";
import type { HuntState } from "./context.js";
import { settleMisuseStep } from "./settle-step.js";
import {
  isDisabledNow,
  isUnactionableFailure,
  joinReasons,
  nativeValidationMessage,
  submitRequestSent,
} from "./helpers.js";

/** What a turn planned: the strategy that runs, its planner, the episode, and the page it was planned on. */
export interface Turn {
  readonly ran: MisuseStrategy;
  readonly planning: (on: Snapshot, as: MisuseStrategy, extra?: Partial<EpisodeContext>) => EpisodeContext;
  readonly episode: NonNullable<ReturnType<typeof planMisuseEpisode>>;
  readonly stepSnap: Snapshot;
  readonly stepTiming: PageTiming | undefined;
}

/** An episode's own state (#232): the episode's local variables, one field each, names unchanged. */
export interface EpisodeState {
  stepSnap: Snapshot;
  stepTiming: PageTiming | undefined;
  queue: MisuseStep[];
  /** Whether `stepSnap` was re-perceived after an earlier step of this episode. */
  refreshed: boolean;
  /** Whether an earlier step of this episode acted without settling (the page may have moved on). */
  pendingEarlier: boolean;
}

/** Runs one planned episode (a queue: a disclosure that reveals a form is followed by its own episode, #193). */
export async function runEpisode(ctx: HuntState, overlay: DemoOverlay | null, turn: Turn): Promise<void> {
  const ep = {} as EpisodeState;
  const { ran, planning, episode } = turn;
  ep.stepSnap = turn.stepSnap;
  ep.stepTiming = turn.stepTiming;
  // A queue, not a fixed list: a disclosure that reveals a form is followed, in the same turn,
  // by this strategy's own episode on the revealed form (#193).
  ep.queue = [...episode.steps];
  /** Whether `stepSnap` was re-perceived after an earlier step of this episode. */
  ep.refreshed = false;
  /** Whether an earlier step of this episode acted without settling (the page may have moved on). */
  ep.pendingEarlier = false;
  while (ep.queue.length > 0) {
    const s = ep.queue.shift() as MisuseStep;
    if (ctx.actions + ctx.restartSpend >= ctx.bounds.maxActions) break;
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
      break;
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
        break;
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
      break;
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
      break;
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
      break;
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
        break;
      }
    }
    // #245: the demo overlay says what is about to happen and highlights the target (display only).
    // A step racing an unsettled earlier one (a double submit) gets the panel only — no highlight
    // pause, so the overlay never lets the earlier action settle and change what the misuse tests.
    if (overlay !== null) {
      await overlay.announce(
        ctx.sessions.page,
        { step: ctx.transcript.nextStep, strategy: `adversarial · ${ran}`, op: s.op, target: s.control === null ? null : s.control.name || s.control.summary, why: s.note },
        ep.pendingEarlier ? null : s.control,
      );
    }
    // Declared invariants (#86): snapshot BEFORE the action(s) the next adjudication judges.
    const actedOn = ctx.sessions.page.url();
    if (ctx.declared !== null && !ctx.armed) {
      await ctx.declared.before(ctx.sessions.actor);
      ctx.armed = true;
    }
    // #303 (opt-in): the page right before a settled action (a racing, unsettled one gets none).
    ctx.deltaArmed = null;
    if (ctx.pageDeltas !== null && s.settle && !ep.pendingEarlier) {
      const dl = await ctx.pageDeltas.on(ctx.sessions.page);
      const route = normalizeRoute(redactUrl(ctx.sessions.page.url()));
      await dl.perceived(route).catch(() => null);
      try {
        await dl.beforeAction(route, s.op, s.control);
        ctx.deltaArmed = dl;
      } catch {
        dl.discard();
      }
    }
    const at = ctx.now();
    const firedAt = Date.now();
    if (ctx.chainStart === null) ctx.chainStart = firedAt;
    const firedStep = ctx.transcript.nextStep;
    ctx.safety.mark(ctx.transcript.nextStep, s.op, s.control);
    const { result, value } = await ctx.execute(s, ep.stepSnap.controls);
    ctx.actions += 1;
    if (ctx.deltaArmed !== null) {
      if (result.ok) ctx.deltaArmed.acted({ label: `${s.op} ${s.control?.name ?? ""}`.trim(), recordIndex: 0, step: ctx.transcript.nextStep, ...(value === undefined ? {} : { value }) });
      else {
        ctx.deltaArmed.discard();
        ctx.deltaArmed = null;
      }
    }
    // #301: an inert canary typed into a field is registered (token → field, page, payload).
    const token = result.ok ? canaryTokenOf(value) : null;
    if (token !== null && value !== undefined && s.control !== null) {
      ctx.submittedCanaries.set(token, { field: s.control.name || s.control.summary, submittedOn: redactUrl(actedOn), payload: canaryPayloadOf(value) });
      ctx.chainCanaries.add(token);
    }
    if (result.ok) {
      ctx.recordAction(s, value, at, result.submittedVia);
      ctx.markFired(firedAt, firedStep);
    }
    if (result.ok) ctx.cov.acted(ep.stepSnap.url, s.control);
    // #155 — a submit click counts as submitted only when it actually sent a request (a write
    // or a navigation); one the browser blocked with native validation never reached the
    // server, so it is recorded `blocked` instead (with the browser's own message, when known).
    if (result.ok && s.submitsForm !== undefined) {
      if (submitRequestSent(monitorFor(ctx.sessions.page), at)) {
        ctx.cov.submitted(ep.stepSnap.url, s.submitsForm);
      } else {
        ctx.cov.blocked(ep.stepSnap.url, s.submitsForm, await nativeValidationMessage(ctx.sessions.page));
      }
    }
    if (ran === "visit-route" && s.control !== null) ctx.visitedLinks.add(s.control.name);
    // #161 (a regression of #75): a control refused as not-actionable (occluded, detached, a
    // clipped/offscreen anchor the static `isExercisable` check missed) is never re-chosen by
    // any strategy for the rest of the run — and never blindly repeated by `repeat-rapid`.
    // Only when the step acted on the state it was planned on (#193): a control an earlier,
    // unsettled step of THIS episode just removed (a second Save after the first one closed
    // its dialog) is not unactionable — it is simply gone, and the form stays plannable.
    if (!result.ok && s.control !== null && !ep.pendingEarlier && isUnactionableFailure(result.reason)) {
      ctx.unactionable.add(controlIdentity(s.control));
    }
    ctx.last =
      !result.ok && s.control !== null && ctx.unactionable.has(controlIdentity(s.control))
        ? null
        : { op: s.op, control: s.control, ...(value === undefined ? {} : { fillText: value }) };
    // Evidence for "act while the submit is pending": how many requests the action left in flight.
    const inFlight = !s.settle && result.ok ? monitorFor(ctx.sessions.page).pending().length : 0;
    const reason = joinReasons([
      s.note,
      result.ok ? result.note : result.reason,
      inFlight > 0 ? `${inFlight} request(s) in flight` : undefined,
    ]);
    const entry = {
      op: s.op,
      control: s.control,
      confidence: null,
      chosenBy: "strategy" as const,
      strategy: ran,
      actOk: result.ok,
      snapshot: ep.stepSnap,
      ...(ep.stepTiming === undefined ? {} : { timing: ep.stepTiming }),
      ...(s.redacted === true ? { redacted: true } : {}),
    };
    ep.stepTiming = undefined;
    const step = ctx.transcript.nextStep;
    if (!s.settle) {
      // The next step fires at once, without waiting for this one to settle (that is the misuse).
      ctx.transcript.record({ ...entry, ...(reason === undefined ? {} : { reason }) });
      ep.pendingEarlier = ep.pendingEarlier || result.ok;
      continue;
    }
    const settled = await settleMisuseStep(ctx, ep, turn, s, { actedOn, firedAt, result, reason, entry, step });
    if (settled === "stop") break;
  }
}
