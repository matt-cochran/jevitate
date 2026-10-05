/**
 * A settled misuse step (#86, #193, #300, #301, #303): its delta, an identity switch (restored),
 * the independent oracle's verdict, the canary check, what the step revealed, the post-settle budget
 * — and the page the episode goes on from. Moved out of `runEpisode` unchanged (#232). "stop" ends
 * the episode (its former `break`).
 */

import { redactUrl } from "@jevitate/ai-core";
import type { ActResult } from "../../act.js";
import { normalizeRoute } from "../../adversarial/defect-fingerprint.js";
import { detectForms, planMisuseEpisode, type MisuseStep } from "../../adversarial/form-misuse.js";
import { identityChange, readIdentity } from "../../adversarial/identity.js";
import { controlIdentity } from "../../coverage/fingerprint.js";
import { monitorFor } from "../../page-monitor.js";
import type { HuntState } from "./context.js";
import type { EpisodeState, Turn } from "./episode.js";
import { FORM_STRATEGY, joinReasons } from "./helpers.js";

/** What a fired step hands to its settling: where and when it acted, its result, and its transcript entry. */
export interface FiredStep {
  readonly actedOn: string;
  readonly firedAt: number;
  readonly result: ActResult;
  readonly reason: string | undefined;
  readonly entry: Parameters<HuntState["transcript"]["record"]>[0];
  readonly step: number;
}

/** Settles one fired step (everything after its act, for a step that waits to settle). */
export async function settleMisuseStep(ctx: HuntState, ep: EpisodeState, turn: Turn, s: MisuseStep, fired: FiredStep): Promise<"stop" | "next"> {
  const { ran, planning } = turn;
  const { actedOn, firedAt, result, reason, entry, step } = fired;
  // A settled step is judged on what it produced: wait (bounded) for the requests it sent to come
  // back first. Read mid-flight, a save the server rejects still shows the previous save's "Saved",
  // and a declared invariant reports a violation no replay reproduces. A page that never settles
  // is left to the hang check that follows the verdict.
  await monitorFor(ctx.sessions.page).waitSettled({ ceilingMs: 5_000 }).catch(() => undefined);
  // #303 (opt-in): what this settled action changed — on its transcript step, and kept as
  // evidence for a defect first seen at this step.
  if (ctx.deltaArmed !== null) {
    const dl = ctx.deltaArmed;
    ctx.deltaArmed = null;
    const d = await dl.perceived(normalizeRoute(redactUrl(ctx.sessions.page.url()))).catch(() => null);
    if (d !== null) {
      ctx.stepDeltas.set(step, d.delta);
      ctx.transcript.attachDelta(step, d.delta);
    }
  }
  // #300: did this action switch the signed-in identity? Then its invariants are not judged,
  // the control is never picked again, and the run goes back to the original identity.
  const since = ctx.chainStart ?? firedAt;
  ctx.chainStart = null;
  const switched =
    ctx.baseline === null
      ? null
      : identityChange(ctx.baseline, await readIdentity(ctx.sessions.page), { authRequest: ctx.authRequests.since(since) });
  if (switched !== null) {
    ctx.chainCanaries.clear();
    const switchVerdict = await ctx.adjudicate(null, { identitySwitched: true });
    const landed = redactUrl(ctx.sessions.page.url());
    const actionName = s.control?.name ?? s.op;
    ctx.transcript.record({
      ...entry,
      reason:
        joinReasons([
          reason,
          `identity changed (${switched}): invariants not judged; "${actionName}" is not picked again`,
          switchVerdict?.reason,
        ]) ?? "identity changed",
    });
    if (switchVerdict !== null) {
      await ctx.fold(step, switchVerdict.findings);
      ctx.foldAdvisories(step, switchVerdict.advisories);
    }
    if (s.control !== null) {
      ctx.refusedIds.add(controlIdentity(s.control));
      ctx.identitySwitchers.add(controlIdentity(s.control));
    }
    ctx.last = null;
    const back = await ctx.restoreIdentity();
    ctx.identityChanges.push({ step, action: actionName, url: landed, route: normalizeRoute(landed), reason: switched, restored: back.ok });
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "identity-reset",
      actOk: back.ok,
      reason: back.ok
        ? "restored the original identity: reset to the start URL in a fresh session from the original storage state"
        : back.why,
      snapshot: back.ok ? back.snapshot : ctx.snap,
      ...(back.ok ? { timing: back.timing } : {}),
    });
    if (!back.ok) {
      ctx.stop = back.stop;
      if (back.stop === "identity-changed") ctx.stopFailure = { kind: "identity-changed", message: back.why };
      return "stop";
    }
    ctx.snap = back.snapshot;
    ctx.snapTiming = undefined;
    return "stop";
  }
  // The submit an unsettled sequence left pending is judged too, when this step was not itself a
  // submit (that one is judged as this step): it is the action that said "Saved" or not.
  const earlierSubmit = s.submitsForm === undefined ? ep.earlierSubmit : null;
  ep.earlierSubmit = null;
  const verdict = await ctx.adjudicate({ op: s.op, control: s.control?.name ?? null, url: actedOn, step }, { earlierSubmit });
  const soft = verdict === null ? await ctx.softJudgment(ep.stepSnap) : {};
  const full = verdict === null ? joinReasons([reason, soft.note]) : joinReasons([reason, verdict.reason]);
  ctx.transcript.record({
    ...entry,
    ...(full === undefined ? {} : { reason: full }),
    ...(soft.judgments === undefined ? {} : { judgments: soft.judgments }),
  });
  if (verdict !== null) {
    await ctx.fold(step, verdict.findings);
    ctx.foldAdvisories(step, verdict.advisories);
  }
  // #301: was a submitted canary rendered as markup (after submit, after reload)?
  const canaryCheck = await ctx.checkCanaries();
  const after = await ctx.observeAfter(step, s.control?.name ?? s.op);
  if (after.kind === "stop") {
    ctx.stop = after.stop;
    return "stop";
  }
  // The rest of the episode was planned for a page that is gone.
  if (after.kind === "reset") return "stop";
  if (canaryCheck === "reloaded") {
    // The canary check loaded the page again: the rest of the episode's plan is stale.
    ctx.observeTarget(ctx.snap);
    return "stop";
  }
  ctx.observeTarget(ctx.snap);
  // #193: what did this click reveal? A form that was not there before → remember the control
  // as the way back to it (and, for a disclosure, run this strategy's episode on it now); a
  // disclosure that showed no form is never re-opened "to look for a form".
  if (result.ok && s.op === "click" && s.control !== null) {
    const id = controlIdentity(s.control);
    const before = new Set(detectForms(ep.stepSnap.controls, ctx.inScope).map((f) => f.key));
    const appeared = detectForms(ctx.snap.controls, ctx.inScope)
      .map((f) => f.key)
      .filter((k) => !before.has(k));
    if (appeared.length > 0) {
      ctx.revealed.set(id, appeared);
      ctx.barren.delete(id);
      if (s.discloses === true && ran !== "exercise-controls" && FORM_STRATEGY.has(ran)) {
        // Same round as the disclosure's own turn (its counter was already advanced).
        const follow = planMisuseEpisode(planning(ctx.snap, ran, { disclose: false, round: (ctx.rounds.get(ran) ?? 1) - 1 }));
        if (follow !== null) ep.queue.push(...follow.steps);
      }
    } else if (s.discloses === true && !ctx.revealed.has(id)) {
      ctx.barren.add(id);
    }
  }
  ep.refreshed = true;
  ep.pendingEarlier = false;
  // #150 — post-settle: a crossed budget stops the mission cleanly, before its next action.
  if (ctx.budget !== null) {
    const b = await ctx.budget.afterSettle(ctx.sessions.page, step);
    if (b.crossed) {
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "budget",
        actOk: true,
        reason: b.reason ?? "mission budget crossed",
        snapshot: ctx.snap,
      });
      ctx.stop = "budget";
      return "stop";
    }
  }
  ep.stepSnap = ctx.snap;
  ep.stepTiming = ctx.snapTiming;
  ctx.snapTiming = undefined;
  return "next";
}
