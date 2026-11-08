/**
 * #647: the read-back probe. A 2xx says the app accepted a write, not that it kept it, so before an
 * ending (a `report`'s grounding, a `done`) rests on a page that shows what the run sent — possibly
 * the client's own echo — code reloads that page once (a GET through the actor, like any reload) and
 * reads what the server now renders. A value it shows again is read back from the app; one it no
 * longer shows stays unread, and the ending is held (handle-done, handle-report).
 *
 * The probe is verification, not part of the user's path: it is not recorded as a Journey step and
 * counts as no action. It never runs while a write is still in flight (a reload would abandon it).
 */
import { act } from "../act.js";
import { readPageText, type DoneVerdict } from "../conversation.js";
import { redactPageText } from "../redact.js";
import type { RunContext } from "./context.js";
import { documentOf } from "./helpers.js";
import type { Step } from "./step.js";

/** What the step's page shows: its visible text and its controls' current values. */
function shownOn(step: Step): string {
  return [step.visibleText, ...step.snap.controls.map((c) => c.value ?? "")].join("\n");
}

/**
 * Reloads the page once when it shows a sent value not yet read back, and reads the values the
 * reloaded page shows again. Returns them (empty when there was nothing to read back, or the probe
 * could not run).
 */
export async function readBackProbe(ctx: RunContext, step: Step): Promise<string[]> {
  const unread = ctx.observed.unreadShownIn(shownOn(step));
  if (unread.length === 0 || ctx.sideEffects.inflight().length > 0) return [];
  const r = await act(ctx.cfg.actor, { op: "reload", control: null });
  if (!r.ok) return [];
  const text = await readPageText(ctx.page, ctx.secrets).catch(() => "");
  // BROWSER CODE (evaluate): the form controls' current values — never a password field's.
  const values = await ctx.page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input, textarea, select"))
        .filter((e) => (e as HTMLInputElement).type !== "password")
        .map((e) => (e as HTMLInputElement).value ?? ""),
    )
    .catch(() => [] as string[]);
  const back = ctx.observed.readBack(await documentOf(ctx.page), redactPageText([text, ...values].join("\n"), ctx.secrets), ctx.page.url());
  const listed = (vs: readonly string[]): string => vs.map((v) => `"${v}"`).join(", ");
  const missing = unread.filter((v) => !back.includes(v));
  ctx.history.push(
    missing.length === 0
      ? `read back after a reload: the page loaded from the server shows what the run sent (${listed(back)})`
      : `after a reload, the page loaded from the server no longer shows what the run sent (${listed(missing)})`,
  );
  return back;
}

/** #647: the sent values the step's page shows that are still not read back (after any probe). */
export function unreadShown(ctx: RunContext, step: Step): string[] {
  return ctx.observed.unreadShownIn(shownOn(step));
}

/**
 * 0.30.0 (#800): the job done check, read in a FRESH context after the model's `done`: true = the
 * state it names holds, false = it does not, null = no reading could be taken. Supplied by the caller
 * as `cfg.doneCheck` (the fresh session is the reader's, never the run's own page).
 */
export type DoneCheckReader = () => Promise<boolean | null>;

/**
 * Lets the fresh-context done-check reading decide attainment on a verdict code accepted. Read false:
 * the verdict is rejected (`not-achieved`, `done-check`); true: `achieved`; unreadable (or a reader
 * that throws): the accept stands as `unverified`/`reading-unknown`. A rejection, or no reader,
 * leaves the verdict as it is. Whether the check was already true before the run is the caller's
 * business (`already-true`), not read here.
 */
export async function settleDoneCheck(ctx: RunContext, verdict: DoneVerdict): Promise<DoneVerdict> {
  const read = ctx.cfg.doneCheck;
  if (read === undefined || !verdict.accept) return verdict;
  const reading = await read().catch(() => null);
  if (reading === null) return { ...verdict, attainment: "unverified", basis: "reading-unknown" };
  if (!reading) {
    return {
      accept: false,
      reason: "the job's done check does not hold when read in a fresh session",
      attainment: "not-achieved",
      basis: "done-check",
    };
  }
  return { ...verdict, attainment: "achieved", basis: "done-check" };
}

/** The outcome with the job verdict attached, only when a done check was configured. */
export function withJob(ctx: RunContext, verdict: Extract<DoneVerdict, { accept: true }>): Extract<DoneVerdict, { accept: true }>["outcome"] {
  const o = verdict.outcome;
  if (ctx.cfg.doneCheck === undefined || o.status !== "completed") return o;
  return { ...o, job: { attainment: verdict.attainment, basis: verdict.basis } };
}
