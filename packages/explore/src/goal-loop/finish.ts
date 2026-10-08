/**
 * The end of a goal-loop run (#203, #207, #230, #238): the stop reclassified by what is known at the
 * end (an unresponsive app, a starved host, an uncovered absence answer), the Recording finished, the
 * outcome stated, and the ExploreRun assembled. Moved out of `explore.ts` unchanged (#232).
 */

import { answerNotFoundReason } from "../answer.js";
import type { RunOutcome } from "../conversation.js";
import { buildCrashReport } from "../crash-report.js";
import type { ExploreRun } from "../explore.js";
import { targetStoppedAnswering } from "../mission-failure.js";
import { emptyRecording } from "../record.js";
import { redactText, redactUrl } from "../redact.js";
import { summarizeTimings } from "../timing.js";
import type { RunContext } from "./context.js";
import { incompleteReason, quote, safeUrl, withCause } from "./helpers.js";

export async function finishRun(ctx: RunContext): Promise<ExploreRun> {
  const { cfg } = ctx;
  // #230: a no-progress stop on an app that stopped answering is `target-unresponsive` — before the
  // host is blamed for it (#203).
  if (ctx.stop === "no-progress") {
    const unresponsive = await targetStoppedAnswering(ctx.livenessOf()).catch(() => null);
    if (unresponsive !== null) {
      ctx.failure = { kind: "target-unresponsive", message: unresponsive };
      ctx.stop = "inconclusive";
    }
  }

  // #203: a no-progress stop met while the host was starved is the host, not the app.
  if (ctx.stop === "no-progress" && cfg.hostHealth !== undefined) {
    const judged = await cfg.hostHealth.judge();
    if (judged.starved !== null) ctx.degradedStop("no-progress", "the last actions left the page unchanged", judged.starved);
  }

  // #238 — the latest report's answer was "none exists", but the run never covered enough of the app
  // to establish it: it proved nothing either way — `inconclusive` (insufficient coverage), never a defect.
  if (ctx.lastAbsenceUncovered !== null && ctx.answer === undefined && (ctx.stop === "no-progress" || ctx.stop === "blocked" || ctx.stop === "exhausted") && ctx.failure === undefined) {
    ctx.failure = { kind: "insufficient-coverage", message: ctx.lastAbsenceUncovered };
    ctx.incomplete = ctx.lastAbsenceUncovered;
    ctx.stop = "inconclusive";
    ctx.lastReportNotFound = false;
  }

  // #207 — a run whose latest report found no answer, and that then stopped for want of progress or
  // gave up, ends saying so and what it searched — not a generic "no progress" / "blocked".
  if (ctx.lastReportNotFound && ctx.answer === undefined && (ctx.stop === "no-progress" || ctx.stop === "blocked") && ctx.failure === undefined) {
    ctx.incomplete = answerNotFoundReason(ctx.observed.pages());
  }

  // #368 — the run ended still waiting on the reply to its last message: that missing reply is the
  // run's own finding (named with the wait it was given), never folded into a generic stop reason.
  if (ctx.awaitingReply && ctx.answer === undefined && ctx.failure === undefined && (ctx.stop === "no-progress" || ctx.stop === "blocked" || ctx.stop === "exhausted")) {
    const sent = ctx.lastTurn?.sent;
    const missing = `no reply within ${Math.round(ctx.replyWaitedMs / 1000)}s to the last message sent${sent === undefined || sent === "" ? "" : ` (${quote(sent, 80)})`}`;
    ctx.incomplete = `${missing}; ${incompleteReason(ctx.stop, ctx.incomplete, ctx.failure, ctx.hang, ctx.tracker)}`;
  }

  await ctx.readOnly?.disarm();
  ctx.page.off("request", ctx.onRequestSeen);
  ctx.page.off("response", ctx.onDocumentResponse);
  const finished = ctx.recorder.tryFinish({ intent: cfg.goal });
  const cause = ctx.blockingCause();
  // #371: a stop whose own reason already quotes the latest failed action's reason (a stuck type
  // probe, a failed-actions streak) does not repeat it as its "last blocker".
  const latest = ctx.blockers.latest;
  const reasonCause =
    cause !== null && latest !== null && cause === latest.text && ctx.incomplete !== null && ctx.incomplete.includes(latest.reason) ? null : cause;
  const finalOutcome: RunOutcome =
    ctx.stop === "done" && ctx.outcome !== null && finished.ok
      ? ctx.outcome
      : { status: "incomplete", reason: withCause(incompleteReason(ctx.stop, ctx.incomplete, ctx.failure, ctx.hang, ctx.tracker), ctx.stop, reasonCause) };
  if (!finished.ok) {
    // The Recording itself failed its fail-closed checks (schema / a surviving secret). It is not
    // written; the run is reported crashed so this can never read as a pass.
    ctx.failure = ctx.failure ?? { kind: "exception", message: `recording rejected: ${finished.reason}` };
    ctx.stop = "crashed";
  }
  const fired = ctx.effectLog.entries();
  ctx.effectLog.close();
  if (ctx.overlay !== null) {
    const banner = finalOutcome.status === "completed" ? `jevitate · done — ${ctx.stop}` : `jevitate · ${ctx.stop} — ${finalOutcome.reason}`;
    await ctx.overlay.finish(banner, finalOutcome.status === "completed", ctx.page);
  }
  return {
    sideEffects: fired.sideEffects,
    ...(fired.truncated > 0 ? { sideEffectsTruncated: fired.truncated } : {}),
    ...(ctx.safety.overrides().length === 0 ? {} : { safetyOverrides: ctx.safety.overrides() }),
    ...(ctx.deltas === null ? {} : { actionDeltas: { ...ctx.deltas.stats(), ...(ctx.notPersisted.length === 0 ? {} : { notPersisted: ctx.notPersisted }) } }),
    stop: ctx.stop,
    recording: finished.ok ? finished.recording : emptyRecording(cfg.site ?? ctx.startOrigin, finished.reason),
    transcript: ctx.transcript.entries(),
    finalUrl: redactText(redactUrl(safeUrl(ctx.page)), ctx.secrets),
    decisions: ctx.tracker.decisions,
    actions: ctx.tracker.actions,
    ...(ctx.failure === undefined ? {} : { failure: ctx.failure }),
    heap: ctx.heap.samples(),
    timing: summarizeTimings(ctx.timings),
    ...(ctx.hang === undefined ? {} : { hang: ctx.hang }),
    outcome: finalOutcome,
    ...(ctx.answer !== undefined && finalOutcome.status === "completed" ? { answer: ctx.answer } : {}),
    ...(cause === null ? {} : { blockingCause: cause }),
    ...(ctx.endedOnRejectedDone && ctx.stop === "done" ? { doneRejected: true as const } : {}),
    ...(ctx.stop === "crashed" && ctx.failure !== undefined
      ? { crash: buildCrashReport(ctx.failure, ctx.crashWatch.signals(), ctx.heap.samples(), { host: await ctx.probeHost() }) }
      : {}),
  };
}
