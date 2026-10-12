import { isBookkeepingRequest, type SideEffect } from "./side-effects.js";

/**
 * #514 — the job's own write evidence, weighed by `groundDone` when the page judgment says the goal
 * is not observably met — and only with the advisory scope judgment (`GOAL_IS_WRITES_QUESTION`) that
 * the whole goal is what those writes did: a multi-step job writes 2xx at almost every step, so
 * "every write so far succeeded" alone holds halfway through it.
 *
 * Dogfood evidence (Autopilot CRM, "import the attached CSV of contacts"): every write the import
 * made succeeded (`POST …/crm-upload/sessions` 201, each `…/operations` 2xx), but the same CSV had
 * been imported by earlier runs, so no new contact appeared — the final page was identical to the
 * start page, and `done` was rejected 3 times (p 0.46 / 0.24 / 0.22).
 *
 * Pure evidence, no model: the writes (by the shared write classifier — read RPCs never count, #110)
 * that the run's ACTIONS fired since the mission started (`SideEffectLog`). A background write (page
 * load, token refresh, polling), a third-party one (#194), bookkeeping (#374) or a `--settle-ignore`d
 * request is not the job's. A write jevitate's own guard blocked (#158/#484) never succeeded, even
 * when the guard answered it in the browser (`204`); a write still in flight or with no response,
 * a 3xx or an error status did not succeed either.
 */
export interface WriteEvidence {
  /** The job's writes that finished with a 2xx. */
  readonly succeeded: number;
  /** Those writes, one line (method, endpoint, status — never a value): the scope judgment's facts. */
  readonly facts: string;
  /** The job's writes that did not (method, endpoint, status), and any blocked / unlisted ones. Never a value. */
  readonly unsucceeded: readonly string[];
}

/** Every job write succeeded and there is at least one: the code half of the #514 rule. */
export function writesAllSucceeded(w: WriteEvidence): boolean {
  return w.succeeded > 0 && w.unsucceeded.length === 0;
}

export function jobWriteEvidence(
  sideEffects: readonly SideEffect[],
  opts: { readonly truncated: number; readonly blocked: number; readonly ignore?: (endpoint: string) => boolean },
): WriteEvidence {
  let succeeded = 0;
  const done: string[] = [];
  const unsucceeded: string[] = [];
  for (const e of sideEffects) {
    if (e.background === true || e.thirdParty === true) continue;
    if (isBookkeepingRequest({ path: e.request.endpoint }) || opts.ignore?.(e.request.endpoint) === true) continue;
    const s = e.request.status;
    if (s !== null && s >= 200 && s < 300) {
      succeeded += 1;
      done.push(`${e.request.method} ${e.request.endpoint} → ${s}`);
    }
    else unsucceeded.push(`${e.request.method} ${e.request.endpoint} → ${s ?? "no response"}`);
  }
  if (opts.blocked > 0) unsucceeded.push(`${opts.blocked} write(s) blocked by jevitate's write guard`);
  if (opts.truncated > 0) unsucceeded.push(`${opts.truncated} more write(s) not listed`);
  return { succeeded, unsucceeded, facts: `the run's actions sent ${done.join(", ")} — every one succeeded` };
}
