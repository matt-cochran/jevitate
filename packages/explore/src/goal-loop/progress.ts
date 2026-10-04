/**
 * The goal loop's progress check (#2, #79, #153, #172, #276, #289, #303): the page's status text, then
 * no-progress — a stuck app (an action that silently undid itself) is a `ui-no-progress` hang, a stuck
 * run gets one last-chance turn before it stops. Moved out of `explore.ts` unchanged (#232).
 */

import { sampleHeap } from "../crash-report.js";
import { hangRoute, probeResponsive, type HangSignal } from "../hang.js";
import { assertTargetAnswering } from "../mission-failure.js";
import { HANG_PROBE_MS, perceive } from "../perceive.js";
import { redactUrl } from "../redact.js";
import { describeStatus, isEmptyStatus, readPageStatus, statusDelta } from "../status.js";
import type { RunContext } from "./context.js";
import { EXPECTED_RETURN, savedAndLeft } from "./helpers.js";
import { LAST_CHANCE_NOTE, MAX_MOVING_SCROLLS } from "./limits.js";
import type { Flow, Perceived } from "./step.js";
import { clock } from "@jevitate/domain";

export async function checkProgress(ctx: RunContext, step: Perceived): Promise<Flow> {
  const { cfg } = ctx;
  const { snap } = step;
  // Status text (#79): alerts / invalid fields are not controls, so the model would never see
  // them. What newly appeared after the last step goes into its history; what shows now goes
  // into its prompt.
  {
    const before = ctx.status;
    ctx.status = await readPageStatus(ctx.page);
    const appeared = statusDelta(before, ctx.status);
    if (ctx.transcript.nextStep > 0 && !isEmptyStatus(appeared)) {
      ctx.history.push(`after ${ctx.statusAfter ?? "the last step"}: ${describeStatus(appeared)}`);
    }
    ctx.statusAfter = null;
  }

  // #172 — a scroll that MOVED the page is progress (the model is reading a long page), even
  // though the control set — the signature — is the same; bounded, so a scroll loop still stops.
  // #323 — the bound counts every moving scroll of the streak that landed on a state the streak has
  // already seen (the same signature, or one it scrolled past before): scrolling up and down beside
  // the target (A→B→A→B…) used to change the signature every time and reset the bound forever. A
  // scroll that reveals a NEW state is still progress and does not add to it; any other action
  // ends the streak.
  const scrolledMoved = (ctx.lastActedOp === "scroll_down" || ctx.lastActedOp === "scroll_up") && ctx.lastScrollMoved;
  if (!scrolledMoved) {
    ctx.movingScrolls = 0;
    ctx.scrollStreakSignatures.clear();
  } else {
    if (ctx.scrollStreakSignatures.size === 0 && ctx.movingScrollsSignature !== null) ctx.scrollStreakSignatures.add(ctx.movingScrollsSignature);
    if (ctx.scrollStreakSignatures.has(snap.signature)) ctx.movingScrolls += 1;
    else ctx.scrollStreakSignatures.add(snap.signature);
  }
  ctx.movingScrollsSignature = snap.signature;
  const scrollProgress = scrolledMoved && ctx.movingScrolls <= MAX_MOVING_SCROLLS;
  if (scrollProgress) ctx.noProgress.progress(snap.signature);
  ctx.lastChanceTurn = false;
  // #2 — no-progress: the last executed op left the page unchanged N times.
  // #303: the last action's delta decides when there is one — only `no-change` counts toward the
  // streak, `inconclusive` holds it; without one the page signature decides, as before.
  const verdictNow = ctx.deltaVerdict;
  ctx.deltaVerdict = null;
  // #323: past the bound, a moving scroll is no progress even when the signature changed (a
  // virtualized list renders other rows at each position) — it only revisits what it has seen.
  const scrollStalled = scrolledMoved && !scrollProgress;
  if (
    ctx.lastActedOp !== null &&
    !scrollProgress &&
    (scrollStalled ? ctx.noProgress.stalled(snap.signature) : ctx.noProgress.noteDelta(ctx.lastActedOp, snap.signature, verdictNow))
  ) {
    // Is the APP stuck (not the explorer)? The page is alive, the last page-changing action
    // sent it BACK to a state it had already been in (it changed, then reverted — an action
    // that silently undid itself, like an import that never starts), and it stays there for
    // the stall window: a `ui-no-progress` hang, not generic no-progress. An action that simply
    // did nothing (same state before and after) stays plain no-progress.
    // The action's target state must NEVER have appeared (no new state since the action), and
    // the target must not have declared this route/action as expected to return (per-target ignore).
    const m = ctx.track.lastMutation;
    if (
      m !== null &&
      // #276: the steps since were refusals / moved scrolls — the app answered: plain no-progress.
      ctx.refusedSinceMutation === 0 &&
      ctx.scrollsSinceMutation === 0 &&
      !m.sawNewState &&
      snap.signature !== m.before &&
      m.seenBefore.has(snap.signature) &&
      // A link that navigated to ANOTHER route already visited is ordinary navigation, not an
      // in-place action that silently undid itself (#153): the stall rule is for in-place actions.
      !((m.linkFromRoute ?? null) !== null && m.linkFromRoute !== hangRoute(snap.url)) &&
      // #289: a click whose write went through and that then took the page to another route
      // (Save → back to the hub) did what it was for — a save-and-return, not an action that undid itself.
      !savedAndLeft(m, hangRoute(snap.url), ctx.sideEffects.lastClick()) &&
      !EXPECTED_RETURN.test(m.label) &&
      !ctx.ignoreNoProgress(m.label) &&
      !ctx.ignoreNoProgress(hangRoute(snap.url))
    ) {
      const waited = ctx.now() - m.at;
      if (waited < ctx.stallMs) await clock.sleep(ctx.stallMs - waited);
      const again = await perceive(ctx.page, ctx.perceiveOpts);
      ctx.timings.push(again.timing);
      const stuck =
        again.hang ??
        (again.snapshot.signature === snap.signature && (await probeResponsive(ctx.page, cfg.hangProbeMs ?? HANG_PROBE_MS))
          ? ({
              kind: "ui-no-progress",
              detail: `after "${m.label}" the page returned to an earlier state and made no progress for ${Math.round((ctx.now() - m.at) / 1000)}s`,
              route: hangRoute(snap.url),
              url: redactUrl(snap.url),
              pending: [],
              lastState: { signature: snap.signature, controls: snap.controls.map((c) => c.summary) },
            } satisfies HangSignal)
          : null);
      if (stuck !== null) {
        ctx.transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "hang-check",
          actOk: false,
          reason: `hang (${stuck.kind}): ${stuck.detail}`,
          snapshot: again.snapshot,
          timing: again.timing,
        });
        await assertTargetAnswering(ctx.livenessOf());
        const judged = await ctx.judgeHost();
        if (judged.starved !== null) {
          ctx.degradedStop(stuck.kind === "ui-no-progress" ? "no-progress" : "hang", `${stuck.kind}: ${stuck.detail}`, judged.starved);
          return "stop";
        }
        const heapNow = await sampleHeap(ctx.page, 1_000);
        const withHost: HangSignal = { ...stuck, host: judged.host };
        ctx.hang = {
          signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
          recordingStepIndex: stuck.kind === "ui-no-progress" ? m.recordIndex : Math.max(0, ctx.recorder.stepCount - 1),
        };
        ctx.stop = "hang";
        return "stop";
      }
    }
    if (!ctx.lastChanceGiven) {
      // #172 — one last-chance turn before the stop: the model has seen the page; it acts,
      // reports, or says done/blocked. For a find-out goal an idle choice becomes a report.
      ctx.lastChanceGiven = true;
      ctx.lastChanceTurn = true;
      ctx.history.push(LAST_CHANCE_NOTE);
    } else {
      ctx.stop = "no-progress";
      return "stop";
    }
  }
  // Progress was made: a later stuck episode gets its own last chance.
  if (ctx.noProgress.streak === 0) ctx.lastChanceGiven = false;
  ctx.seen.add(snap.signature);
  return "next";
}
