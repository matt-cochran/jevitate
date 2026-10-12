/** `createRunContext`: page status (#79), interceptors (#90), refusals (#168), failed actions (#272/#294) and blockers (#84, #371) (#500: moved verbatim out of `context.ts`). */
import type { Control } from "../../snapshot.js";
import { EMPTY_STATUS } from "../../status.js";
import { FailedActionStreak, openOverlayName } from "../../stuck-actions.js";
import { keyOf, quote } from "../helpers.js";
import type { MutableRunContext } from "./types.js";

export function initBlockers(ctx: MutableRunContext): void {
  /** The page's status text (alerts, invalid fields) at the latest perception (#79). */
  ctx.status = EMPTY_STATUS;
  /** The step whose effect the next status read reports ("after <step>: alert …"). */
  ctx.statusAfter = null;
  /** Consecutive `wait`s that changed nothing while nothing was pending. */
  ctx.quietWaits = 0;
  /**
   * CSS selectors (parsed from a Playwright "intercepts pointer events" failure, #90) for elements
   * proven to cover a real click. Every control they still cover is withheld from the model until the
   * page state changes — a click failure otherwise burns the whole run re-choosing the same or a
   * sibling target under the same backdrop.
   */
  ctx.blockedInterceptors = [];
  /** The page signature blocked interceptors were recorded against — cleared once it changes. */
  ctx.blockedSinceSignature = null;
  /**
   * Controls the shared safety policy (#116) has refused this run (#168): once refused, a control is
   * withheld from the model's candidates for the rest of the run — same as the interceptor-blocked
   * set above — so a re-decide never re-chooses the same refused control.
   */
  ctx.refusedKeys = new Set<string>();
  /** #235: the latest safety refusal's reason (named when the model then gives up), else null. */
  ctx.lastRefusal = null;
  /**
   * #272 / #294: real actions that failed, in a row — a covered / unreachable target is withheld
   * after its second failure, and `MAX_FAILED_ACTIONS` failures in a row end the run, whatever the
   * page signature did meanwhile (a failed click that scrolls the page can flicker it).
   */
  ctx.failedActs = new FailedActionStreak();
  /**
   * #242: the last plain `type` into a form field, judged at the next perception — did anything
   * besides that field's own value change (a request, another control)? — and how many such types in
   * a row into the same field changed nothing else.
   */
  ctx.typeProbe = null;
  ctx.typeNoEffect = null;
  /**
   * #242 × #241: a type credited ONLY with requests to endpoints the page had not been seen requesting
   * yet (a background poll's FIRST tick can land in any action's window). Held, not trusted: once the
   * next type into the same field finds those endpoints are the page's background traffic, the
   * credited type was no effect either and the streak resumes instead of restarting.
   */
  ctx.typeCredit = null;
  /** #237: actions the run attempted (any target op or reload, landed or not), and early `blocked`s refused. */
  ctx.actionAttempts = 0;
  ctx.earlyBlocked = 0;
  /**
   * #276: steps since the last executed page-changing action that were jevitate's own refusals, or
   * scrolls that moved the page (the app answered them). A stall over such steps is the run's (nothing it tried reached the app), never an app
   * `ui-no-progress` hang.
   */
  ctx.refusedSinceMutation = 0;
  ctx.scrollsSinceMutation = 0;
  /** The concrete causes the run ran into, for a precise stop reason (#84). */
  ctx.blockers = {
    failClosed: null,
    target: null,
    latest: null,
  };
  /**
   * The most concrete cause known now, in #84's priority order; null when there is none. An invalid
   * field is named ONLY when the last action taken was a click that sent no request at all (#130a) —
   * the shape of a form submit the browser's own validation silently blocked. A click that DID send a
   * request (even to the wrong endpoint — a `--success` typo, say) clears the field as the blocker: an
   * unrelated field's stale `:invalid` state elsewhere on the page never gets blamed for that. An
   * error toast/alert is preferred over a field either way.
   */
  ctx.blockingCause = (): string | null => {
    if (ctx.blockers.failClosed !== null) return ctx.blockers.failClosed;
    // #371: of the failed target actions, the LATEST is named — a disabled hint button met at step 3
    // never stands in for the rejected types at steps 38–41. A tie (one step) keeps the target's text.
    const { target, latest } = ctx.blockers;
    if (latest !== null && (target === null || latest.step > target.step)) return latest.text;
    if (target !== null) return target.text;
    const alert = ctx.status.alerts[0];
    if (alert !== undefined) return `the page shows alert ${quote(alert)}`;
    const field = ctx.status.invalid[0];
    const lastClick = ctx.sideEffects.lastClick();
    const blockedBySubmit = ctx.lastActedOp === "click" && lastClick !== null && !lastClick.requestSent;
    if (field !== undefined && blockedBySubmit) return `field ${quote(field.name, 80)} is invalid — ${quote(field.message)}`;
    return null;
  };
  /**
   * A failed act's reason as the model sees it: a disabled / hidden target is named (its accessible
   * name often says why — "Analyze — enter a URL first"), and remembered as a blocker (#79, #84).
   */
  ctx.failNote = (reason: string | undefined, c: Control): string => {
    const r = reason ?? "?";
    if (r !== "target not enabled" && r !== "target not visible") return r;
    const name = quote(c.name || c.summary, 120);
    ctx.blockers.target = { key: keyOf(c), text: `${r === "target not enabled" ? "target disabled" : "target not visible"} — ${name}`, step: ctx.transcript.nextStep };
    return r === "target not enabled"
      ? `${r}: ${name} is disabled — its label may say what it needs first`
      : `${r}: ${name}`;
  };
  /** A control acted on successfully is no longer the blocker. */
  ctx.cleared = (c: Control): void => {
    if (ctx.blockers.target?.key === keyOf(c)) ctx.blockers.target = null;
    if (ctx.blockers.latest?.key === keyOf(c)) ctx.blockers.latest = null;
  };
  ctx.noteFailure = (op: string, c: Control, reason: string | undefined, refused: boolean): void => {
    const why = (reason ?? "?").replace(/^typed value rejected:\s*/, "");
    ctx.blockers.latest = {
      key: keyOf(c),
      text: `${op} ${quote(c.name || c.summary, 80)} ${refused ? "rejected" : "failed"}: ${quote(why, 200).slice(1, -1)}`,
      reason: reason ?? "?",
      step: ctx.transcript.nextStep,
    };
  };
  /**
   * #272 / #294: a REAL action on `c` failed (act ran, `ok: false`). Tells the model when the target
   * is withheld; returns true when the run must stop (`stop` / `incomplete` are set) — too many
   * failed actions in a row, naming the overlay that covers the page when there is one.
   */
  ctx.noteFailedAct = async (c: Control, reason: string | undefined): Promise<boolean> => {
    const v = ctx.failedActs.fail(keyOf(c), quote(c.name || c.summary, 80), reason ?? "?");
    if (v.note !== null) ctx.history.push(v.note);
    if (!v.stop) return false;
    const n = ctx.failedActs.consecutive;
    const last = quote(ctx.failedActs.lastReason() ?? "?", 200);
    const covered = ctx.failedActs.dominantCause() === "covered";
    const overlay = covered ? await ctx.page.evaluate(openOverlayName).catch(() => null) : null;
    if (overlay !== null) {
      ctx.incomplete = `blocked by an overlay: ${n} actions in a row failed because ${overlay} covers the page — it was never dismissed (last: ${last})`;
      ctx.stop = "blocked";
    } else {
      ctx.incomplete = `stuck: ${n} actions in a row failed${covered ? " (their targets were covered)" : ""} (last: ${last})`;
      ctx.stop = "no-progress";
    }
    return true;
  };
}
