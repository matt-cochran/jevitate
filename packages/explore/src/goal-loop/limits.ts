/**
 * The goal loop's public limits (#232). Defined here so the loop's step modules can read them
 * without importing `explore.ts` (which imports them); `explore.ts` re-declares each one under the
 * same name, so `@jevitate/explore`'s export surface is unchanged.
 */

/** Default cap (chars) on a generated chat message. */
export const REPLY_MAX_CHARS = 300;
/** Default bound (ms) a `wait` decision waits for the page to change. */
export const WAIT_OP_MS = 3_000;
/** Consecutive `wait`/`scroll` steps that change nothing before the run stops as no-progress. */
export const MAX_IDLE_STEPS = 6;
/** Cap (chars) on a generated free-text form value. */
export const FORM_TEXT_MAX_CHARS = 600;
/** Rejected `done` proposals before the run stops incomplete. */
export const MAX_DONE_REJECTIONS = 3;
/** Rejected (ungrounded) `report` answers before the run stops incomplete (#101). */
export const MAX_REPORT_REJECTIONS = 3;
/** Repeated-type (typed, never sent, typed again) signals before the run stops as no-progress. */
export const MAX_REPEAT_TYPE_SIGNALS = 3;
/**
 * Consecutive `wait`s that changed nothing while NOTHING was pending (no request in flight, no busy
 * indicator, no awaited reply) before the run stops as stuck, naming what the page shows (#79).
 */
export const MAX_QUIET_WAITS = 3;
/**
 * Consecutive scrolls that MOVED the page (with no new page state) that count as progress (#172):
 * scrolling to read a long page is progress until the end is reached; past this bound (e.g. a
 * scroll up/down loop) a moved scroll counts as an unchanged step again.
 */
export const MAX_MOVING_SCROLLS = 12;

/** The one "last chance" turn the model gets before a no-progress stop (#172). */
export const LAST_CHANCE_NOTE =
  "no progress: the last steps left the page unchanged and you have seen the whole page — act on a visible control, report the answer, or say done/blocked now";
