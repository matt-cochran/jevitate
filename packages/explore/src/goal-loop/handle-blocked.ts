/**
 * `blocked` (#92, #237, #283, #693): the model gives up — deferred into a bounded job wait while the
 * app is still working, refused while nothing was tried yet or an obvious goal-named control remains,
 * else the run stops. The goal loop's blocked handler, moved out of `explore.ts` unchanged (#232).
 */
import { monitorFor } from "../page-monitor.js";
import { awaitWrites } from "../side-effects.js";
import { readInProgressStatus } from "../status.js";
import type { Control } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { terms } from "./goal-focus.js";
import { JOB_WAIT_SLICE_MS, MAX_EARLY_BLOCKED_REFUSALS, quote, waitOutJob } from "./helpers.js";
import { deferEnding } from "./min-effort.js";
import type { Flow, Step } from "./step.js";

/** Controls that go backwards / dismiss: never the "obvious forward control" #693 protects. */
const NON_FORWARD = /^(?:back|go back|previous|return|cancel|close|dismiss|×|x|←|‹|arrow[- ]?left)\b/i;
/** An imperative cue: the page is instructing the user to take an action, not merely showing a label. */
const DIRECTIVE = /\b(?:choose|select|pick|apply|submit|continue|confirm|save|open|click|press|start|create|send|next|review|accept|approve|add|complete|proceed|generate|upload|finish|sign|log|book|buy|upgrade|run|try|edit|set)\b/i;

/** The label-only comparison used to strip controls out of the page text (so a button's own label is no instruction). */
const normalized = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The page text with each control's rendered label removed (as many occurrences as the page renders). */
function instructionText(controls: readonly Control[], visibleText: string): string {
  const counts = new Map<string, number>();
  for (const c of controls) {
    const label = normalized(c.name);
    if (label !== "") counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let text = normalized(visibleText);
  // Remove labels from the END: an instruction before the control stays, a label alone is gone.
  for (const [label, count] of counts) for (let i = 0; i < count; i++) {
    const matches = [...text.matchAll(new RegExp(`\\b${escaped(label)}\\b`, "g"))];
    const last = matches.at(-1);
    if (last?.index === undefined) break;
    text = `${text.slice(0, last.index)} ${text.slice(last.index + last[0].length)}`.replace(/\s+/g, " ").trim();
  }
  return text;
}

/**
 * #693 — an enabled, untried forward control that the goal and the page's own instruction both
 * name. Deterministic: the page text minus the controls' labels must be an instruction containing
 * every content word of the control's name, and at least one of those words must be in the goal.
 */
function primaryForwardControl(ctx: RunContext, step: Step): Control | null {
  const goalTerms = terms(ctx.goalText);
  if (goalTerms.size === 0) return null;
  const instruction = instructionText(step.modelControls, step.visibleText);
  const instructionTerms = terms(instruction);
  if (instructionTerms.size === 0 || !DIRECTIVE.test(instruction)) return null;
  for (const control of step.modelControls) {
    if (!control.enabled) continue;
    const name = control.name.trim();
    if (name === "" || NON_FORWARD.test(name)) continue;
    if (ctx.depth.tried(step.snap.url, name)) continue;
    const controlTerms = terms(name);
    if (controlTerms.size === 0) continue;
    if ([...controlTerms].some((t) => goalTerms.has(t)) && [...controlTerms].every((t) => instructionTerms.has(t))) return control;
  }
  return null;
}

export async function handleBlocked(ctx: RunContext, step: Step): Promise<Flow> {
  const { modelControls, record } = step;
  // The page says work is under way (#92): "blocked" is premature while a job the page reports
  // is still running. Code defers it into a bounded job wait; past the budget it stands.
  const job = await readInProgressStatus(ctx.page);
  // #283: likewise while a write an earlier click fired is still in flight (the request IS the job).
  if (job === null && ctx.jobWaitedMs < ctx.jobWaitMs && ctx.sideEffects.inflight().length > 0) {
    const what = ctx.inflightWrites();
    const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
    ctx.jobWaitedMs = w.resolved ? 0 : ctx.jobWaitedMs + w.waitedMs;
    const note = `blocked deferred: ${what} (sent by an earlier click) is still in flight — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
      w.resolved ? "it resolved" : `still in flight; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
    })`;
    ctx.history.push(note);
    record(true, note, { op: "wait" });
    ctx.idleSteps = 0;
    ctx.idleSince = null;
    ctx.quietWaits = 0;
    ctx.lastActedOp = "wait";
    ctx.statusAfter = "waiting";
    return "continue";
  }
  if (job !== null && ctx.jobWaitedMs < ctx.jobWaitMs) {
    const w = await waitOutJob(ctx.page, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
    ctx.jobWaitedMs = w.cleared ? 0 : ctx.jobWaitedMs + w.waitedMs;
    const note = `blocked deferred: the page shows ${job} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
      w.cleared ? "the status cleared" : `still in progress; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
    })`;
    ctx.history.push(note);
    record(true, note, { op: "wait" });
    ctx.idleSteps = 0;
    ctx.idleSince = null;
    ctx.quietWaits = 0;
    ctx.lastActedOp = "wait";
    ctx.statusAfter = "waiting";
    return "continue";
  }
  // #237: giving up before trying anything proves nothing about the app. Refused (and the model
  // told to explore) while the page offers controls; a model that insists ends `inconclusive`.
  const untried = modelControls.filter((c) => c.enabled);
  // A find-out goal that already made a grounded report attempt here searched the page (#207).
  // #377: never refused while the success checks already hold on this page — only when they do not.
  if (
    ctx.actionAttempts === 0 &&
    untried.length > 0 &&
    ctx.reportRejections === 0 &&
    !(await (ctx.cfg.successChecksHoldNow?.() ?? Promise.resolve(false)).catch(() => false))
  ) {
    ctx.earlyBlocked += 1;
    if (ctx.earlyBlocked <= MAX_EARLY_BLOCKED_REFUSALS) {
      const nav = [...untried.filter((c) => (c.landmark ?? null) !== null), ...untried.filter((c) => (c.landmark ?? null) === null)];
      const names = nav.slice(0, 6).map((c) => quote(c.name || c.summary, 40)).join(", ");
      const reason = `blocked refused: nothing was tried yet — ${untried.length} control(s) on this page are untried (e.g. ${names}); explore them (the navigation, settings, menus) before giving up`;
      ctx.history.push(reason);
      record(false, reason, { origin: "engine" });
      return "continue";
    }
    record(false, "model blocked before trying any action", { origin: "engine" });
    ctx.failure = {
      kind: "insufficient-coverage",
      message: `the model gave up before trying any of the page's ${untried.length} controls — too little exploration to conclude the goal cannot be done`,
    };
    ctx.stop = "inconclusive";
    return "stop";
  }
  // #693: after earlier actions, a page can still have the obvious next control the goal and its
  // instruction name — a `blocked` there is refused under the same bounded accounting as #237.
  const forward = ctx.actionAttempts > 0 ? primaryForwardControl(ctx, step) : null;
  if (forward !== null) {
    ctx.earlyBlocked += 1;
    if (ctx.earlyBlocked <= MAX_EARLY_BLOCKED_REFUSALS) {
      const reason = `blocked refused: ${quote(forward.name || forward.summary, 60)} is an obvious forward control, still untried on this page, and it matches the goal and the page's instruction — use it before giving up`;
      ctx.history.push(reason);
      record(false, reason, { origin: "engine" });
      return "continue";
    }
    record(false, `model blocked while ${quote(forward.name || forward.summary, 60)} remained untried`, { origin: "engine" });
    ctx.failure = {
      kind: "insufficient-coverage",
      message: `the model gave up while ${quote(forward.name || forward.summary, 60)} — the obvious forward control the goal and the page's instruction name — was still untried after earlier actions — too little exploration to conclude the goal cannot be done`,
    };
    ctx.stop = "inconclusive";
    return "stop";
  }
  // #424: below the minimum exploration effort, giving up is deferred — the model is steered to breadth.
  const deferred = deferEnding(ctx, step, "blocked");
  if (deferred !== null) {
    record(false, deferred, { origin: "engine" });
    return "continue";
  }
  record(true, "model blocked");
  // #235: a control the goal needed may have been refused — the reason says so, actionably.
  ctx.incomplete = `the model reported the goal cannot be advanced from this page${ctx.lastRefusal === null ? "" : ` (${ctx.lastRefusal})`}`;
  ctx.stop = "blocked";
  return "stop";
}
