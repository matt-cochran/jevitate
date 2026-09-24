import type { Page } from "playwright";
import type { Control } from "./snapshot.js";
import { monitorFor } from "./page-monitor.js";
import { visibleBusyIndicator } from "./hang.js";

/**
 * Conversational pages (chat composers, assistants, interview flows): the independent-code side of
 * the explore loop's multi-turn behaviour. Everything here is deterministic — the model proposes
 * actions, this code decides whether a composer was actually submitted, whether a reply arrived,
 * whether the loop is re-typing without sending, and whether a proposed `done` is grounded.
 *
 * Dogfood evidence (Preveti J2, 2026-09-23): the loop typed into "Type a reply" five times in a row,
 * each overwrite discarding the last, and never pressed Enter or Send — the app never received a
 * message — then proposed `done`.
 */

/** Default ceiling (ms) on waiting for a conversational reply after a message is sent. */
export const REPLY_WAIT_MS = 60_000;
/** A reply is complete once the page has been quiet (no DOM mutation, no request) this long. */
export const REPLY_QUIET_MS = 1_000;
/** New text shorter than this (after filtering the echoed message and busy text) is not a reply. */
export const MIN_REPLY_CHARS = 12;
/** How much reply text is kept for the transcript / the next prompts. */
export const REPLY_KEEP_CHARS = 1_500;

/** Names of controls that submit a composer (a chat Send button, a form's submit). */
export const SUBMIT_NAME = /\b(send|submit|reply|ask|post)\b|[→➤➔↑]|^\s*(go|ok)\s*$/i;

/** Transient "the assistant is working" text — never a reply. */
const BUSY_TEXT =
  /^(thinking|typing|loading|generating|sending|working|searching|preparing|processing|analy[sz]ing|drafting|please wait|one moment)\b.{0,60}$/i;
/**
 * A status line saying a reply is still on its way ("Waiting for the server to confirm your message…",
 * "Confirmation pending", "This may take a few minutes") — the reply has NOT arrived yet.
 */
const PENDING_STATUS =
  /\b(waiting for|confirmation pending|pending confirmation|may take (a few |several )?(seconds|minutes|a moment)|in progress|still working|hang tight|please wait)\b/i;
/** A short status line that trails off ("Preparing your conversation…") — transient, never a reply. */
const TRAILING_STATUS = /^.{0,60}(…|\.\.\.)$/;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A line with its numbers blanked (to recognise a counter that ticked). */
const shape = (s: string): string => s.replace(/\d+(?:[.,]\d+)*/g, "#");

/**
 * The text that appeared on the page since `baseline`, excluding the user's own (echoed) message
 * and transient busy text. Line-based multiset difference: a line already present before the send
 * is not new, however many times the page re-renders it.
 */
export function newPageText(baseline: string, current: string, sent: string): string {
  const before = new Map<string, number>();
  for (const l of baseline.split("\n").map(norm).filter((l) => l.length > 0)) {
    before.set(l, (before.get(l) ?? 0) + 1);
  }
  const sentN = norm(sent);
  const fresh: string[] = [];
  for (const l of current.split("\n").map(norm).filter((l) => l.length > 0)) {
    const n = before.get(l) ?? 0;
    if (n > 0) {
      before.set(l, n - 1);
      continue;
    }
    if (sentN.length > 0 && (sentN.includes(l) || (l.includes(sentN) && l.length - sentN.length < 24))) continue;
    if (BUSY_TEXT.test(l) || TRAILING_STATUS.test(l) || PENDING_STATUS.test(l)) continue;
    fresh.push(l);
  }
  // A line that merely UPDATED a number in place ("400.00 credits" → "399.76 credits") is a
  // counter ticking, not something said: its digit-free shape matches a line that went away.
  const gone = new Set<string>();
  for (const [l, n] of before) if (n > 0) gone.add(shape(l));
  return fresh.filter((l) => !(/\d/.test(l) && gone.has(shape(l)))).join("\n");
}

/**
 * The page text minus every line the run itself authored (messages it sent) — so a goal judgment is
 * never grounded on the user's own words echoed back (dogfood J-11: "Next steps…" typed by jevitate
 * read as the app's answer).
 */
export function withoutAuthored(text: string, sent: readonly string[]): string {
  const mine = sent.map(norm).filter((m) => m.length > 0);
  return text
    .split("\n")
    .filter((l) => {
      const n = norm(l);
      return n.length === 0 || !mine.some((m) => m.includes(n) || (n.includes(m) && n.length - m.length < 24));
    })
    .join("\n");
}

/** Normalized form used to compare messages (repeat detection). */
export function sameMessage(a: string, b: string): boolean {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** True when a line added since `baseline` says the reply is still pending (see `PENDING_STATUS`). */
export function pendingStatusShown(baseline: string, current: string): boolean {
  const before = new Set(baseline.split("\n").map(norm));
  return current
    .split("\n")
    .map(norm)
    .some((l) => l.length > 0 && !before.has(l) && PENDING_STATUS.test(l));
}

/** True when `text` is substantial enough to be a reply (not a timestamp or a status chip). */
export function isReply(text: string): boolean {
  return norm(text).length >= MIN_REPLY_CHARS;
}

export interface ReplyResult {
  /** True when new, stable reply text appeared within the ceiling. */
  readonly received: boolean;
  /** The reply text (bounded); partial text when the ceiling passed mid-reply, "" when none. */
  readonly text: string;
  readonly waitedMs: number;
}

/** BROWSER CODE — the page's visible text. */
function bodyText(): string {
  return typeof document !== "undefined" && document.body ? document.body.innerText : "";
}

/** The page's visible text (empty when unreadable — never a throw). */
export async function readPageText(page: Page): Promise<string> {
  return page.evaluate(bodyText).catch(() => "");
}

/**
 * Waits for the conversational reply to a message just sent: new page text (not the echoed message,
 * not busy text) that then holds still for the quiet window with no request in flight and no busy
 * indicator. Bounded by `timeoutMs` — separate from (and longer than) the 15s render wait, because a
 * reply can be a slow LLM call. Never throws; a missing reply is reported, not guessed.
 */
export async function waitForReply(
  page: Page,
  opts: { readonly baseline: string; readonly sent: string; readonly timeoutMs?: number; readonly quietMs?: number; readonly pollMs?: number },
): Promise<ReplyResult> {
  const timeoutMs = opts.timeoutMs ?? REPLY_WAIT_MS;
  const quietMs = opts.quietMs ?? REPLY_QUIET_MS;
  const pollMs = opts.pollMs ?? 250;
  const started = Date.now();
  const remaining = (): number => timeoutMs - (Date.now() - started);
  let latest = "";
  while (remaining() > 0) {
    const text = await readPageText(page);
    latest = newPageText(opts.baseline, text, opts.sent);
    const busy =
      (await page.evaluate(visibleBusyIndicator).catch(() => null)) ??
      (pendingStatusShown(opts.baseline, text) ? "pending status" : null);
    if (isReply(latest) && busy === null) {
      // Streaming replies keep mutating: wait for the page to settle, then confirm it held still.
      await monitorFor(page)
        .waitSettled({ quietMs, ceilingMs: Math.max(1, Math.min(remaining(), 15_000)) })
        .catch(() => undefined);
      const againText = await readPageText(page);
      const again = newPageText(opts.baseline, againText, opts.sent);
      const stillBusy =
        (await page.evaluate(visibleBusyIndicator).catch(() => null)) ??
        (pendingStatusShown(opts.baseline, againText) ? "pending status" : null);
      if (again === latest && stillBusy === null) {
        return { received: true, text: latest.slice(0, REPLY_KEEP_CHARS), waitedMs: Date.now() - started };
      }
      latest = again;
      continue;
    }
    await page.waitForTimeout(Math.max(1, Math.min(pollMs, remaining()))).catch(() => undefined);
  }
  return { received: false, text: latest.slice(0, REPLY_KEEP_CHARS), waitedMs: Date.now() - started };
}

/**
 * Waits (bounded) for the page's visible text to change — what a `wait` decision means in the goal
 * loop: give an async update the chance to land, instead of a fixed 250ms nap the model repeats.
 */
export async function waitForChange(page: Page, timeoutMs: number): Promise<boolean> {
  const before = await readPageText(page);
  return page
    .waitForFunction((b) => (document.body ? document.body.innerText : "") !== b, before, {
      timeout: Math.max(1, timeoutMs),
      polling: 250,
    })
    .then(
      async (h) => {
        await h.dispose().catch(() => undefined);
        return true;
      },
      () => false,
    );
}

/**
 * Is the page still working on something (a request in flight, or a visible busy indicator)? A
 * `wait` that saw no change while the app is still busy is patience, not idleness.
 */
export async function stillBusy(page: Page): Promise<boolean> {
  if (monitorFor(page).pending().length > 0) return true;
  return (await page.evaluate(visibleBusyIndicator).catch(() => null)) !== null;
}

/** True when a control reads as the submit of a composer or form (Send, Submit, Reply, →). */
export function isSubmitControl(c: Pick<Control, "role" | "name" | "tag" | "inputType">): boolean {
  const clickable = c.role === "button" || c.tag === "button" || (c.tag === "input" && c.inputType === "submit");
  return clickable && SUBMIT_NAME.test(c.name);
}

/** Text typed into a field and not yet submitted. `message`: typed as a conversation turn. */
export interface PendingText {
  readonly label: string;
  readonly text: string;
  readonly message: boolean;
}

/**
 * The anti-pattern detector: a `type` into a field that already holds text this run typed and never
 * submitted (no Enter/Send, no navigation in between). Each type overwrites the last, so the app
 * never receives anything. Independent code: it keys on the field, not on anything the model says.
 */
export class UnsubmittedTypeTracker {
  readonly #pending = new Map<string, PendingText>();
  #stuck = 0;

  /** Fields (by key) holding typed-but-unsubmitted text: their labels and the text typed. */
  pending(): ReadonlyMap<string, PendingText> {
    return this.#pending;
  }

  /** How many repeated-type attempts were caught (the loop's stuck signal). */
  get stuckSignals(): number {
    return this.#stuck;
  }

  /** True when typing into `field` now would overwrite unsubmitted text (the anti-pattern). */
  wouldRepeat(field: string): boolean {
    return this.#pending.has(field);
  }

  /** Count one caught repeat; returns the running total. */
  noteRepeat(): number {
    this.#stuck += 1;
    return this.#stuck;
  }

  /** A successful plain `type` into `field` (text now waiting to be submitted). */
  typed(field: string, label: string, text: string, message = false): void {
    this.#pending.set(field, { label, text, message });
  }

  /** The composer/form was submitted, or the page navigated: nothing is pending any more. */
  submitted(): void {
    this.#pending.clear();
  }

  /** Forget fields no longer on the page (their text went with them). */
  retain(present: ReadonlySet<string>): void {
    for (const k of [...this.#pending.keys()]) if (!present.has(k)) this.#pending.delete(k);
  }
}

/** Completion of a run: the goal's success condition observably met, or why not. */
export type RunOutcome =
  | { readonly status: "completed"; readonly verifiedBy: "success-condition" | "grounded-judgment" }
  | { readonly status: "incomplete"; readonly reason: string };

/** A proposed `done`, weighed by code. */
export type DoneVerdict = { readonly accept: true; readonly outcome: RunOutcome } | { readonly accept: false; readonly reason: string };

/** Probability the advisory goal judgment must reach before code accepts an un-oracled `done`. */
export const GOAL_MET_THRESHOLD = 0.75;

export interface DoneEvidence {
  /** Fields holding typed text that was never submitted (labels). */
  readonly unsubmitted: readonly string[];
  /** The independent success condition, when the mission has one: true/false; undefined = none. */
  readonly successCheck?: boolean;
  /**
   * The advisory model judgment "is the goal observably achieved on this page" (probability), asked
   * only when no success condition exists. `null` = the judgment was unavailable.
   */
  readonly goalMetProbability?: number | null;
}

/**
 * Grounds a model-proposed `done` (the model's word is a proposal, never the verdict):
 *  - typed text still unsubmitted → not done (the app never received it);
 *  - an independent success condition decides when present;
 *  - otherwise the advisory goal judgment must clear `GOAL_MET_THRESHOLD`.
 */
export function groundDone(e: DoneEvidence): DoneVerdict {
  if (e.unsubmitted.length > 0) {
    return { accept: false, reason: `typed text in ${e.unsubmitted.map((l) => `"${l}"`).join(", ")} was never submitted` };
  }
  if (e.successCheck !== undefined) {
    return e.successCheck
      ? { accept: true, outcome: { status: "completed", verifiedBy: "success-condition" } }
      : { accept: false, reason: "the success condition is not met on this page" };
  }
  const p = e.goalMetProbability;
  if (p === undefined || p === null) return { accept: false, reason: "goal completion could not be judged on this page" };
  if (p < GOAL_MET_THRESHOLD) {
    return { accept: false, reason: `the goal is not observably achieved on this page (p=${p.toFixed(2)})` };
  }
  return { accept: true, outcome: { status: "completed", verifiedBy: "grounded-judgment" } };
}
