/**
 * `wait` / `scroll_up` / `scroll_down` (#79, #92, #109, #172, #241, #283): the idle steps — no recorded
 * mutation, but visible to the history, and an idle streak is a stuck signal. The goal loop's
 * wait/scroll handler, moved out of `explore.ts` unchanged (#232).
 */
import { act } from "../act.js";
import { stillBusy, waitForChange, waitForReply } from "../conversation.js";
import { monitorFor } from "../page-monitor.js";
import { awaitWrites } from "../side-effects.js";
import { readInProgressStatus } from "../status.js";
import type { RunContext } from "./context.js";
import { JOB_WAIT_SLICE_MS, quote, waitOutJob } from "./helpers.js";
import { MAX_IDLE_STEPS, MAX_QUIET_WAITS } from "./limits.js";
import type { Flow, Step } from "./step.js";

export async function handleWaitOrScroll(ctx: RunContext, step: Step): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record } = step;
    // No recorded mutation — but visible to history (J-4), and an idle streak is a stuck signal.
    let changed: boolean;
    let note: string;
    if (decision.op === "wait" && ctx.awaitingReply && ctx.lastTurn !== null && ctx.busyWaitedMs < ctx.replyWaitMs) {
      // Still listening for the last message's reply (a slow LLM turn): this wait keeps
      // listening, bounded by what is left of the reply wait, and records the reply if it lands.
      const t0 = ctx.now();
      const listen = Math.min(ctx.replyWaitMs - ctx.busyWaitedMs, 20_000);
      const reply = await waitForReply(ctx.page, { secrets: ctx.secrets, ...ctx.lastTurn, timeoutMs: listen, ceilingMs: listen, quietMs: ctx.replyQuietMs });
      ctx.busyWaitedMs += ctx.now() - t0;
      if (reply.received) {
        ctx.conversation.latestReply = reply.text;
        ctx.replies.add(snap.url, reply.text);
        ctx.awaitingReply = false;
        ctx.busyWaitedMs = 0;
      }
      // #241: no reply and nothing of the send's in flight (no request, no busy sign) — this wait
      // was quiet, not patience: repeated, it ends the run instead of listening on.
      const idle = !reply.received && reply.endedBy === "idle";
      note = reply.received
        ? `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s → reply: ${quote(reply.text, 300)}`
        : idle
          ? `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s (no reply, and the page shows no sign of working on one)`
          : `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s (the reply is still on its way)`;
      changed = !idle;
      ctx.quietWaits = idle ? ctx.quietWaits + 1 : 0;
      record(true, note, reply.received ? { reply } : {});
    } else if (decision.op === "wait" && ctx.jobWaitedMs < ctx.jobWaitMs && (await readInProgressStatus(ctx.page)) !== null) {
      // The page shows an in-progress status (#92: "Simulating…", aria-busy, a job "is running")
      // — pending work even with no request in flight (the app polls). Wait it out with backoff,
      // bounded by the job-wait budget: patience, never "nothing is pending".
      const job = (await readInProgressStatus(ctx.page)) ?? "an in-progress status";
      const w = await waitOutJob(ctx.page, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
      ctx.jobWaitedMs = w.cleared ? 0 : ctx.jobWaitedMs + w.waitedMs;
      note = `waited ${(w.waitedMs / 1000).toFixed(1)}s (${
        w.cleared
          ? `the in-progress status ${job} cleared`
          : `the page still shows ${job} — the app is still working; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
      })`;
      changed = true;
      ctx.quietWaits = 0;
      record(true, note);
    } else if (decision.op === "wait" && ctx.jobWaitedMs >= ctx.jobWaitMs && ctx.sideEffects.inflight().length === 0 && (await readInProgressStatus(ctx.page)) !== null) {
      // #328: the job-wait budget is spent and the page STILL shows the same kind of in-progress
      // status, with nothing of the run's in flight: a status that never completes (an app defect),
      // not work to wait on. Another `wait` would only burn the decision budget — the run stops here,
      // naming the status (raise --job-wait-ms for a job that legitimately takes longer).
      const job = (await readInProgressStatus(ctx.page)) ?? "an in-progress status";
      const reason = `stuck: the page still shows ${job} after ${Math.round(ctx.jobWaitedMs / 1000)}s of waiting — past the ${Math.round(
        ctx.jobWaitMs / 1000,
      )}s job-wait budget, with no request of the run in flight (a status that never completes); raise --job-wait-ms if this job legitimately takes longer`;
      record(false, reason, { origin: "engine" });
      ctx.history.push(reason);
      ctx.lastActedOp = decision.op;
      ctx.incomplete = reason;
      ctx.stop = "no-progress";
      return "stop";
    } else if (decision.op === "wait" && ctx.jobWaitedMs < ctx.jobWaitMs && ctx.sideEffects.inflight().length > 0) {
      // #283: a write an earlier click fired is still in flight (a unary RPC the server holds open
      // while its job runs, past the long-poll threshold): pending work, wherever the page shows
      // it. Observe it until it resolves, bounded by the job-wait budget — never "nothing is pending".
      const what = ctx.inflightWrites();
      const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
      ctx.jobWaitedMs = w.resolved ? 0 : ctx.jobWaitedMs + w.waitedMs;
      note = `waited ${(w.waitedMs / 1000).toFixed(1)}s (${
        w.resolved
          ? `${what} (sent by an earlier click) resolved`
          : `${what} (sent by an earlier click) is still in flight — the app is still working; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
      })`;
      changed = true;
      ctx.quietWaits = 0;
      record(true, note);
    } else if (decision.op === "wait") {
      const t0 = ctx.now();
      changed = await waitForChange(ctx.page, ctx.waitOpMs);
      // No change while the app is still busy (a request in flight, a spinner) is patience —
      // a slow reply — not idleness: it does not count toward the idle cap.
      // Bounded: patience lasts as long as a conversational reply may take (`replyWaitMs`).
      // A sent message whose reply has not arrived yet is also still in flight.
      const pending =
        !changed && (ctx.awaitingReply || (await stillBusy(ctx.page)) || (await readInProgressStatus(ctx.page)) !== null);
      const busy = pending && ctx.busyWaitedMs < ctx.replyWaitMs;
      ctx.busyWaitedMs = busy ? ctx.busyWaitedMs + (ctx.now() - t0) : 0;
      // Nothing changed and nothing is pending: waiting again cannot help (#79).
      ctx.quietWaits = changed || pending ? 0 : ctx.quietWaits + 1;
      note = `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s (${
        changed
          ? "the page changed"
          : busy
            ? "no change yet — the app is still working"
            : pending
              ? "the page did not change"
              : "the page did not change and nothing is pending — waiting again will not help"
      })`;
      if (busy) changed = true;
      record(true, note);
    } else {
      ctx.quietWaits = 0;
      // #109 — act() itself polls the scroll position (of the nearest scrollable container under
      // the pointer, else the window) until it settles, so this never reads immediately after the
      // wheel event before the scroll it dispatched has actually happened.
      const r = await act(cfg.actor, { op: decision.op, control: null });
      if (r.ok && r.moved === true) ctx.scrollsSinceMutation += 1;
      changed = r.moved === true;
      ctx.lastScrollMoved = r.ok && changed;
      note = `${decision.op === "scroll_down" ? "scrolled down" : "scrolled up"} (${changed ? "the page moved" : "the page did not move — nothing more that way"})`;
      record(r.ok, r.ok ? note : r.reason);
    }
    ctx.history.push(note);
    if (changed) {
      ctx.idleSteps = 0;
  ctx.idleSince = null;
      ctx.idleSince = null;
    } else {
      ctx.idleSteps += 1;
      ctx.idleSince = ctx.idleSince ?? ctx.now();
    }
    ctx.lastActedOp = decision.op;
    ctx.statusAfter = decision.op === "wait" ? "waiting" : "scrolling";
    if (ctx.quietWaits >= MAX_QUIET_WAITS) {
      const cause = ctx.blockingCause();
      ctx.incomplete = `stuck: ${cause ?? `${ctx.quietWaits} waits changed nothing and nothing was pending`}`;
      ctx.stop = "no-progress";
      return "stop";
    }
    // Stuck = several idle steps AND for as long as a slow reply may take (`replyWaitMs`): a long
    // simulation or LLM turn gets that long before the run gives up on it.
    if (ctx.idleSteps >= MAX_IDLE_STEPS && ctx.idleSince !== null && ctx.now() - ctx.idleSince >= ctx.replyWaitMs) {
      ctx.incomplete = `stuck: ${ctx.idleSteps} wait/scroll steps over ${Math.round((ctx.now() - (ctx.idleSince ?? ctx.now())) / 1000)}s changed nothing`;
      ctx.stop = "no-progress";
      return "stop";
    }
    return "continue";
}
