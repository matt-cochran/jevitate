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

/**
 * Default IDLE patience (ms) of a reply wait: how long it keeps waiting while the page shows no sign
 * of working on a reply (no request in flight, no busy indicator, no reply text growing). While the
 * page IS working, the wait continues up to `REPLY_CEILING_MS` (#93: LLM turns routinely take 60–100s).
 */
export const REPLY_WAIT_MS = 60_000;
/** Default hard ceiling (ms) on one reply wait, however busy the page stays. */
export const REPLY_CEILING_MS = 180_000;
/** A request that started this long before the reply wait began still counts as the send's own. */
const SEND_REQUEST_SLACK_MS = 5_000;
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
 * The NEW assistant turn only (#122): `newPageText` is every line that changed anywhere on the page
 * — a sidebar that re-rendered its inquiry titles, a header counter, a whole page after navigation —
 * so the "reply" was often the whole page. When the sent message is echoed on the page, the turn is
 * the first run of new lines AFTER the message's last occurrence (a transcript renders the reply
 * below the message it answers); new text elsewhere on the page is not part of the turn, and when
 * nothing new follows the message there is no reply yet. Without an echo, every new line counts
 * (`newPageText`).
 */
export function newTurnText(baseline: string, current: string, sent: string): string {
  const all = newPageText(baseline, current, sent);
  const sentN = norm(sent);
  if (sentN.length === 0 || all === "") return all;
  const lines = current.split("\n").map(norm).filter((l) => l.length > 0);
  const isSent = (l: string): boolean =>
    (sentN.includes(l) && l.length >= Math.min(sentN.length, AUTHORED_FRAGMENT_CHARS)) || (l.includes(sentN) && l.length - sentN.length < 24);
  let anchor = -1;
  lines.forEach((l, i) => {
    if (isSent(l)) anchor = i;
  });
  if (anchor === -1) return all;
  // Which lines are new: the same multiset difference as `newPageText`, in document order.
  const before = new Map<string, number>();
  for (const l of baseline.split("\n").map(norm).filter((l) => l.length > 0)) before.set(l, (before.get(l) ?? 0) + 1);
  const fresh = new Set(all.split("\n"));
  const isNew = lines.map((l) => {
    const n = before.get(l) ?? 0;
    if (n > 0) {
      before.set(l, n - 1);
      return false;
    }
    return true;
  });
  const turn: string[] = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (isNew[i] && fresh.has(l)) turn.push(l);
    // Filtered new text (busy text, the echo) neither belongs to the turn nor ends it.
    else if (isNew[i]) continue;
    else if (turn.length > 0) break;
  }
  return turn.join("\n");
}

/**
 * The assistant's last question in a reply (#122): the last sentence ending in `?`, bounded — what
 * the next user turn must answer. null when the reply asks nothing.
 */
export function lastQuestion(reply: string | null): string | null {
  if (reply === null) return null;
  const sentences = norm(reply).match(/[^.!?\n]*\?/g);
  const q = sentences?.map((s) => s.trim()).filter((s) => s.length >= 3).pop();
  return q === undefined ? null : q.slice(-300);
}

/** Consecutive user turns that make the conversation stuck (#122). */
export const STUCK_TURNS = 3;
/** Word overlap (Jaccard) above which two user turns say the same thing (#122). */
export const STUCK_TURN_OVERLAP = 0.6;

const STOP_WORDS = new Set(
  "a an the and or but to of in on for with at by from as is are was were be been it its this that these those i i'll i'm we we'll you your my our me us let's will can so then just".split(
    " ",
  ),
);
const contentWords = (s: string): Set<string> =>
  new Set((s.toLowerCase().match(/[\p{L}\p{N}$]+(?:['’][\p{L}]+)?/gu) ?? []).filter((w) => !STOP_WORDS.has(w.replace("’", "'"))));

/** Word-set Jaccard overlap of two messages (stop words aside): 1 = the same words. */
export function turnSimilarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 && y.size === 0) return 1;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/** An acknowledgement opener ("That makes sense", "I appreciate…", "Sounds good"). */
const ACKNOWLEDGE =
  /^(?:ok(?:ay)?|sure|great|perfect|thanks?|thank you|got it|understood|sounds good|(?:that )?makes sense|that['’]s helpful|i appreciate|i see|noted|right|alright|absolutely|of course|agreed)\b/i;
/** A deferral: promising to do the work later instead of answering ("I'll pull the data…"). */
const DEFER =
  /\b(?:i['’]?ll|i will|i['’]m going to|i am going to|let me|let['’]s|let us|we['’]ll|we will)\s+(?:\w+\s+){0,2}?(?:start|begin|pull|compil\w*|gather|get|look|check|prioriti[sz]e|focus|work|follow|circle|put|collect|dig|review|find|reach|send|prepare|think)\b/i;
/** Substance: a number, an amount, a date, or an explicit choice. */
const SUBSTANCE = /\d|\$|€|£|\b(?:go with|choose|chose|pick|picked|prefer|option|yes|no)\b/i;

/**
 * A content-free user turn (#122): an acknowledgement or a promise to do something later, with no
 * fact (number, amount, date) and no choice in it — it answers nothing the assistant asked.
 */
export function contentFreeTurn(message: string): boolean {
  const m = norm(message);
  return (ACKNOWLEDGE.test(m) || DEFER.test(m)) && !SUBSTANCE.test(m);
}

/**
 * Stuck detection (independent code, #122): the last `STUCK_TURNS` user turns each either say
 * nothing (`contentFreeTurn`) or repeat an adjacent turn (word overlap above `STUCK_TURN_OVERLAP`).
 */
export function repetitiveTurns(sent: readonly string[], n = STUCK_TURNS): boolean {
  if (sent.length < n) return false;
  const last = sent.slice(-n);
  const similar = (i: number, j: number): boolean =>
    j >= 0 && j < last.length && turnSimilarity(last[i]!, last[j]!) > STUCK_TURN_OVERLAP;
  return last.every((m, i) => contentFreeTurn(m) || similar(i, i - 1) || similar(i, i + 1));
}

/**
 * The page's visible call to action toward the goal (#122), when a stuck conversation should take it
 * instead: an enabled button/link whose name points onward (`→`, `›`, `»`) or shares a content word
 * with the goal — the arrow-marked first. null when there is none.
 */
export function goalCallToAction(controls: readonly Control[], goal: string): Control | null {
  const goalWords = new Set([...contentWords(goal)].filter((w) => w.length >= 3));
  const clickable = controls.filter(
    (c) => c.enabled && (c.role === "button" || c.role === "link" || c.tag === "button" || c.tag === "a") && c.name.length > 0 && c.name.length <= 80,
  );
  const onward = clickable.filter((c) => /[→›»]\s*$/.test(c.name));
  const related = (c: Control): boolean => [...contentWords(c.name)].some((w) => goalWords.has(w));
  return onward.find(related) ?? onward[0] ?? clickable.find((c) => related(c) && !SUBMIT_NAME.test(c.name)) ?? null;
}

/** A page line this long (or the whole message) found inside a sent message is the message echoed. */
const AUTHORED_FRAGMENT_CHARS = 24;

/**
 * The page text minus every line the run itself authored (messages it sent) — so a goal judgment is
 * never grounded on the user's own words echoed back (dogfood J-11: "Next steps…" typed by jevitate
 * read as the app's answer).
 *
 * Only the message itself (or a substantial fragment of it, a wrapped paragraph) is removed: a short
 * app line that merely OCCURS inside a message — a status badge "Approved", "Bet saved", a tab name —
 * is the app's own evidence and stays (#91: the completion evidence was being stripped).
 */
export function withoutAuthored(text: string, sent: readonly string[]): string {
  const mine = sent.map(norm).filter((m) => m.length > 0);
  return text
    .split("\n")
    .filter((l) => {
      const n = norm(l);
      return (
        n.length === 0 ||
        !mine.some(
          (m) =>
            (m.includes(n) && n.length >= Math.min(m.length, AUTHORED_FRAGMENT_CHARS)) ||
            (n.includes(m) && n.length - m.length < 24),
        )
      );
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
  /**
   * Why the wait ended: the reply arrived and held still, the page went idle for the idle patience
   * with no reply, or the hard ceiling passed while the page was still working.
   */
  readonly endedBy?: "reply" | "idle" | "ceiling";
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
 * indicator. Never throws; a missing reply is reported, not guessed.
 *
 * ADAPTIVE (#93) — observe until idle, not a fixed wall clock: the wait continues while the page is
 * visibly working on the reply — a request the send started still in flight, a busy indicator or
 * "pending" status, or the reply text still growing (streaming) — up to the hard `ceilingMs`. It
 * ends early, with no reply, once the page has shown NO such activity for `timeoutMs` (the idle
 * patience). A slow LLM turn (60–100s) is therefore awaited in full, while a page that is doing
 * nothing is not waited on for minutes.
 */
export async function waitForReply(
  page: Page,
  opts: {
    readonly baseline: string;
    readonly sent: string;
    /** Idle patience (ms): give up after this long with no sign of activity. Default `REPLY_WAIT_MS`. */
    readonly timeoutMs?: number;
    /** Hard ceiling (ms), however busy the page stays. Default `REPLY_CEILING_MS` (never below `timeoutMs`). */
    readonly ceilingMs?: number;
    readonly quietMs?: number;
    readonly pollMs?: number;
  },
): Promise<ReplyResult> {
  const idleMs = opts.timeoutMs ?? REPLY_WAIT_MS;
  const ceilingMs = Math.max(idleMs, opts.ceilingMs ?? REPLY_CEILING_MS);
  const quietMs = opts.quietMs ?? REPLY_QUIET_MS;
  const pollMs = opts.pollMs ?? 250;
  const monitor = monitorFor(page);
  const started = Date.now();
  const remaining = (): number => ceilingMs - (Date.now() - started);
  let lastActivity = started;
  /** The new text as last read, and since when it has held still (a streaming reply keeps growing). */
  let latest = "";
  let latestSince = started;
  const result = (received: boolean, endedBy: ReplyResult["endedBy"]): ReplyResult => ({
    received,
    text: latest.slice(0, REPLY_KEEP_CHARS),
    waitedMs: Date.now() - started,
    endedBy,
  });
  for (;;) {
    if (remaining() <= 0) return result(false, "ceiling");
    const text = await readPageText(page);
    const fresh = newTurnText(opts.baseline, text, opts.sent);
    const t = Date.now();
    if (fresh !== latest) {
      latest = fresh;
      latestSince = t;
      lastActivity = t;
    }
    const busy =
      (await page.evaluate(visibleBusyIndicator).catch(() => null)) ??
      (pendingStatusShown(opts.baseline, text) ? "pending status" : null);
    // The send's own work still in flight (the LLM call, a job it started) — not an unrelated
    // long-poll the page had open before the message was sent.
    const inFlight = monitor.pending().some((r) => r.startedAt >= started - SEND_REQUEST_SLACK_MS);
    if (busy !== null || inFlight) lastActivity = Date.now();
    if (isReply(latest) && busy === null) {
      // Streaming replies keep mutating: wait for the page to settle, then confirm it held still.
      await monitor.waitSettled({ quietMs, ceilingMs: Math.max(1, Math.min(remaining(), 15_000)) }).catch(() => undefined);
      const againText = await readPageText(page);
      const again = newTurnText(opts.baseline, againText, opts.sent);
      const stillBusy =
        (await page.evaluate(visibleBusyIndicator).catch(() => null)) ??
        (pendingStatusShown(opts.baseline, againText) ? "pending status" : null);
      if (again === latest && stillBusy === null && Date.now() - latestSince >= quietMs) return result(true, "reply");
      if (again !== latest) {
        latest = again;
        latestSince = Date.now();
        lastActivity = latestSince;
      }
      if (stillBusy !== null) lastActivity = Date.now();
      // Text-only streaming does not hold the settle wait open: pace the re-reads, never spin.
      await page.waitForTimeout(Math.max(1, Math.min(pollMs, remaining()))).catch(() => undefined);
      continue;
    }
    if (Date.now() - lastActivity >= idleMs) return result(false, "idle");
    const nap = Math.min(pollMs, remaining(), idleMs - (Date.now() - lastActivity));
    await page.waitForTimeout(Math.max(1, nap)).catch(() => undefined);
  }
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
  | {
      readonly status: "completed";
      /**
       * What proved it: the mission's success condition, the grounded goal judgment, or (a find-out
       * goal, #101) a reported answer whose every claim code found on an observed page.
       */
      readonly verifiedBy: "success-condition" | "grounded-judgment" | "grounded-answer";
    }
  | { readonly status: "incomplete"; readonly reason: string };

/** A proposed `done`, weighed by code. */
export type DoneVerdict = { readonly accept: true; readonly outcome: RunOutcome } | { readonly accept: false; readonly reason: string };

/**
 * Probability the advisory goal judgment must reach before code accepts an un-oracled `done`
 * (inclusive: p ≥ threshold is accepted). A coin-flip p=0.50 is NOT evidence of completion — the
 * fix for a genuinely completed state judged at 0.50 (#91) is to give the judgment the evidence
 * (a real question, the app's own status text, what the run did), never to lower this bar.
 */
export const GOAL_MET_THRESHOLD = 0.75;

/**
 * The decision's advisory "is the goal already met here?" signal at or above which code runs the
 * grounded goal check BEFORE acting (#91: the loop kept acting after the goal was met). Only a
 * trigger: the grounded check (`groundDone`, same threshold as a proposed `done`) is the verdict.
 */
export const GOAL_CHECK_TRIGGER = 0.5;

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
