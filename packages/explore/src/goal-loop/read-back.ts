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
import { readPageText } from "../conversation.js";
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
  const back = ctx.observed.readBack(await documentOf(ctx.page), redactPageText([text, ...values].join("\n"), ctx.secrets));
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
