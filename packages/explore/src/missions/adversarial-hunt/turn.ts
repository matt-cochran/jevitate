/**
 * One turn of the hunt (#193, #209): the next strategy plans its episode on the current page — with
 * the `exercise-controls` fallback — or, when nothing applies, the turn is still adjudicated by the
 * independent oracle (an idle turn). Moved out of `runAdversarialHunt` unchanged (#232).
 */

import {
  isExercisable,
  planMisuseEpisode,
  type EpisodeContext,
  type MisuseStep,
} from "../../adversarial/form-misuse.js";
import type { MisuseStrategy } from "../../adversarial/misuse.js";
import type { Snapshot } from "../../snapshot.js";
import type { AdversarialMissionParams } from "../adversarial.js";
import type { HuntState } from "./context.js";
import type { Turn } from "./episode.js";
import { joinReasons } from "./helpers.js";

/** Plans the next turn: its episode, or "continue" (an idle turn, recorded) / "stop" (every target refused). */
export async function planTurn(ctx: HuntState, params: AdversarialMissionParams): Promise<"stop" | "continue" | Turn> {
  const strategy = params.strategies[ctx.strategySteps % params.strategies.length];
  if (strategy === undefined) throw new Error("adversarial: strategy index out of range");
  ctx.strategySteps += 1;
  const round = ctx.rounds.get(strategy) ?? 0;
  // A snapshot armed by an episode that ended without an adjudication (budget, disabled target)
  // is stale: the next action gets a fresh one, so no effect is attributed to the wrong action.
  ctx.armed = false;
  ctx.chainStart = null;
  // #403: an episode that ended before its last step settled leaves the misuse window open: closed here.
  ctx.offAllowlist.settled();
  ctx.blockedWrites.push(...ctx.offAllowlist.drain());

  // A perception's timing is reported once — on the first step decided on it.
  let stepSnap = ctx.snap;
  let stepTiming = ctx.snapTiming;
  ctx.snapTiming = undefined;
  ctx.observeTarget(ctx.snap);
  // #209: when EVERY target control on the page is one the safety policy refuses (three "Buy"
  // buttons, refused as paid), no strategy can exercise anything — stop now, naming the refusal,
  // instead of scrolling and re-planning until the budget runs out.
  if (ctx.inScope(ctx.snap.url)) for (const c of ctx.snap.controls) if (isExercisable(c, ctx.inScope)) ctx.refuses(c);
  if (ctx.cov.everyTargetRefused()) {
    ctx.stop = "targets-refused";
    return "stop";
  }
  const planning = (on: Snapshot, as: MisuseStrategy, extra: Partial<EpisodeContext> = {}): EpisodeContext => ({
    snapshot: on,
    strategy: as,
    round: ctx.rounds.get(as) ?? 0,
    last: ctx.last,
    visitedLinks: ctx.visitedLinks,
    exercised: ctx.cov.exercisedKeys,
    blacklisted: ctx.refusedIds.size === 0 ? ctx.unactionable : new Set([...ctx.unactionable, ...ctx.refusedIds]),
    inScope: ctx.inScope,
    refuses: ctx.refuses,
    isChrome: ctx.isChrome,
    disclosures: { revealed: ctx.revealed, barren: ctx.barren },
    rng: Math.random,
    canary: () => ctx.canaries.next(),
    ...extra,
  });
  let episode = planMisuseEpisode(planning(ctx.snap, strategy));
  /** The strategy the episode actually runs (a fallback to `exercise-controls`, #193). */
  let ran: MisuseStrategy = strategy;

  ctx.cov.strategy(strategy, episode !== null);
  // #193: a strategy with nothing to do here never idles while target controls are still
  // unexercised — when the run hunts with `exercise-controls`, the turn exercises one instead.
  if (episode === null && ctx.exercises && strategy !== "exercise-controls") {
    const fallback = planMisuseEpisode(planning(ctx.snap, "exercise-controls"));
    if (fallback !== null) {
      ran = "exercise-controls";
      ctx.cov.strategy(ran, true);
      const note = (st: MisuseStep): string => joinReasons([`no ${strategy} action applies`, st.note]) ?? st.note;
      episode = { steps: fallback.steps.map((st, i) => (i === 0 ? { ...st, note: note(st) } : st)) };
    }
  }
  if (episode === null) {
    ctx.idleStreak += 1;
    // Independent oracle — runs EVERY step, even when a strategy chose no action: the user
    // invariant is an independent probe of live page state, and hard signals may have accrued.
    const step = ctx.transcript.nextStep;
    const verdict = await ctx.adjudicate();
    const soft = verdict === null ? await ctx.softJudgment(stepSnap) : {};
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy,
      actOk: false,
      reason: verdict?.reason ?? joinReasons(["strategy found no applicable action", soft.note]),
      snapshot: stepSnap,
      ...(stepTiming === undefined ? {} : { timing: stepTiming }),
      ...(soft.judgments === undefined ? {} : { judgments: soft.judgments }),
    });
    if (verdict !== null) {
      await ctx.fold(step, verdict.findings);
      ctx.foldAdvisories(step, verdict.advisories);
    }
    // A whole cycle of strategies found nothing to do on this page: there is nothing left.
    if (ctx.idleStreak >= params.strategies.length) ctx.stop = "strategies-exhausted";
    return "continue";
  }
  ctx.idleStreak = 0;
  ctx.rounds.set(ran, (ran === strategy ? round : (ctx.rounds.get(ran) ?? 0)) + 1);
  return { ran, planning, episode, stepSnap, stepTiming };
}
