/**
 * Pure helpers of the goal loop (`explore()`), moved out of `explore.ts` unchanged (#232).
 * Nothing here is part of `@jevitate/explore`'s public API.
 */
import type { Page } from "playwright";
import type { StopReason, BoundsTracker } from "../bounds.js";
import type { Snapshot, Control } from "../snapshot.js";
import type { Perception } from "../perceive.js";
import { monitorFor } from "../page-monitor.js";
import { visibleBusyIndicator } from "../hang.js";
import { isCredentialField } from "../auth-completion.js";
import { screenState, type ActionIdentity, type LastClick } from "../side-effects.js";
import { sendable } from "../actions.js";
import { isSubmitControl, type ReplyResult } from "../conversation.js";
import { descriptorToLocator } from "@jevitate/recorder";
import { redactPageText } from "../redact.js";
import type { ChromeTracker } from "../feature/relevance.js";
import type { MissionFailure } from "@jevitate/domain";
import { MAX_DOCUMENTED_WAIT_MS, describeStatus, isEmptyStatus, readDocumentedWait, readInProgressStatus } from "../status.js";
import type { RunContext } from "./context.js";
import type { ExploreRun } from "../explore.js";
import { clock } from "@jevitate/domain";

/** The judgment API's refusal of an over-long option list (#192). */
export const TOO_MANY_CHOICES = /too many choices/i;
/** The option budget a refused decision is retried with when the refusal names no limit (#192). */
export const TOO_MANY_CHOICES_RETRY = 120;
/**
 * #242: consecutive `type`s into one (non-message) field that changed nothing but its own value —
 * no request, no other change on the page — before the run stops as stuck.
 */
export const MAX_TYPE_NO_EFFECT = 3;
/** #242: a search-like field (searches on Enter): its type is submitted once retyping fired nothing. */
const SEARCH_LIKE = /\bsearch\b|⌘\s?k|ctrl\s?\+\s?k|\bfind\b|\bfilter\b/i;
export const searchLike = (c: Control): boolean => c.role === "searchbox" || c.inputType === "search" || SEARCH_LIKE.test(c.name);
/** #242: the page's state with one field's own value left out (its typed text is not progress). */
export const stateBesides = (snap: Snapshot, key: string): string =>
  JSON.stringify([snap.url, snap.controls.map((c) => (keyOf(c) === key ? `${c.role} ${c.name}` : c.summary))]);

/**
 * #237: a model `blocked` before the run tried any action is refused (and the model told to explore)
 * this many times; a model that still gives up ends the run `inconclusive` (insufficient-coverage).
 */
export const MAX_EARLY_BLOCKED_REFUSALS = 2;

/** The longest single slice (ms) of one job wait: the model re-perceives the page between slices. */
export const JOB_WAIT_SLICE_MS = 60_000;

/**
 * Waits, with backoff, while the page shows an in-progress status (#92): until it clears (the job
 * finished — then the page is given a moment to settle), the page navigates, or `budgetMs` passes.
 */
export async function waitOutJob(
  page: Page,
  budgetMs: number,
  stillWorking: (page: Page) => Promise<boolean> = async (p) => (await readInProgressStatus(p)) !== null,
): Promise<{ cleared: boolean; waitedMs: number }> {
  // #368: a job wait (`--job-wait-ms`) is the run's chosen patience, never the page's render time.
  return monitorFor(page).explicitWait(() => sitOutJob(page, budgetMs, stillWorking));
}

async function sitOutJob(page: Page, budgetMs: number, stillWorking: (page: Page) => Promise<boolean>): Promise<{ cleared: boolean; waitedMs: number }> {
  const started = clock.now();
  const url = safeUrl(page);
  let delay = 1_000;
  for (;;) {
    const left = budgetMs - (clock.now() - started);
    if (left <= 0) return { cleared: false, waitedMs: clock.now() - started };
    await clock.sleep(Math.max(1, Math.min(delay, left))).catch(() => undefined);
    delay = Math.min(delay * 2, 15_000);
    if (safeUrl(page) !== url || !(await stillWorking(page))) {
      const rest = budgetMs - (clock.now() - started);
      if (rest > 0) await monitorFor(page).waitSettled({ ceilingMs: Math.min(rest, 5_000) }).catch(() => undefined);
      return { cleared: true, waitedMs: clock.now() - started };
    }
  }
}

/**
 * #288/#258 — the page still shows the work a hang was deferred for: an in-progress status, a busy
 * indicator, or copy that documents the wait.
 */
export async function stillShowsWork(page: Page): Promise<boolean> {
  if ((await readInProgressStatus(page)) !== null) return true;
  if ((await page.evaluate(visibleBusyIndicator).catch(() => null)) !== null) return true;
  return (await readDocumentedWait(page)) !== null;
}

/** How long a documented wait (#258) is believed: twice what the page states plus a grace, capped. */
export function documentedWaitBudgetMs(statedMs: number): number {
  return Math.min(MAX_DOCUMENTED_WAIT_MS, statedMs * 2 + 30_000);
}

/**
 * #288 — a busy indicator that outlasted the ceiling while the app VISIBLY kept working: the page
 * shows an in-progress status ("Drafting…") AND, during the wait, the app's requests kept completing
 * (a job-status poll) or the indicator's own progress text changed. A spinner frozen over a silent
 * page shows neither, and stays a hang. Returns a description, or null.
 */
export async function liveBusyWork(page: Page, busyWait: Perception["busyWait"]): Promise<string | null> {
  if (busyWait === undefined || (busyWait.requestsCompleted === 0 && !busyWait.indicatorChanged)) return null;
  const status = await readInProgressStatus(page);
  if (status === null) return null;
  const evidence = [
    ...(busyWait.requestsCompleted > 0 ? [`${busyWait.requestsCompleted} app request(s) completed during the wait`] : []),
    ...(busyWait.indicatorChanged ? ["its progress indicator changed"] : []),
  ];
  return `${status} while the app kept working (${evidence.join(", ")})`;
}

/**
 * #289: the last click fired at least one write the server accepted (a response below 400), none was
 * rejected or is still unanswered, and the page is now on a different route than the click was made
 * on — a save that returned to where it came from (the project hub after "Save changes"), which is
 * progress, never a stalled-state hang.
 */
export function savedAndLeft(
  m: { readonly label: string; readonly clickFromRoute?: string | null },
  routeNow: string,
  lastClick: LastClick | null,
): boolean {
  if (!m.label.startsWith("click ") || (m.clickFromRoute ?? null) === null || m.clickFromRoute === routeNow) return false;
  const writes = lastClick?.writes ?? [];
  return writes.length > 0 && writes.every((w) => w.status !== null && w.status < 400);
}

/**
 * Actions whose own name says "go back" (Back, Cancel, Close, Undo, …): returning to an earlier
 * state is exactly their target state, never a stall.
 */
export const EXPECTED_RETURN = /\b(?:back|cancel|close|dismiss|undo|previous|prev|reset|discard|clear|exit|reload)\b/i;

/** Roles whose click changes an input's value (so a later repeat of a write sends something new). */
export const TOGGLE_ROLES: ReadonlySet<string> = new Set(["checkbox", "radio", "switch", "option", "menuitemcheckbox", "menuitemradio"]);

/** A button whose name reads as a form's submit (#111: a SPA's "Sign up" / "Create account" / "Save"). */
const SUBMIT_LIKE_NAME = /^\s*(?:sign ?up|register|create(?: account)?|continue|log ?in|sign ?in|save|next|submit|confirm|finish)\b/i;

/** A click that submits a form: a real submit control, a Send-like button, or a submit-named button. */
export const submitsAForm = (c: Control): boolean =>
  c.submits === true || isSubmitControl(c) || ((c.role === "button" || c.tag === "button") && SUBMIT_LIKE_NAME.test(c.name));

/** A click that may submit what was typed (#123: typed values count as used after it). */
/**
 * #225: the page's form fields and their current values, for the goal judgment — a field's value is
 * never in the page's `innerText`, yet it is where a form displays what was saved. Only a non-secret
 * value (`Control.value` is never read from a password / one-time-code field) and never a bound secret
 * field or a message composer (the run's own words, #200).
 */
export function fieldValuesOf(controls: readonly Control[], isBound: (c: Control) => boolean): Array<{ label: string; value: string }> {
  return controls
    .filter((c) => typeof c.value === "string" && c.value.trim() !== "" && !isBound(c) && !isCredentialField(c) && !sendable(c))
    .map((c) => ({ label: c.name || c.summary, value: c.value as string }));
}

export const buttonLike = (c: Control): boolean =>
  c.role === "button" || c.tag === "button" || (c.tag === "input" && (c.inputType === "submit" || c.inputType === "button"));

/** A control's identity across snapshots (indexes are per-snapshot only). */
export const keyOf = (c: Control): string => JSON.stringify(c.descriptor);

/**
 * #356: the repeat guard's identity of a click — the element (its descriptor, `keyOf`) and its
 * context on the route: its form / form-like container / named dialog and the screen heading above
 * it. Two same-labelled controls on two screens of one route are two actions; the label alone never
 * identifies one unless the page offers nothing else.
 */
export const actionIdentityOf = (c: Control): ActionIdentity => ({
  element: keyOf(c),
  context: JSON.stringify([c.form ?? null, c.container ?? null, c.scope ?? null, c.heading ?? null]),
});

/**
 * BROWSER CODE — #380: the clicked control's own region — its nearest dialog / form / region / group /
 * tabpanel / section / article / list item / table row / card-like container, else the nearest
 * landmark (`main`), never the whole document — as its visible text and the controls it offers
 * (role, name, enabled; never a value), and where it sits (#391: its element path, tag + sibling
 * index up to the document — which region it is, never what it shows). Null when the control sits in none.
 */
function regionOf(el: Element): { text: string; controls: Array<{ role: string; name: string; enabled: boolean }>; where: string } | null {
  const REGION =
    'dialog,[role=dialog],[role=alertdialog],form,[role=form],[role=region],[role=group],[role=tabpanel],section,article,li,tr,[role=row],[role=listitem],[class*="card" i],[data-card]';
  const LANDMARK = "main,[role=main]";
  const region = el.parentElement?.closest(REGION) ?? el.closest(LANDMARK);
  if (region === null || region === undefined || region === document.body || region === document.documentElement) return null;
  const CONTROL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option]';
  const controls = [...region.querySelectorAll(CONTROL)]
    .filter((c) => (c as HTMLElement).offsetParent !== null || c.getClientRects().length > 0)
    .map((c) => {
      const h = c as HTMLInputElement;
      const name = (c.getAttribute("aria-label") ?? (h.type === "submit" || h.type === "button" ? h.value : "") ?? "") || ((c as HTMLElement).innerText ?? c.textContent ?? "");
      return { role: c.getAttribute("role") ?? c.tagName.toLowerCase(), name: name.replace(/\s+/g, " ").trim(), enabled: !h.disabled && c.getAttribute("aria-disabled") !== "true" };
    });
  const steps: string[] = [];
  for (let n: Element | null = region; n !== null; n = n.parentElement) {
    steps.push(`${n.tagName.toLowerCase()}:${n.parentElement === null ? 0 : [...n.parentElement.children].indexOf(n)}`);
  }
  return { text: (region as HTMLElement).innerText ?? region.textContent ?? "", controls, where: steps.reverse().join(">") };
}

/**
 * #380: the state the repeat guard compares (`screenState`) — the clicked control's REGION (see
 * `regionOf`), never the whole page, so a menu or a toast elsewhere is no change — and (#391) which
 * region that is (`where`), so a control used beside an earlier write's control is known. Its text is
 * redacted of every registered secret and only the digest is kept. Undefined when the control is
 * gone or sits in no region (the guard then never re-allows on state).
 */
export async function readRegion(
  page: Page,
  control: Pick<Control, "descriptor">,
  secrets: readonly string[],
): Promise<{ readonly state: string; readonly where: string } | undefined> {
  const region = await descriptorToLocator(page, control.descriptor)
    .first()
    .evaluate(regionOf, undefined, { timeout: 1_000 })
    .catch(() => null);
  return region === null ? undefined : { state: screenState(region.controls, redactPageText(region.text, secrets)), where: region.where };
}

/** #380: the clicked control's region state alone (`readRegion`). */
export async function readRegionState(page: Page, control: Pick<Control, "descriptor">, secrets: readonly string[]): Promise<string | undefined> {
  return (await readRegion(page, control, secrets))?.state;
}

/** History text for a reply wait that ended without a reply — and why it stopped waiting (#93). */
export function noReply(r: ReplyResult): string {
  const s = Math.round(r.waitedMs / 1000);
  if (r.endedBy === "ceiling") return `no reply within ${s}s (the page was still working when the wait's ceiling passed)`;
  if (r.endedBy === "idle") return `no reply within ${s}s (the page showed no sign of working on one)`;
  return `no reply within ${s}s`;
}

/** A short quote for history lines. */
export function quote(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return `"${flat.length > n ? `${flat.slice(0, n)}…` : flat}"`;
}

/**
 * #223: a control whose name is an action or a label, not page content: every non-link control
 * (buttons, submit/reset inputs, form fields — named by their labels) and a chrome link (in a
 * nav / header / footer landmark, or repeated across pages). A link in the page's content — a list,
 * a table, a card — is content: its text may be the answer ("the title of the first item").
 */
export function isActionOrChromeName(c: Control, chrome: ChromeTracker): boolean {
  if (c.role !== "link") return true;
  return (c.landmark ?? null) !== null || chrome.isChrome(c);
}

export function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

/**
 * Unwinds out of the loop after the FIRST navigation failed unreachable (#128) — `stop`/`failure`
 * are already set at the point it's thrown; the outer catch recognises it and does nothing more
 * (never reclassifies it as a generic `crashed` engine failure).
 */
export class FirstNavigationFailedSentinel extends Error {}

/** Why a run that did not complete ended — always a stated reason, never a silent stop. */
export function incompleteReason(
  stop: StopReason,
  specific: string | null,
  failure: MissionFailure | undefined,
  hang: ExploreRun["hang"],
  tracker: BoundsTracker,
): string {
  if (specific !== null && stop !== "crashed") return specific;
  switch (stop) {
    case "exhausted":
      return `budget exhausted (${tracker.decisions} decisions, ${tracker.actions} actions) before the goal was met`;
    case "no-progress":
      return "no progress: the last actions left the page unchanged";
    case "blocked":
      return "blocked before the goal was met";
    case "hang":
      return hang === undefined ? "the app hung" : `the app hung (${hang.signal.kind}): ${hang.signal.detail}`;
    case "inconclusive":
    case "crashed":
      return failure === undefined ? `run ${stop}` : `run ${stop}: ${failure.message}`;
    case "done":
      return "done was proposed but could not be verified";
    case "budget":
      return "a declared mission spend budget was crossed";
    default: {
      const exhaustive: never = stop;
      return String(exhaustive);
    }
  }
}

/**
 * The run's reason with the concrete cause it ran into (#84): a blocked / stuck / exhausted run names
 * what stopped it (a fail-closed field, a disabled target, an invalid field, an alert). A crash,
 * hang or inconclusive run keeps its own evidence; a reason already naming the cause is kept as is.
 */
export function withCause(reason: string, stop: StopReason, cause: string | null): string {
  if (cause === null || reason.includes(cause)) return reason;
  if (stop !== "blocked" && stop !== "no-progress" && stop !== "exhausted") return reason;
  if (reason === "blocked before the goal was met") return `blocked: ${cause}`;
  return `${reason} — last blocker: ${cause}`;
}

/** The path part of a URL (navigation detection); the raw string when it does not parse. */
export function safePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** `page.url()` survives a closed page, but guard it: winding down must never throw. */
export function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
}

/** #446: the form's message as the prompt's page status shows it, or null. */
export function formMessageStatus(ctx: Pick<RunContext, "formMessage">): string | null {
  const m = ctx.formMessage;
  return m === null ? null : `${m.lines.map((l) => `form message "${l}"`).join("; ")} (after ${m.after})`;
}

/** The prompt's page status: the status text (#79) and the form's message (#446); absent when neither. */
export function pageStatusOf(ctx: Pick<RunContext, "formMessage" | "status">): { pageStatus?: string } {
  const parts = [...(isEmptyStatus(ctx.status) ? [] : [describeStatus(ctx.status)]), ...[formMessageStatus(ctx)].filter((x): x is string => x !== null)];
  return parts.length === 0 ? {} : { pageStatus: parts.join("; ") };
}
