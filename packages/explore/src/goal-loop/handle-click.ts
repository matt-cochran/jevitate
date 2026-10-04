/**
 * `click` (#90, #92, #123, #241, #283): a click — a conversation turn when it submits typed text
 * or picks a quick reply (its reply awaited like a `send`'s), refused when it would blindly re-fire a
 * write, and an interceptor a failed click proves is remembered. The goal loop's click handler, moved
 * out of `explore.ts` unchanged (#232).
 */

import { act, parseInterceptor } from "../act.js";
import { isSubmitControl, readPageText, waitForReply, type ReplyResult } from "../conversation.js";
import { hangRoute } from "../hang.js";
import { monitorFor } from "../page-monitor.js";
import { awaitWrites } from "../side-effects.js";
import { backgroundEndpoints, writesStartedSince } from "../stuck-actions.js";
import type { RunContext } from "./context.js";
import { TOGGLE_ROLES, actionIdentityOf, buttonLike, keyOf, noReply, quote, readRegionState, safePath } from "./helpers.js";
import type { Flow } from "./step.js";
import { type ActStep } from "./step.js";

export async function handleClick(ctx: RunContext, step: ActStep): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, keys, decision, record, control, at } = step;
  // A click that submits typed text (the composer's Send) or picks a quick reply offered with the
  // latest reply is a conversation turn: its reply is awaited like a `send`'s.
  const pendingTexts = [...ctx.unsent.pending().values()].filter((p) => p.message).map((p) => p.text);
  const submits = pendingTexts.length > 0 && isSubmitControl(control);
  // A quick reply: a short button that arrived with the latest reply (a chip, "Yes, draft it").
  const quickReply =
    ctx.offeredKeys.has(keyOf(control)) && control.role === "button" && control.name.length <= 60 && !/[→›»]/.test(control.name);
  const turn = submits || quickReply;
  // The repeated-side-effect guard (#92): a click that already fired a write on this page is not
  // re-fired while that write is in flight (wait for it instead) or after it went through,
  // unless the page offers a retry. Refused — never clicked — and the reason is recorded.
  // #356: identified by element + context (form / dialog / screen heading), never by the label alone.
  const identity = actionIdentityOf(control);
  const pageNow = { controlNames: snap.controls.map((c) => c.name), alerts: ctx.status.alerts };
  let repeat = ctx.sideEffects.check(identity, safePath(snap.url), pageNow);
  // #380: a finished write's control may be clicked again once its own region has moved on since it
  // (another state may send another request) — never a paid / destructive one.
  const stateless = ctx.safety.riskOf(control) !== null;
  const readState = (): Promise<string | undefined> =>
    stateless ? Promise.resolve(undefined) : readRegionState(ctx.page, control, ctx.secrets);
  if (repeat.refuse && !repeat.inflight && !stateless) {
    const state = await readState();
    repeat = ctx.sideEffects.check(identity, safePath(snap.url), { ...pageNow, ...(state === undefined ? {} : { state }) });
  }
  if (repeat.refuse) {
    let note = repeat.reason;
    if (repeat.inflight) {
      const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, ctx.replyCeilingMs);
      note += ` (waited ${(w.waitedMs / 1000).toFixed(1)}s: ${w.resolved ? "it resolved" : "it is still in flight"})`;
    }
    ctx.history.push(note);
    record(false, note, { origin: "engine" });
    ctx.lastActedOp = decision.op;
    return "continue";
  }
  const baseline = turn ? await readPageText(ctx.page, ctx.secrets) : "";
  const before = await readState();
  ctx.clickedRegion = readState;
  ctx.sideEffects.beginClick(identity, control.name || control.summary, safePath(snap.url), ctx.now(), before);
  const r = await act(cfg.actor, { op: "click", control });
  let reply: ReplyResult | undefined;
  let message: string | undefined;
  if (r.ok) {
    ctx.recorder.click(control.descriptor, at);
    ctx.noteMutation(`click ${control.name}`, control.descriptor, snap.signature, at, undefined, control.role === "link" ? hangRoute(snap.url) : null, hangRoute(snap.url));
    ctx.tracker.countAction();
    if (isSubmitControl(control)) ctx.unsent.submitted();
    // What was typed has now been submitted (a form's button): an add-another flow's next
    // item must differ from it (#123).
    if (buttonLike(control) || control.submits === true) {
      ctx.valueLog.submitted();
      ctx.save.noteSubmitClick(control.name || control.summary);
    }
    // Toggling an input (a checkbox, a radio, a switch) changes what a repeat would send (#92).
    if (TOGGLE_ROLES.has(control.role) || (control.tag === "input" && control.inputType !== "submit" && control.inputType !== "button")) {
      // A radio/option now holds "selected"; a checkbox/switch flips — so toggling twice is no
      // change (#123). Clicking into a text input changes nothing it would send.
      const picks = ["radio", "option", "menuitemradio"].includes(control.role) || control.inputType === "radio";
      const flips = ["checkbox", "switch", "menuitemcheckbox"].includes(control.role) || control.inputType === "checkbox";
      if (picks) ctx.sideEffects.inputChanged(keyOf(control), "selected");
      else if (flips) ctx.sideEffects.inputChanged(keyOf(control), { toggled: true });
    }
    if (turn) {
      message = submits ? pendingTexts.join("\n") : control.name;
      ctx.conversation.sent.push(message);
      ctx.preSend ??= baseline;
      // The endpoints requested before the click (computed after it: only requests started
      // before `at` count) — the turn's own write is its work, never background (#241 × #283).
      const turnBackground = backgroundEndpoints(monitorFor(ctx.page), at, ctx.turnWrites);
      for (const k of writesStartedSince(monitorFor(ctx.page), at, ctx.isWrite)) if (!turnBackground.has(k)) ctx.turnWrites.add(k);
      reply = await waitForReply(ctx.page, {
        secrets: ctx.secrets,
        baseline,
        sent: message,
        sentAt: at,
        background: turnBackground,
        timeoutMs: ctx.replyWaitMs,
        ceilingMs: ctx.replyCeilingMs,
        quietMs: ctx.replyQuietMs,
      });
      if (reply.received) {
        ctx.conversation.latestReply = reply.text;
        ctx.replies.add(snap.url, reply.text);
      }
      ctx.awaitingReply = !reply.received;
      ctx.busyWaitedMs = reply.waitedMs;
      ctx.lastTurn = { baseline, sent: message, sentAt: at, background: turnBackground };
      ctx.offerBaseline = new Set(keys.keys());
      ctx.history.push(
        `clicked ${control.name}${quickReply ? " (a quick reply)" : ""} → ` +
          (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
      );
      ctx.noteStuckConversation(snap.controls);
    } else {
      ctx.history.push(`clicked ${control.name}`);
    }
    ctx.cleared(control);
  } else {
    ctx.history.push(`click failed: ${ctx.failNote(r.reason, control)}`);
    // #90 — a real "intercepts pointer events" failure proves what covers this control (and,
    // in practice, its neighbours under the same backdrop): remember it so the model is not
    // offered another target it covers until the page changes.
    const interceptor = r.reason === undefined ? null : parseInterceptor(r.reason);
    if (interceptor !== null && !ctx.blockedInterceptors.includes(interceptor)) {
      ctx.blockedInterceptors = [...ctx.blockedInterceptors, interceptor];
      ctx.blockedSinceSignature = snap.signature;
    }
  }
  record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control), {
    ...(message === undefined ? {} : { message }),
    ...(reply === undefined ? {} : { reply }),
  });
  if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
    ctx.lastActedOp = decision.op;
    return "stop";
  }
  return "next";
}
