/**
 * `blocked` (#92, #237, #283): the model gives up — deferred into a bounded job wait while the app is
 * still working, refused while nothing was tried yet, else the run stops. The goal loop's blocked
 * handler, moved out of `explore.ts` unchanged (#232).
 */
import type { Page } from "playwright";
import { monitorFor } from "../page-monitor.js";
import { controlRisk } from "../safety.js";
import { snapshot } from "../snapshot.js";
import { awaitWrites } from "../side-effects.js";
import { readInProgressStatus } from "../status.js";
import type { RunContext } from "./context.js";
import type { ActionableControlEvidence, ActionableControlKind, ActionableControlOutcome, ActionableControlResume } from "./context/types.js";
import { JOB_WAIT_SLICE_MS, MAX_EARLY_BLOCKED_REFUSALS, quote, waitOutJob } from "./helpers.js";
import { deferEnding } from "./min-effort.js";
import type { Flow, Step } from "./step.js";

/**
 * #688 — the one bounded recovery turn's bookkeeping, keyed by the run context (never a new
 * `RunContext` field). `safe` is the observation-only evidence gathered when the turn was granted,
 * `given` bounds the run to exactly one, and `pending` marks the turn not yet decided.
 */
interface RecoveryTurn {
  readonly safe: readonly ActionableControlEvidence[];
  readonly given: boolean;
  pending: boolean;
}
const RECOVERY_TURNS = new WeakMap<RunContext, RecoveryTurn>();

/**
 * #688 — the safe-control evidence for the decision now being made, or null when this is not the
 * recovery turn. The turn is consumed on first call, so a run gets at most one recovery decision.
 */
export function takeRecoveryTurn(ctx: RunContext): readonly ActionableControlEvidence[] | null {
  const turn = RECOVERY_TURNS.get(ctx);
  if (turn === undefined || !turn.pending) return null;
  turn.pending = false;
  return turn.safe;
}

/** #688 — the durable, JSON-encoded resume identity the blocked outcome carries for a manager. */
function resumeIdentity(e: ActionableControlEvidence): string {
  return JSON.stringify(e.resume);
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
  // #424: below the minimum exploration effort, giving up is deferred — the model is steered to breadth.
  const deferred = deferEnding(ctx, step, "blocked");
  if (deferred !== null) {
    record(false, deferred, { origin: "engine" });
    return "continue";
  }
  // #688 — before the model's blocked stands, look once for a safe control to recover through. The
  // evidence is observation-only: nothing here selects, clicks or executes a candidate. One visible
  // enabled safe control earns the model exactly one more decision, restricted to those controls;
  // otherwise — or once that single turn was spent — the blocked ending carries a durable
  // actionable-control outcome with the exact resume identity a manager resumes from.
  const evidence = await collectActionableControlEvidence(ctx.page, { screenshots: false }).catch(() => [] as ActionableControlEvidence[]);
  const safe = evidence.filter((e) => e.kind === "safe" && e.name !== "");
  const turn = RECOVERY_TURNS.get(ctx);
  if ((turn === undefined || !turn.given) && safe.length > 0) {
    RECOVERY_TURNS.set(ctx, { safe, given: true, pending: true });
    const note = `blocked: one recovery turn is available through the safe control(s) ${safe
      .map((e) => `${quote(e.name, 40)} (${e.locator})`)
      .join(", ")} — act through one of them or the run ends blocked`;
    ctx.history.push(note);
    record(false, note, { origin: "engine" });
    return "continue";
  }
  record(true, "model blocked");
  // #688 — the candidate the terminal outcome names: the safe control whose recovery turn was spent,
  // or the best real excluded control a manager could still act on (never merely hidden/unusable).
  const turnSafe = turn !== undefined && turn.given && turn.safe.length > 0 ? turn.safe : null;
  const excluded = evidence.filter((e) => e.kind !== "safe");
  const classes = [...new Set(excluded.map((e) => e.kind))].join(", ");
  const best = turnSafe !== null ? turnSafe[0] : (excluded.find((e) => e.kind !== "hidden" && e.kind !== "disabled") ?? evidence[0]);
  if (best !== undefined) {
    // The decision's evidence skipped screenshots; capture the named candidate's own at the stop.
    const captured = (await collectActionableControlEvidence(ctx.page).catch(() => evidence)).find((e) => e.locator === best.locator);
    ctx.actionableControl = actionableControlOutcome(captured ?? best);
  }
  // #235: a control the goal needed may have been refused — the reason says so, actionably.
  const refusal = ctx.lastRefusal === null ? "" : ` (${ctx.lastRefusal})`;
  const base = `the model reported the goal cannot be advanced from this page${refusal}`;
  const recovery =
    turnSafe !== null
      ? `the one recovery turn through the safe control ${turnSafe.map(resumeIdentity).join(", ")} did not advance the goal`
      : `no visible enabled safe control is available to recover through${
          classes === "" ? "" : ` (excluded control classes: ${classes})`
        }${best === undefined ? "" : `; resume identity ${resumeIdentity(best)}`}`;
  // #84's blocker keeps its place immediately after the base phrase (#211: the run names what
  // stopped it) so the durable recovery identity extends the reason instead of displacing it.
  const cause = ctx.blockingCause();
  ctx.incomplete = cause === null || base.includes(cause) ? `${base}; ${recovery}` : `${base} — last blocker: ${cause}; ${recovery}`;
  ctx.stop = "blocked";
  return "stop";
}

/**
 * #688 — actionable-control recovery evidence. When the run is blocked but the page still offers
 * untried controls, the recovery needs typed, observation-only evidence about each candidate: how to
 * find it (`locator`), what it looked like (`screenshot`), the condition under which acting is safe
 * (`predicate`), and exactly where to resume (`resume`). Nothing here selects, clicks or otherwise
 * executes a candidate — building the evidence reads the page and captures an image only.
 */

/** The interactive elements recovery evidence reads. Observation only; never a click target here. */
const RECOVERY_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[contenteditable=true]",
].join(", ");

/** A control asking for approval / authorization rather than performing the goal's own action. */
const APPROVAL = /\b(?:approve|approval|authorize|authorise|accept|grant|sign[ -]?off|confirm)\b/i;

/** The full condition a candidate must satisfy for a run to act through it safely (#688). */
const SAFE_PREDICATE = "visible && enabled && !ambiguous && !destructive && !financial && !approval";

/** One interactive element as the browser reads it — the raw input to the evidence contract. */
interface RecoveryCandidate {
  readonly name: string;
  readonly role: string;
  readonly testId: string | null;
  readonly id: string | null;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

/** BROWSER CODE — serialized by `locator.evaluateAll`: no imports, no closure over module scope. */
function readRecoveryCandidates(els: Element[]): RecoveryCandidate[] {
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria !== null && aria.trim() !== "") return aria.replace(/\s+/g, " ").trim();
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled !== null) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (text.trim() !== "") return text.replace(/\s+/g, " ").trim();
    }
    const title = el.getAttribute("title");
    if (title !== null && title.trim() !== "") return title.replace(/\s+/g, " ").trim();
    if (el instanceof HTMLInputElement && el.type !== "password" && el.value !== "") return el.value.replace(/\s+/g, " ").trim();
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  return els.map((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible =
      style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
    return {
      name: nameOf(el),
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") ?? el.getAttribute("data-test"),
      id: el.id === "" ? null : el.id,
      visible,
      enabled: !disabled,
      box: visible ? { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height } : null,
    };
  });
}

/**
 * The class of one candidate control: `hidden`, `disabled` and `ambiguous` are observed facts;
 * `destructive` / `financial` come from the shared safety vocabulary; `approval` is a confirmation
 * verb; everything visible, enabled, uniquely named and safe is `safe`.
 */
export function classifyActionableControl(input: {
  readonly name: string;
  readonly role?: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly duplicateName: boolean;
}): ActionableControlKind {
  if (!input.visible) return "hidden";
  if (!input.enabled) return "disabled";
  if (input.duplicateName) return "ambiguous";
  const risk = controlRisk(input.name, input.role);
  if (risk !== null && (risk.risk === "destructive" || risk.risk === "session-end")) return "destructive";
  if (risk !== null && risk.risk === "paid") return "financial";
  if (APPROVAL.test(input.name)) return "approval";
  return "safe";
}

/** The condition that must hold for the candidate to be actable, keyed by the class it fell into. */
function recoveryPredicate(kind: ActionableControlKind): string {
  switch (kind) {
    case "safe":
      return SAFE_PREDICATE;
    case "hidden":
      return "visible";
    case "disabled":
      return "enabled";
    case "ambiguous":
      return "uniquely named";
    case "destructive":
      return "!destructive";
    case "financial":
      return "!financial";
    case "approval":
      return "!approval";
  }
}

/** A durable locator for a candidate: its test id, its id, else its role and accessible name. */
function recoveryLocator(c: RecoveryCandidate): string {
  if (c.testId !== null && c.testId !== "") return `[data-testid="${c.testId}"]`;
  if (c.id !== null && c.id !== "") return `#${c.id}`;
  const role = c.role === "" ? "*" : c.role;
  return `${role}[name="${c.name.replace(/"/g, '\\"')}"]`;
}

/** #688 — the clauses of `SAFE_PREDICATE`, in the exact order it spells them. */
const SAFE_CLAUSES = ["visible", "enabled", "!ambiguous", "!destructive", "!financial", "!approval"] as const;

/** The safe-predicate clause a candidate of this class fails, or null when every clause holds. */
function failingClause(kind: ActionableControlKind): string | null {
  switch (kind) {
    case "safe":
      return null;
    case "hidden":
      return "visible";
    case "disabled":
      return "enabled";
    case "ambiguous":
      return "!ambiguous";
    case "destructive":
      return "!destructive";
    case "financial":
      return "!financial";
    case "approval":
      return "!approval";
  }
}

/**
 * #688 — the distinct, machine-readable terminal outcome for one candidate control: the candidate a
 * manager could resume through (locator, label, visible/enabled facts, screenshot, exact identity),
 * and the safe-predicate clauses it satisfied and did not. Observation only.
 */
export function actionableControlOutcome(e: ActionableControlEvidence): ActionableControlOutcome {
  const missing = failingClause(e.kind);
  return {
    kind: "author_stopped_with_actionable_control",
    candidate: {
      locator: e.locator,
      label: e.name,
      visible: e.kind !== "hidden",
      enabled: e.kind !== "disabled",
      screenshot: e.screenshot,
      resume: e.resume,
    },
    satisfiedPredicates: SAFE_CLAUSES.filter((c) => c !== missing),
    unsatisfiedPredicates: missing === null ? [] : [missing],
  };
}

/**
 * #688 — is `observed` still exactly the resume identity a caller is about to act from? All three
 * parts (page URL, page-state signature, control locator) must match, so stale evidence — gathered
 * on another state, or against another control — is never mistaken for the current page.
 */
export function resumeMatches(observed: ActionableControlResume, current: ActionableControlResume): boolean {
  return observed.url === current.url && observed.state === current.state && observed.locator === current.locator;
}

/**
 * #688 — the resume identity `page` presents now for `locator`: its current URL and the same page
 * state signature `collectActionableControlEvidence` uses. Comparing it with `resumeMatches` tells
 * a manager whether the evidence is still current.
 */
export async function currentResumeIdentity(page: Page, locator: string): Promise<ActionableControlResume> {
  const url = page.url();
  const state = await snapshot(page).then(
    (s) => s.signature,
    () => url,
  );
  return { url, state, locator };
}

/** A PNG data URL for the candidate's own box (the viewport when it has none); never a click. */
async function recoveryScreenshot(page: Page, c: RecoveryCandidate): Promise<string | null> {
  try {
    const buf = c.box === null ? await page.screenshot({ animations: "disabled" }) : await page.screenshot({ clip: c.box, animations: "disabled" });
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * #688 — read every interactive control on `page` (visible or not) and build its recovery evidence.
 * Observation only: the page is read and captured, never selected, clicked or executed. Ambiguity is
 * a name shared by more than one visible, enabled control; hidden controls are still reported (with
 * `kind: "hidden"`) so a recovery can tell "not present" from "present but unusable".
 */
export async function collectActionableControlEvidence(
  page: Page,
  opts: { readonly screenshots?: boolean } = {},
): Promise<ActionableControlEvidence[]> {
  const candidates = await page
    .locator(RECOVERY_SELECTOR)
    .evaluateAll(readRecoveryCandidates)
    .catch(() => [] as RecoveryCandidate[]);
  const url = page.url();
  // #688: the page state's stable freshness signature is the same identity the loop uses, so a
  // recovery resumes only against the state the evidence was gathered on.
  const state = await snapshot(page).then(
    (s) => s.signature,
    () => url,
  );
  const visibleNames = new Map<string, number>();
  for (const c of candidates) {
    if (c.visible && c.enabled && c.name !== "") visibleNames.set(c.name, (visibleNames.get(c.name) ?? 0) + 1);
  }
  const out: ActionableControlEvidence[] = [];
  for (const c of candidates) {
    const kind = classifyActionableControl({
      name: c.name,
      role: c.role,
      visible: c.visible,
      enabled: c.enabled,
      duplicateName: c.name !== "" && (visibleNames.get(c.name) ?? 0) > 1,
    });
    const locator = recoveryLocator(c);
    out.push({
      kind,
      name: c.name,
      locator,
      screenshot: opts.screenshots === false ? null : await recoveryScreenshot(page, c),
      predicate: recoveryPredicate(kind),
      resume: { url, state, locator },
    });
  }
  return out;
}
