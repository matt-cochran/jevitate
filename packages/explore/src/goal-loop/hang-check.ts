/**
 * The goal loop's hang check (#153, #203, #230, #258, #288, owner ruling 7): a page that is visibly
 * still working is waited out within the job-wait budget; a hang that stands ends the run (or, on a
 * starved host, ends it inconclusive). Moved out of `explore.ts` unchanged (#232).
 */

import { sampleHeap } from "../crash-report.js";
import { type HangSignal } from "../hang.js";
import { assertTargetAnswering } from "../mission-failure.js";
import { readDocumentedWait, readWorkingStatus } from "../status.js";
import type { RunContext } from "./context.js";
import { JOB_WAIT_SLICE_MS, documentedWaitBudgetMs, liveBusyWork, stillShowsWork, waitOutJob } from "./helpers.js";
import type { Flow, Perceived } from "./step.js";

export async function checkHang(ctx: RunContext, step: Perceived): Promise<Flow> {
  const { perceiveStartedAt, perception, snap } = step;
  // Long-running legitimate work is not a hang (#153): a page that shows an in-progress status
  // AND acknowledges it (a Cancel control, the pressed control disabled as "Analyzing...", a
  // determinate progress bar) is WORKING. Code waits it out, bounded by the job-wait budget;
  // past the budget the hang stands. A main thread that does not answer is never "working".
  // #258: a wait the page DOCUMENTS ("this usually takes less than a minute") is working too, and
  // its stated duration can raise the budget (twice the stated time plus a grace, capped). #288: so
  // is a busy indicator that outlasted the ceiling while the app visibly kept working (an
  // in-progress status, with its requests completing or its progress text changing meanwhile).
  const documented =
    perception.hang !== null && perception.hang.kind !== "main-thread-unresponsive" ? await readDocumentedWait(ctx.page) : null;
  if (documented !== null) ctx.documentedBudgetMs = Math.max(ctx.documentedBudgetMs, documentedWaitBudgetMs(documented.ms));
  const workBudgetMs = Math.max(ctx.jobWaitMs, ctx.documentedBudgetMs);
  if (perception.hang !== null && perception.hang.kind !== "main-thread-unresponsive" && ctx.hangWorkWaitedMs < workBudgetMs) {
    const working =
      (await readWorkingStatus(ctx.page)) ??
      (documented === null ? null : `a documented wait ("${documented.text}")`) ??
      (perception.hang.kind === "ui-no-progress" ? await liveBusyWork(ctx.page, perception.busyWait) : null);
    if (working !== null) {
      const w = await waitOutJob(ctx.page, Math.min(workBudgetMs - ctx.hangWorkWaitedMs, JOB_WAIT_SLICE_MS), stillShowsWork);
      // The perception's own wait counts too (its whole time, the busy-indicator wait included): the
      // budget bounds the whole time spent believing it.
      ctx.hangWorkWaitedMs += Date.now() - perceiveStartedAt;
      const note = `not a hang yet (${perception.hang.kind}): the page shows ${working} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
        w.cleared ? "the status cleared" : `still in progress; ${Math.round(ctx.hangWorkWaitedMs / 1000)}s of the ${Math.round(workBudgetMs / 1000)}s job-wait budget used`
      })`;
      ctx.history.push(note);
      ctx.transcript.record({
        op: "wait",
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "hang-check",
        actOk: true,
        reason: note,
        snapshot: snap,
        timing: perception.timing,
      });
      return "continue";
    }
  }

  // A hang is its own first-class stop (owner ruling 7) — detected by perception's rule.
  if (perception.hang !== null) {
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "hang-check",
      actOk: false,
      reason: `hang (${perception.hang.kind}): ${perception.hang.detail}`,
      snapshot: snap,
      timing: perception.timing,
    });
    await assertTargetAnswering(ctx.livenessOf());
    const judged = await ctx.judgeHost();
    if (judged.starved !== null) {
      ctx.degradedStop(perception.hang.kind === "ui-no-progress" ? "no-progress" : "hang", `${perception.hang.kind}: ${perception.hang.detail}`, judged.starved);
      return "stop";
    }
    const heapNow = await sampleHeap(ctx.page, 1_000);
    // #288: a hang that stands after the page was believed to be working says how long, and how to
    // allow a longer job — the operator's knob, never a silent longer wait.
    const stood: HangSignal =
      ctx.hangWorkWaitedMs > 0
        ? {
            ...perception.hang,
            detail: `${perception.hang.detail} (still so after ${Math.round(ctx.hangWorkWaitedMs / 1000)}s of the page showing work — past the ${Math.round(workBudgetMs / 1000)}s job-wait budget; raise --job-wait-ms for longer jobs)`,
          }
        : perception.hang;
    const withHost: HangSignal = { ...stood, host: judged.host };
    ctx.hang = {
      signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
      recordingStepIndex: Math.max(0, ctx.recorder.stepCount - 1),
    };
    ctx.stop = "hang";
    return "stop";
  }
  return "next";
}
