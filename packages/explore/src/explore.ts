import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Navigate } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import type { Page } from "playwright";
import { writeClassifier, type Recording, type ValueOrVar } from "@jevitate/recording";
import {
  BoundsTracker,
  NoProgressDetector,
  resolveBounds,
  type Bounds,
  type StopReason,
} from "./bounds.js";
import {
  assertAuthorizedExploreTarget,
  isAuthorizedExploreTarget,
} from "./authorized-targets.js";
import type { Snapshot } from "./snapshot.js";
import { perceive } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { summarizeTimings, type PageTiming, type TimingSummary } from "./timing.js";
import { hangRoute, probeResponsive, type HangSignal } from "./hang.js";
import { hostProbe, type HostProbe } from "./host-pressure.js";
import type { HostHealthSampler, HostJudgment } from "./host-health.js";
import { HANG_PROBE_MS } from "./perceive.js";
import { textMatcher, type HangConfig, type SettleConfig, type TimingConfig } from "./settle-config.js";
import { DEFAULT_STALL_MS } from "./hang-repro.js";
import { decide, judgeGoalCompletion, type Decision } from "./decide.js";
import { AuthProgress, isCredentialField } from "./auth-completion.js";
import { SaveProgress } from "./save-completion.js";
import { FieldValueLog, FillHelper, capMessage, chatReply, goalListsSeveral, matchOption } from "./fill.js";
import {
  type SecretField,
  boundSecretField,
  maskSecretFields,
  secretFieldContext,
  secretFieldNeedsValue,
  secretFieldSecrets,
  secretFieldValue,
  secretFieldsToFill,
  secretPlaceholder,
} from "./secret-fields.js";
import { act, parseInterceptor } from "./act.js";
import { SideEffectGuard, SideEffectLog, awaitWrites, type SideEffect } from "./side-effects.js";
import { sendable } from "./actions.js";
import type { Control } from "./snapshot.js";
import { coveredByInterceptors } from "./occlusion.js";
import { descriptorToLocator } from "@jevitate/recorder";
import {
  NO_ANSWER_REASON,
  ObservedPages,
  answerNotFoundReason,
  goalAsksToWrite,
  UNSAVED_WRITE_REASON,
  controlFields,
  goalAsksForReply,
  reportAnswer,
  VetoedAnswers,
  type AnswerVerdict,
  type RunAnswer,
} from "./answer.js";
import {
  REPLY_CEILING_MS,
  GOAL_CHECK_TRIGGER,
  GOAL_MET_THRESHOLD,
  REPLY_WAIT_MS,
  STUCK_TURNS,
  UnsubmittedTypeTracker,
  goalCallToAction,
  groundDone,
  isSubmitControl,
  lastQuestion,
  newPageText,
  readPageHeadings,
  readPageText,
  repetitiveTurns,
  sameMessage,
  stillBusy,
  waitForChange,
  waitForReply,
  withoutAuthored,
  type ReplyResult,
  type RunOutcome,
} from "./conversation.js";
import { RunRecorder, emptyRecording } from "./record.js";
import { planTextEdit, readEditableText } from "./rich-text.js";
import { describeTextEdit } from "@jevitate/interpreter";
import { resolveMissionFixture } from "./fixture.js";
import { ChromeTracker } from "./feature/relevance.js";
import { redactText, redactUrl } from "./redact.js";
import { demoOverlayFor } from "./demo-overlay.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptListener } from "./transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { CrashWatch, assertTargetAnswering, describeFailure, describeUnreachable, isTargetUnresponsive, isUnreachableTarget, targetStoppedAnswering, assertSeedReachable } from "./mission-failure.js";
import {
  EMPTY_STATUS,
  describeStatus,
  isEmptyStatus,
  readInProgressStatus,
  readPageStatus,
  readWorkingStatus,
  statusDelta,
  type PageStatus,
} from "./status.js";
import { SafetyPolicy, type SafetyConfig } from "./safety.js";
import { READ_ONLY_NOTE, ReadOnlyGuard } from "./read-only.js";
import { FirstPartyOrigins } from "./third-party.js";
import { HeapLog, buildCrashReport, sampleHeap, type CrashReport } from "./crash-report.js";
import type { HeapSample } from "@jevitate/domain";


/** The judgment API's refusal of an over-long option list (#192). */
const TOO_MANY_CHOICES = /too many choices/i;
/** The option budget a refused decision is retried with when the refusal names no limit (#192). */
const TOO_MANY_CHOICES_RETRY = 120;
export type { TranscriptEntry } from "./transcript.js";
export type { RunOutcome } from "./conversation.js";

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



/**
 * explore: the bounded perceive → decide → act → record loop.
 *
 * Guardrails wired here, end to end:
 *  - #1 authorized-target-only: the start URL is asserted before anything runs;
 *    any mid-run off-origin URL stops the run (blocked), never acts.
 *  - #2 bounded + fail-closed: BoundsTracker caps decisions & actions; a
 *    NoProgressDetector stops a stuck run; `done`/`blocked`/exhausted/no-progress
 *    are the only terminations — the loop never guesses an irreversible action.
 *  - #3 no secrets to models: decide()/fill() redact before every model call.
 *  - #5 prompt-injection guard: present in every decide() prompt.
 *
 * The durable product is the emitted `Recording` (index-free, replayable). The
 * caller (a mission) adjudicates success with an INDEPENDENT oracle — the loop
 * never certifies its own success (#4).
 */

export interface ExploreConfig {
  readonly actor: Actor;
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly goal: string;
  /** Authorized origins; the start URL and every observed URL must be on it. */
  readonly allowlist: readonly string[];
  readonly startUrl: string;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /**
   * Secret field bindings (#72): a `type` on a matching control is typed by code with the bound
   * value (or TOTP code); the model sees only a placeholder, the Recording `{ redacted: true }`.
   */
  readonly secretFields?: readonly SecretField[];
  readonly missionContext?: string;
  /** Recording.site label. Defaults to the start origin. */
  readonly site?: string;
  /**
   * Additive, optional observation hook: fired with each authorized observed
   * `Snapshot` after the origin guard passes. Used by the usability mission to
   * run UX analysis per screen. Advisory only — it MUST NOT change the loop's
   * control flow, bounds, or stop decision (its return is awaited but ignored).
   */
  readonly onSnapshot?: (snap: Snapshot) => void | Promise<void>;
  /**
   * Optional mission fixture file for the `upload` op (never model-chosen).
   * Validated to exist at loop start (fail fast: `fixture not found: <path>`);
   * only when present is `upload` offered to the model.
   */
  readonly fixture?: string;
  /**
   * Bound (ms) on waiting for a rendered page (≥1 interactive control) before each decision.
   * Default `RENDER_WAIT_MS` (see `perceive`).
   */
  readonly renderWaitMs?: number;
  /** Bound on the main-thread probe (ms). Default `HANG_PROBE_MS`. */
  readonly hangProbeMs?: number;
  /** A request pending longer than this (ms) is a hang. Default: half the render ceiling. */
  readonly requestBoundMs?: number;
  /**
   * How long a page must stay stuck in an earlier state after an action before it counts as a
   * `ui-no-progress` hang (ms). Default `DEFAULT_STALL_MS`.
   */
  readonly stallMs?: number;
  /** The target's settle configuration (background requests, long-poll threshold). */
  readonly settle?: SettleConfig;
  /** The target's hang configuration (`ui-no-progress` ignores). */
  readonly hangs?: HangConfig;
  /** Samples the HOST's resource pressure for hang/crash evidence. Default: this platform's signals. */
  readonly hostProbe?: HostProbe;
  /**
   * The run's host-health sampler (#203). When given, a hang or no-progress stop met while the host
   * was starved is marked `environment-degraded` on it (advisory, never a hang finding) and the run
   * ends `inconclusive` (`degraded-environment`) instead of `hang`/`no-progress`. Its fresh sample is
   * the hang's `host` evidence. Without one, hangs are judged as before.
   */
  readonly hostHealth?: HostHealthSampler;
  /** The target's timing configuration (API path prefixes). */
  readonly timingConfig?: TimingConfig;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
  /** Incremental-flush seam: the partial Recording after every recorded step. */
  readonly onRecording?: (recording: Recording) => void;
  /**
   * The mission's INDEPENDENT success condition (e.g. the goal mission's assertion), evaluated when
   * the model proposes `done`: `done` is accepted only when it holds. Without one, a `done` needs an
   * advisory goal judgment grounded on the visible page (see `groundDone`).
   */
  readonly successCheck?: () => Promise<boolean>;
  /**
   * #209: what the in-run `successCheck` could NOT judge yet — e.g. a `reloadThen` check left to the
   * final verdict, or a check that has held since before any action (vacuous so far). When it returns
   * a string, an accepted `done` is recorded as PROVISIONAL (naming what is still pending), never as
   * "goal verified": the mission's final, independent verdict decides.
   */
  readonly successCheckPending?: () => string | null;
  /**
   * #235: every success check is judged only AFTER the run (a `reloadThen`): the in-run `successCheck`
   * evaluates nothing, so it holds vacuously. It still grounds the model's own `done` (provisionally,
   * see `successCheckPending`), but never turns a `blocked`, a sign-in or the decision's "already met"
   * signal into "goal already met" — the run did not show anything held.
   */
  readonly successCheckDeferred?: boolean;
  /**
   * #286: the goal asks the run to report what it found (`goalAsksForReport`) while `--success` checks
   * judge the rest: a `done` is no ending — the run ends with a grounded `report` — and neither a
   * `blocked` nor the "already met" signal is turned into "goal already met" (that has no answer).
   */
  readonly requireAnswer?: boolean;
  /**
   * #225: a `done` rejected by `successCheck` ends the run at once when the job is nonetheless judged
   * done on the page (the advisory goal judgment / code-observed save grounding, as without a check) —
   * the failed check is then the result, not a reason to spend the rest of the budget. The outcome
   * stays incomplete (`doneRejected`); only the independent check decides. Default off (goal runs keep
   * working toward a check that may still come to hold).
   */
  readonly stopWhenJudgedDone?: boolean;
  /**
   * Idle patience (ms) of a conversational reply wait: how long to keep waiting while the page shows
   * no sign of working on the reply. Default 60s. While it IS working (request in flight, busy
   * indicator, reply still growing) the wait continues up to `replyCeilingMs` (#93).
   */
  readonly replyWaitMs?: number;
  /** Hard ceiling (ms) on one reply wait. Default `REPLY_CEILING_MS` (180s); never below `replyWaitMs`. */
  readonly replyCeilingMs?: number;
  /** Cap (chars) on each generated chat message. Default `REPLY_MAX_CHARS`. */
  readonly replyMaxChars?: number;
  /** Bound (ms) a `wait` decision waits for the page to change. Default `WAIT_OP_MS`. */
  readonly waitOpMs?: number;
  /**
   * Job-wait budget (ms, #92): how long `wait`s keep waiting, with backoff, while the page shows an
   * in-progress status ("Simulating…", `aria-busy`, a job "is running") — and how long a model
   * `blocked` is deferred into such a wait. Default `replyCeilingMs`.
   */
  readonly jobWaitMs?: number;
  /** The shared safety policy (#116) and write classifier (#110) configuration. */
  readonly safety?: SafetyConfig;
  /**
   * A READ-ONLY run (#158: a find-out goal that does not ask for a change): code refuses clicks on
   * controls that start a write flow / submit a form, `send` and `upload`, and aborts the write
   * requests (#110's classifier) a model-chosen action fires (act → settle); the app's own background
   * writes (token refresh, heartbeat) pass and are listed `background`. Every refusal is recorded (origin
   * `engine`) and told to the model. Set by the goal mission; never a model decision.
   */
  readonly readOnly?: boolean;
  /**
   * #202: called as an action (a control op, or a chosen `reload`) is about to be dispatched — at the
   * same point, on the same wall clock (`Date.now`), as the request→step attribution mark
   * (`SideEffectLog.mark`). Requests captured with `startedAt >= at` were sent after it. Observation
   * only: it never gates the loop.
   */
  readonly onAction?: (info: Readonly<{ step: number; at: number }>) => void;
  /**
   * Mission spend budget (#150) PRE-ACTION hook: called with the resolved control right before it
   * would be acted on (after the safety-policy risk classification, for every op). A refusal stops
   * the run with `stop: "budget"` before the action fires — code decides, the model never sees it as
   * an obstacle to route around. Wired by a mission wrapper from its own `invariants.budget`;
   * `explore()` itself never reads a budget spec.
   */
  readonly onBeforeAction?: (
    info: Readonly<{ op: string; control: string; paid: boolean }>,
  ) => Promise<{ readonly refuse: true; readonly reason: string } | { readonly refuse: false }>;
  /**
   * Mission spend budget (#150) POST-SETTLE hook: called after each settled, authorized snapshot
   * (alongside `onSnapshot`, but — unlike it — its result DOES gate the loop): `stop: true` ends the
   * run cleanly with `stop: "budget"`, before the next decision.
   */
  readonly onSettled?: (snap: Snapshot) => Promise<{ readonly stop: true; readonly reason: string } | { readonly stop: false }>;
  /**
   * #174: independent code's "the success condition is already met" (e.g. `--success-when held`
   * checks that held), asked after each settled snapshot. A non-null note ends the run `done`,
   * verified by the success condition, BEFORE the next decision — the run never keeps acting
   * (or writing) past a met goal. Its result is code's verdict, never the model's.
   */
  readonly successMetNow?: () => Promise<string | null>;
  /**
   * #245: show the on-page demo overlay (step, strategy, what is about to happen and why, a brief
   * highlight of the target, a final outcome banner) — for a watched (headed) demo. Invisible to
   * jevitate itself (see `demo-overlay.ts`); absent/false injects nothing. Never changes the run.
   */
  readonly demoOverlay?: boolean;
}

export interface ExploreRun {
  readonly stop: StopReason;
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  /** Why the run ended `crashed`/`inconclusive` — absent on every other stop. */
  readonly failure?: MissionFailure;
  /** The page's JS heap per step (resource evidence for crash attribution). */
  readonly heap: HeapSample[];
  /** For a `crashed` run: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Per-run timing summary: slowest pages/transitions and endpoints (p50/max), keyed by route. */
  readonly timing: TimingSummary;
  /** For a `hang` stop: what hung, and the Recording step to replay up to (to reproduce it). */
  readonly hang?: { readonly signal: HangSignal; readonly recordingStepIndex: number };
  /**
   * Did the run complete its goal? `completed` only when the goal's success condition was observably
   * met (the mission's oracle, or a grounded goal judgment); otherwise `incomplete` with the reason —
   * a budget, a stuck detector, a rejected `done`, a hang, a crash. Never a silent early stop.
   */
  readonly outcome: RunOutcome;
  /**
   * For a find-out goal ended by `report` (#101): the answer and the observed page text each claim
   * rests on. Present only when code grounded it (then `outcome` is completed/grounded-answer).
   */
  readonly answer?: RunAnswer;
  /**
   * The concrete cause the run last ran into (#84), in priority order: the last fail-closed step
   * (field + why), the last disabled / not-visible target (its accessible name), an invalid field's
   * message, a visible alert. Absent when none was seen. Advisory evidence for the run's `reason`.
   */
  readonly blockingCause?: string;
  /**
   * #209: the run ended (stop `done`, #217) because the model kept proposing `done` and code rejected
   * every proposal (the success condition never held) — the model claimed the goal, it did not give up.
   */
  readonly doneRejected?: true;
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: SideEffect[];
  /** Writes past the listed cap (`MAX_SIDE_EFFECTS`), counted — present only when some were. */
  readonly sideEffectsTruncated?: number;
}

/** The longest single slice (ms) of one job wait: the model re-perceives the page between slices. */
const JOB_WAIT_SLICE_MS = 60_000;

/**
 * Waits, with backoff, while the page shows an in-progress status (#92): until it clears (the job
 * finished — then the page is given a moment to settle), the page navigates, or `budgetMs` passes.
 */
async function waitOutJob(page: Page, budgetMs: number): Promise<{ cleared: boolean; waitedMs: number }> {
  const started = Date.now();
  const url = safeUrl(page);
  let delay = 1_000;
  for (;;) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) return { cleared: false, waitedMs: Date.now() - started };
    await page.waitForTimeout(Math.max(1, Math.min(delay, left))).catch(() => undefined);
    delay = Math.min(delay * 2, 15_000);
    if (safeUrl(page) !== url || (await readInProgressStatus(page)) === null) {
      const rest = budgetMs - (Date.now() - started);
      if (rest > 0) await monitorFor(page).waitSettled({ ceilingMs: Math.min(rest, 5_000) }).catch(() => undefined);
      return { cleared: true, waitedMs: Date.now() - started };
    }
  }
}

/**
 * Actions whose own name says "go back" (Back, Cancel, Close, Undo, …): returning to an earlier
 * state is exactly their target state, never a stall.
 */
const EXPECTED_RETURN = /\b(?:back|cancel|close|dismiss|undo|previous|prev|reset|discard|clear|exit|reload)\b/i;

/** Roles whose click changes an input's value (so a later repeat of a write sends something new). */
const TOGGLE_ROLES: ReadonlySet<string> = new Set(["checkbox", "radio", "switch", "option", "menuitemcheckbox", "menuitemradio"]);

/** A button whose name reads as a form's submit (#111: a SPA's "Sign up" / "Create account" / "Save"). */
const SUBMIT_LIKE_NAME = /^\s*(?:sign ?up|register|create(?: account)?|continue|log ?in|sign ?in|save|next|submit|confirm|finish)\b/i;

/** A click that submits a form: a real submit control, a Send-like button, or a submit-named button. */
const submitsAForm = (c: Control): boolean =>
  c.submits === true || isSubmitControl(c) || ((c.role === "button" || c.tag === "button") && SUBMIT_LIKE_NAME.test(c.name));

/** A click that may submit what was typed (#123: typed values count as used after it). */
/**
 * #225: the page's form fields and their current values, for the goal judgment — a field's value is
 * never in the page's `innerText`, yet it is where a form displays what was saved. Only a non-secret
 * value (`Control.value` is never read from a password / one-time-code field) and never a bound secret
 * field or a message composer (the run's own words, #200).
 */
function fieldValuesOf(controls: readonly Control[], isBound: (c: Control) => boolean): Array<{ label: string; value: string }> {
  return controls
    .filter((c) => typeof c.value === "string" && c.value.trim() !== "" && !isBound(c) && !isCredentialField(c) && !sendable(c))
    .map((c) => ({ label: c.name || c.summary, value: c.value as string }));
}

const buttonLike = (c: Control): boolean =>
  c.role === "button" || c.tag === "button" || (c.tag === "input" && (c.inputType === "submit" || c.inputType === "button"));

/** A control's identity across snapshots (indexes are per-snapshot only). */
const keyOf = (c: Control): string => JSON.stringify(c.descriptor);

/** History text for a reply wait that ended without a reply — and why it stopped waiting (#93). */
function noReply(r: ReplyResult): string {
  const s = Math.round(r.waitedMs / 1000);
  if (r.endedBy === "ceiling") return `no reply within ${s}s (the page was still working when the wait's ceiling passed)`;
  if (r.endedBy === "idle") return `no reply within ${s}s (the page showed no sign of working on one)`;
  return `no reply within ${s}s`;
}

/** A short quote for history lines. */
function quote(s: string, n = 160): string {
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

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

/**
 * Unwinds out of the loop after the FIRST navigation failed unreachable (#128) — `stop`/`failure`
 * are already set at the point it's thrown; the outer catch recognises it and does nothing more
 * (never reclassifies it as a generic `crashed` engine failure).
 */
class FirstNavigationFailedSentinel extends Error {}

export async function explore(cfg: ExploreConfig): Promise<ExploreRun> {
  // #1 — authorize the start target before ANY snapshot/decision/action.
  const startOrigin = assertAuthorizedExploreTarget(cfg.startUrl, cfg.allowlist);
  // Mission fixture: validated before any navigation/decision (fail fast).
  const fixture = cfg.fixture === undefined ? null : await resolveMissionFixture(cfg.fixture);

  // A bound secret field's value (or TOTP seed) is a run secret: every redaction seam scrubs it.
  const secrets = [...(cfg.secrets ?? []), ...secretFieldSecrets(cfg.secretFields)];
  const secretContext = secretFieldContext(cfg.secretFields);
  const missionContext =
    [cfg.missionContext, secretContext, cfg.readOnly === true ? READ_ONLY_NOTE : null]
      .filter((c): c is string => c !== undefined && c !== null && c !== "")
      .join("; ") || undefined;
  const bounds = resolveBounds(cfg.bounds);
  const tracker = new BoundsTracker(bounds);
  const noProgress = new NoProgressDetector(3);
  const fillHelper = new FillHelper(cfg.gen);
  const recorder = new RunRecorder(cfg.site ?? startOrigin, undefined, secrets, cfg.onRecording);
  const page = cfg.actor.ability(BrowseTheWebToken).session.page;
  const crashWatch = new CrashWatch(page);
  const heap = new HeapLog();
  const probeHost = cfg.hostProbe ?? hostProbe();
  /** #203: the fresh host sample around a finding, and whether the run's sampler calls it starved. */
  const judgeHost = async (): Promise<HostJudgment> =>
    cfg.hostHealth === undefined ? { host: await probeHost(), starved: null } : cfg.hostHealth.judge();
  /** #203: a finding the starved host explains ends the run `inconclusive`, never as a hang. */
  const degradedStop = (finding: "hang" | "no-progress", detail: string, starved: string): void => {
    cfg.hostHealth?.markDegraded({ finding, detail, step: Math.max(0, transcript.entries().length - 1) }, starved);
    failure = {
      kind: "degraded-environment",
      message: `environment-degraded ${finding} (${detail}) while the host was starved: ${starved} — not an app finding`,
    };
    stop = "inconclusive";
  };
  /**
   * #230: before a hang/no-progress is a finding (or blamed on a starved host), did the app itself
   * stop answering? Throws `TargetUnresponsiveError` (→ `inconclusive` / `target-unresponsive`).
   */
  const livenessOf = () => ({
    pageUrl: page.url(),
    authorized: (u: string) => isAuthorizedExploreTarget(u, cfg.allowlist),
  });
  const now = (): number => Date.now();

  const transcript = new TranscriptLog(secrets, cfg.onTranscriptEntry);
  const history: string[] = [];
  /** #245: the demo overlay (null unless `demoOverlay`) — display only, never an input to the loop. */
  const overlay = demoOverlayFor(cfg.demoOverlay, secrets);
  const overlayWhy = `goal: ${cfg.goal}`;

  let stop: StopReason = "exhausted";
  let failure: MissionFailure | undefined;
  let lastActedOp: string | null = null;
  /** #172: did the last scroll move the page, and how many moved scrolls in a row on one state. */
  let lastScrollMoved = false;
  let movingScrolls = 0;
  let movingScrollsSignature: string | null = null;
  /** #172: the no-progress last-chance turn was given (it is given once per run). */
  let lastChanceGiven = false;
  /** #172: this decision is the last-chance turn. */
  let lastChanceTurn = false;
  let fixtureAttached = false;
  let hang: ExploreRun["hang"];
  let outcome: RunOutcome | null = null;
  /** Why the run ended incomplete, when a specific detector ended it. */
  let incomplete: string | null = null;
  /** #209: stopped because every `done` the model proposed was rejected. */
  let endedOnRejectedDone = false;
  const unsent = new UnsubmittedTypeTracker();
  const conversation: { latestReply: string | null; sent: string[] } = { latestReply: null, sent: [] };
  /** Consecutive message generations made while the conversation was stuck (#122). */
  let stuckTurns = 0;
  /** The current stuck episode was already told to the decision (#122). */
  let stuckNoted = false;
  /**
   * After a user turn went out (#122): when the conversation is now stuck on content-free / repeated
   * turns, the NEXT decision is told so once per episode — answer concretely, or take the page's
   * call to action toward the goal.
   */
  const noteStuckConversation = (controls: readonly Control[]): void => {
    if (!repetitiveTurns(conversation.sent)) {
      stuckNoted = false;
      return;
    }
    if (stuckNoted) return;
    stuckNoted = true;
    const cta = goalCallToAction(controls, cfg.goal);
    history.push(
      `the conversation is stuck: your last ${STUCK_TURNS} messages acknowledged or repeated without answering — ` +
        `answer the assistant's question with a concrete fact or choice${cta === null ? "" : `, or take the page's call to action ${quote(cta.name, 80)}`}`,
    );
  };
  /** The values this run typed into each form field, and which were submitted (#123). */
  const valueLog = new FieldValueLog();
  /** Controls present just before a message was sent — the next snapshot's new ones were offered with the reply. */
  let offerBaseline: Set<string> | null = null;
  let offeredKeys = new Set<string>();
  let doneRejections = 0;
  let reportRejections = 0;
  /** The visible text of every page state observed — what a reported answer is grounded against (#101). */
  const observed = new ObservedPages(secrets);
  /**
   * #200 — a goal about a conversational reply (`goalAsksForReply`, code-side) is reported from, and
   * grounded on, ONLY text that appeared after the run's first send: each observed state's text minus
   * the pre-send snapshot and the run's own messages, plus every reply the reply wait read. A chat
   * panel's intro / placeholder copy, on screen before the conversation, is never a reply.
   */
  const replyGoal = goalAsksForReply(cfg.goal);
  /**
   * #207 — a find-out goal (read-only, #158; not a reply goal, #200) is answered from page text: its
   * decisions carry the page's visible text, and a model `blocked` on a page state is first turned
   * into one grounded report attempt there (the answer may be plain text no control carries).
   */
  const findOut = cfg.readOnly === true && !replyGoal;
  /** #207: page states whose `blocked` was already turned into a report attempt (once per state). */
  const blockedReported = new Set<string>();
  /** #207: the latest report attempt found no answer — the run's end reason then names the pages seen. */
  let lastReportNotFound = false;
  /** #238: the latest report's "none exists" was below the coverage floor (its reason), else null. */
  let lastAbsenceUncovered: string | null = null;
  /** #239: the last click whose window was settled, and whether any click's writes all succeeded (2xx). */
  let settledClick: ReturnType<SideEffectGuard["lastClick"]> = null;
  let wroteOk = false;
  /** #239: a write goal ("record a decision…") is not settled by a report before the run saved anything. */
  const writeGoal = goalAsksToWrite(cfg.goal);
  // #229: answers Jev vetoed stay rejected for the rest of the run, however often they are re-reported.
  const vetoes = new VetoedAnswers();
  const replies = new ObservedPages(secrets);
  /** The page text just before the run's first message was sent (null until one is sent). */
  let preSend: string | null = null;
  const noteReplyText = (url: string, pageText: string): void => {
    if (preSend !== null) replies.add(url, withoutAuthored(newPageText(preSend, pageText, ""), conversation.sent));
  };
  /** The grounded answer a `report` ended the run with. */
  let answer: RunAnswer | undefined;
  /** Page states already goal-checked on the decision's "already met" signal (once each, #91). */
  const goalChecked = new Set<string>();
  /** The run's own sign-in steps and the sign-in completion code observes on each state (#188). */
  const auth = new AuthProgress();
  /** #225: the run's own typed-and-submitted form values, for the code-observed save signal. */
  const save = new SaveProgress();
  const isBound = (c: Control): boolean => boundSecretField(c, cfg.secretFields) !== null;
  let idleSteps = 0;
  let idleSince: number | null = null;
  /** How long consecutive `wait`s have waited on a still-busy app (bounded by `replyWaitMs`). */
  let busyWaitedMs = 0;
  /** The last message sent got no reply yet (a slow LLM turn): `wait`s are patience, bounded. */
  let awaitingReply = false;
  /** The page text before the last message, and the message — to keep listening for its reply. */
  let lastTurn: { baseline: string; sent: string } | null = null;
  let lastPath: string | null = null;
  // #188 — an add-another flow (the goal lists several items) comes back to a state it already went
  // through (the second item's one-time dialog, identical to the first's). The model is reminded of
  // what it did next from there, once per return — it read the history as those steps being done.
  const listsSeveral = goalListsSeveral(cfg.goal);
  const nextFrom = new Map<string, string[]>();
  let prevSignature: string | null = null;
  /** The page's status text (alerts, invalid fields) at the latest perception (#79). */
  let status: PageStatus = EMPTY_STATUS;
  /** The step whose effect the next status read reports ("after <step>: alert …"). */
  let statusAfter: string | null = null;
  /** Consecutive `wait`s that changed nothing while nothing was pending. */
  let quietWaits = 0;
  /**
   * CSS selectors (parsed from a Playwright "intercepts pointer events" failure, #90) for elements
   * proven to cover a real click. Every control they still cover is withheld from the model until the
   * page state changes — a click failure otherwise burns the whole run re-choosing the same or a
   * sibling target under the same backdrop.
   */
  let blockedInterceptors: readonly string[] = [];
  /** The page signature blocked interceptors were recorded against — cleared once it changes. */
  let blockedSinceSignature: string | null = null;
  /**
   * Controls the shared safety policy (#116) has refused this run (#168): once refused, a control is
   * withheld from the model's candidates for the rest of the run — same as the interceptor-blocked
   * set above — so a re-decide never re-chooses the same refused control.
   */
  const refusedKeys = new Set<string>();
  /** #235: the latest safety refusal's reason (named when the model then gives up), else null. */
  let lastRefusal: string | null = null;
  /** The concrete causes the run ran into, for a precise stop reason (#84). */
  const blockers: { failClosed: string | null; target: { key: string; text: string } | null } = {
    failClosed: null,
    target: null,
  };
  /**
   * The most concrete cause known now, in #84's priority order; null when there is none. An invalid
   * field is named ONLY when the last action taken was a click that sent no request at all (#130a) —
   * the shape of a form submit the browser's own validation silently blocked. A click that DID send a
   * request (even to the wrong endpoint — a `--success` typo, say) clears the field as the blocker: an
   * unrelated field's stale `:invalid` state elsewhere on the page never gets blamed for that. An
   * error toast/alert is preferred over a field either way.
   */
  const blockingCause = (): string | null => {
    if (blockers.failClosed !== null) return blockers.failClosed;
    if (blockers.target !== null) return blockers.target.text;
    const alert = status.alerts[0];
    if (alert !== undefined) return `the page shows alert ${quote(alert)}`;
    const field = status.invalid[0];
    const lastClick = sideEffects.lastClick();
    const blockedBySubmit = lastActedOp === "click" && lastClick !== null && !lastClick.requestSent;
    if (field !== undefined && blockedBySubmit) return `field ${quote(field.name, 80)} is invalid — ${quote(field.message)}`;
    return null;
  };
  /**
   * A failed act's reason as the model sees it: a disabled / hidden target is named (its accessible
   * name often says why — "Analyze — enter a URL first"), and remembered as a blocker (#79, #84).
   */
  const failNote = (reason: string | undefined, c: Control): string => {
    const r = reason ?? "?";
    if (r !== "target not enabled" && r !== "target not visible") return r;
    const name = quote(c.name || c.summary, 120);
    blockers.target = { key: keyOf(c), text: `${r === "target not enabled" ? "target disabled" : "target not visible"} — ${name}` };
    return r === "target not enabled"
      ? `${r}: ${name} is disabled — its label may say what it needs first`
      : `${r}: ${name}`;
  };
  /** A control acted on successfully is no longer the blocker. */
  const cleared = (c: Control): void => {
    if (blockers.target?.key === keyOf(c)) blockers.target = null;
  };
  const replyWaitMs = cfg.replyWaitMs ?? REPLY_WAIT_MS;
  const replyCeilingMs = Math.max(replyWaitMs, cfg.replyCeilingMs ?? REPLY_CEILING_MS);
  const replyMaxChars = cfg.replyMaxChars ?? REPLY_MAX_CHARS;
  const waitOpMs = cfg.waitOpMs ?? WAIT_OP_MS;
  /** Every page state seen so far (for "the action sent the page back to an earlier state"). */
  const seen = new Set<string>();
  /** The last executed page-changing action: when, from which state, and its Recording index. */
  const track: {
    lastMutation: {
      at: number;
      before: string;
      seenBefore: Set<string>;
      label: string;
      recordIndex: number;
      /** Did ANY page state never seen before appear since this action? (then it made progress) */
      sawNewState: boolean;
      /** A LINK click: the route it was clicked on (null for any other action) — #153. */
      linkFromRoute?: string | null;
    } | null;
    /** The raw descriptor of the last RECORDED action's target, to check it is still on the page. */
    lastRecordedTarget: string | null;
  } = { lastMutation: null, lastRecordedTarget: null };
  // #192: an option the goal names (a country, a currency) is perceived even deep in a long list.
  const goalText = cfg.goal.toLowerCase();
  const perceiveOpts = {
    maxCandidates: bounds.maxCandidates,
    mentioned: (name: string) => name.trim().length >= 2 && goalText.includes(name.trim().toLowerCase()),
    // #219: page content is redacted of every registered secret as it is perceived.
    secrets,
    ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
    ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
    ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
    ...(cfg.settle === undefined ? {} : { settleConfig: cfg.settle }),
    ...(cfg.hangs === undefined ? {} : { hangConfig: cfg.hangs }),
    ...(cfg.timingConfig === undefined ? {} : { timingConfig: cfg.timingConfig }),
  };
  const ignoreNoProgress = textMatcher(cfg.hangs?.ignoreNoProgress);
  const stallMs = cfg.stallMs ?? DEFAULT_STALL_MS;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  const timings: PageTiming[] = [];
  /** The repeated-side-effect guard (#92): a click that fired a write is not blindly re-fired. */
  // A write is classified by the shared classifier (#110): a gRPC-web/Connect read is never guarded.
  const isWrite = writeClassifier(cfg.safety?.readRequests === undefined ? {} : { readRequests: cfg.safety.readRequests });
  const sideEffects = new SideEffectGuard(monitorFor(page), { isWrite, allowlist: cfg.allowlist });
  /** The shared safety policy (#116): session-ending / destructive / paid / denied controls. */
  const safety = new SafetyPolicy(cfg.safety, { goal: cfg.goal });
  /** The writes the run's actions fire (#116: the result's `sideEffects`). */
  /**
   * #194 — which origins are the app's: the allowlist's sites, plus every origin the page sends API
   * credentials to (observed on every request below). A write elsewhere is `thirdParty`.
   */
  const firstParty = new FirstPartyOrigins(cfg.allowlist);
  const onRequestSeen = (r: { url(): string; headers(): Record<string, string> }): void => {
    firstParty.observe(r.url(), r.headers());
  };
  page.on("request", onRequestSeen);
  // #223: the main document's HTTP status per URL — an answer on a 404 / error page is no answer.
  const documentStatus = new Map<string, number>();
  /** #223: controls repeated across pages (global chrome) — their link text is not page content. */
  const chrome = new ChromeTracker();
  const docKey = (u: string): string => u.split("#")[0] ?? u;
  const onDocumentResponse = (r: { url(): string; status(): number; request(): { isNavigationRequest(): boolean; frame(): unknown } }): void => {
    try {
      if (!r.request().isNavigationRequest() || r.request().frame() !== page.mainFrame()) return;
      if (documentStatus.size >= 500) documentStatus.clear();
      documentStatus.set(docKey(r.url()), r.status());
    } catch {
      // a response whose frame is gone: nothing to record
    }
  };
  page.on("response", onDocumentResponse);
  // #194: a write to a third-party origin is listed with its full URL and `thirdParty: true`.
  const effectLog = new SideEffectLog({ isWrite, now, allowlist: cfg.allowlist, firstParty });
  /** A find-out goal's read-only guard (#158), or null when the run may write. */
  const readOnly =
    cfg.readOnly === true
      ? new ReadOnlyGuard(isWrite, {
          // #194: only writes to the app's own origins are blocked; a third-party beacon passes (listed).
          allowlist: cfg.allowlist,
          firstParty,
          ...(cfg.safety?.allowWriteRequests === undefined ? {} : { allowWrites: cfg.safety.allowWriteRequests }),
        })
      : null;
  const jobWaitMs = cfg.jobWaitMs ?? replyCeilingMs;
  /** How long `wait`s have waited on the in-progress status the page shows (bounded by `jobWaitMs`). */
  let jobWaitedMs = 0;
  /**
   * How long a hang signal has been deferred because the page is visibly WORKING (#153): never reset,
   * so a page that keeps "working" is still reported as a hang once the job-wait budget is spent.
   */
  let hangWorkWaitedMs = 0;
  const noteMutation = (
    label: string,
    descriptor: unknown,
    before: string,
    at: number,
    input?: { readonly field: string; readonly value: string },
    linkFromRoute: string | null = null,
  ): void => {
    // An input change (type/select/send/upload) makes a repeat send something new — unless it set
    // the same value again (#123): the guard compares the values.
    if (!label.startsWith("click ")) sideEffects.inputChanged(input?.field, input?.value);
    track.lastMutation = { at, before, seenBefore: new Set(seen), label, recordIndex: recorder.stepCount - 1, sawNewState: false, linkFromRoute };
    track.lastRecordedTarget = JSON.stringify(descriptor);
    statusAfter = label;
  };

  // #128: real network evidence for the FIRST navigation, preferred over whatever `page.goto`
  // itself reports — a refused connection can still surface as a bare navigation timeout.
  let firstNavNetError: string | null = null;
  const onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
    const text = req.failure()?.errorText;
    if (text !== undefined) firstNavNetError = text;
  };
  let firstNavFailed = false;

  try {
    // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
    await monitorFor(page).instrument();
    effectLog.attach(monitorFor(page));
    // Initial navigation (authorized above).
    page.on("requestfailed", onFirstNavRequestFailed);
    try {
      await assertSeedReachable(cfg.actor, cfg.startUrl);
      await Navigate.to(cfg.startUrl).performAs(cfg.actor);
    } catch (e) {
      const message = firstLine(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem (a bad URL, the target not running). `inconclusive`, not `crashed`;
      // no crash report is built for it, so no issue is ever drafted from it.
      firstNavFailed = true;
      stop = "inconclusive";
      const cause = describeUnreachable(message, firstNavNetError);
      failure = { kind: "target-unreachable", message: `target unreachable (${cause})` };
      // #213: a bare load TIMEOUT (no network error) on a starved host is the host, not the target —
      // unless a fresh request for the page gets no response at all either (#230: the app is down).
      if (cause === "timed out before any response" && cfg.hostHealth !== undefined) {
        const judged = await cfg.hostHealth.judge();
        if (judged.starved !== null && (await targetStoppedAnswering({ pageUrl: cfg.startUrl }).catch(() => null)) === null) {
          const detail = `the start page did not load in time (${cause})`;
          cfg.hostHealth.markDegraded({ finding: "page-load-timeout", detail, step: 0 }, judged.starved);
          failure = {
            kind: "degraded-environment",
            message: `environment-degraded page load (${detail}) while the host was starved: ${judged.starved} — not an app or access finding`,
          };
        }
      }
    } finally {
      page.off("requestfailed", onFirstNavRequestFailed);
    }
    if (firstNavFailed) throw new FirstNavigationFailedSentinel();
    recorder.navigate(cfg.startUrl, now());
    // #158 — from here on, a read-only run's write requests never leave the browser.
    if (readOnly !== null) {
      await readOnly.arm(page);
      effectLog.markBackground();
      history.push(READ_ONLY_NOTE);
    }

    for (;;) {
      if (!tracker.mayDecide()) {
        stop = "exhausted";
        break;
      }

      // Shared perception: never decide on an unrendered page (bounded render wait) and never
      // offer an occluded control (see `perceive`).
      const perception = await perceive(page, perceiveOpts);
      timings.push(perception.timing);
      // The last click's window closes here: what it wrote is now known (#92).
      sideEffects.settle();
      // #239: a click whose writes all succeeded saved what the run had typed — from here those values
      // are the app's, and the run has written (a write goal's report may settle it).
      {
        const lc = sideEffects.lastClick();
        if (lc !== null && lc !== settledClick) {
          settledClick = lc;
          if (lc.writes.length > 0 && lc.writes.every((w) => w.status !== null && w.status >= 200 && w.status < 300)) {
            observed.confirmOwnInputs();
            wroteOk = true;
          }
        }
      }
      // #158 — the action's window closes once the page settled: later writes are the app's own.
      if (readOnly?.settled() === true) effectLog.markBackground();
      // A bound secret field shows the model its placeholder only (#72).
      const snap = maskSecretFields(perception.snapshot, cfg.secretFields);
      {
        const m = track.lastMutation;
        if (m !== null && snap.signature !== m.before && !m.seenBefore.has(snap.signature)) m.sawNewState = true;
      }
      await heap.sample(page, transcript.nextStep);
      // Re-observe the PREVIOUS action's effect: patch its postcondition + open
      // the next page segment if the URL changed (record-before-reobserve).
      const target = track.lastRecordedTarget;
      recorder.observed(
        snap.url,
        now(),
        perception.timing,
        target === null ? undefined : { lastTargetStillPresent: snap.controls.some((c) => JSON.stringify(c.descriptor) === target) },
      );
      track.lastRecordedTarget = null;

      // Long-running legitimate work is not a hang (#153): a page that shows an in-progress status
      // AND acknowledges it (a Cancel control, the pressed control disabled as "Analyzing...", a
      // determinate progress bar) is WORKING. Code waits it out, bounded by the job-wait budget;
      // past the budget the hang stands. A main thread that does not answer is never "working".
      if (perception.hang !== null && perception.hang.kind !== "main-thread-unresponsive" && hangWorkWaitedMs < jobWaitMs) {
        const working = await readWorkingStatus(page);
        if (working !== null) {
          const w = await waitOutJob(page, Math.min(jobWaitMs - hangWorkWaitedMs, JOB_WAIT_SLICE_MS));
          // The perception's own wait counts too: the budget bounds the whole time spent believing it.
          hangWorkWaitedMs += w.waitedMs + perception.settle.waitedMs;
          const note = `not a hang yet (${perception.hang.kind}): the page shows ${working} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
            w.cleared ? "the status cleared" : `still in progress; ${Math.round(hangWorkWaitedMs / 1000)}s of the ${Math.round(jobWaitMs / 1000)}s job-wait budget used`
          })`;
          history.push(note);
          transcript.record({
            op: "wait",
            control: null,
            confidence: null,
            chosenBy: "strategy",
            strategy: "hang-check",
            actOk: true,
            reason: note,
            snapshot: snap,
            timing: perception.timing,
          });
          continue;
        }
      }

      // A hang is its own first-class stop (owner ruling 7) — detected by perception's rule.
      if (perception.hang !== null) {
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "hang-check",
          actOk: false,
          reason: `hang (${perception.hang.kind}): ${perception.hang.detail}`,
          snapshot: snap,
          timing: perception.timing,
        });
        await assertTargetAnswering(livenessOf());
        const judged = await judgeHost();
        if (judged.starved !== null) {
          degradedStop(perception.hang.kind === "ui-no-progress" ? "no-progress" : "hang", `${perception.hang.kind}: ${perception.hang.detail}`, judged.starved);
          break;
        }
        const heapNow = await sampleHeap(page, 1_000);
        const withHost: HangSignal = { ...perception.hang, host: judged.host };
        hang = {
          signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
          recordingStepIndex: Math.max(0, recorder.stepCount - 1),
        };
        stop = "hang";
        break;
      }

      // #1 — mid-run origin guard (fail-closed): never act off an authorized origin.
      if (!isAuthorizedExploreTarget(snap.url, cfg.allowlist)) {
        stop = "blocked";
        break;
      }

      // Additive observation hook (usability analysis). Advisory: awaited but its
      // result never gates the loop, bounds, or stop decision.
      await cfg.onSnapshot?.(snap);

      // #150 — mission spend budget, post-settle: UNLIKE onSnapshot above, this hook's result DOES
      // gate the loop. A crossed budget stops the run cleanly, before its next decision.
      if (cfg.onSettled !== undefined) {
        const budget = await cfg.onSettled(snap);
        if (budget.stop) {
          transcript.record({
            op: null,
            control: null,
            confidence: null,
            chosenBy: "strategy",
            strategy: "budget",
            actOk: false,
            reason: budget.reason,
            snapshot: snap,
            timing: perception.timing,
          });
          incomplete = budget.reason;
          stop = "budget";
          break;
        }
      }

      // #174 — the success condition is already met (independent code): stop now, never act past it.
      if (cfg.successMetNow !== undefined) {
        const met = await cfg.successMetNow().catch(() => null);
        if (met !== null) {
          transcript.record({
            op: "done",
            control: null,
            confidence: null,
            chosenBy: "strategy",
            strategy: "success-held",
            actOk: true,
            reason: `goal already met — stopped before the next action: ${met}`,
            snapshot: snap,
            timing: perception.timing,
          });
          outcome = { status: "completed", verifiedBy: "success-condition" };
          stop = "done";
          break;
        }
      }

      if (!perception.rendered) {
        transcript.record({
          op: "wait",
          control: null,
          confidence: null,
          chosenBy: "strategy",
          actOk: false,
          reason: `${perception.reason} (fail-closed)`,
          snapshot: snap,
          timing: perception.timing,
        });
        stop = "blocked";
        break;
      }

      // Status text (#79): alerts / invalid fields are not controls, so the model would never see
      // them. What newly appeared after the last step goes into its history; what shows now goes
      // into its prompt.
      {
        const before = status;
        status = await readPageStatus(page);
        const appeared = statusDelta(before, status);
        if (transcript.nextStep > 0 && !isEmptyStatus(appeared)) {
          history.push(`after ${statusAfter ?? "the last step"}: ${describeStatus(appeared)}`);
        }
        statusAfter = null;
      }

      // #172 — a scroll that MOVED the page is progress (the model is reading a long page), even
      // though the control set — the signature — is the same; bounded, so a scroll loop still stops.
      const scrolledMoved = (lastActedOp === "scroll_down" || lastActedOp === "scroll_up") && lastScrollMoved;
      if (!scrolledMoved || snap.signature !== movingScrollsSignature) movingScrolls = 0;
      movingScrollsSignature = snap.signature;
      if (scrolledMoved) movingScrolls += 1;
      const scrollProgress = scrolledMoved && movingScrolls <= MAX_MOVING_SCROLLS;
      if (scrollProgress) noProgress.progress(snap.signature);
      lastChanceTurn = false;
      // #2 — no-progress: the last executed op left the page unchanged N times.
      if (lastActedOp !== null && !scrollProgress && noProgress.note(lastActedOp, snap.signature)) {
        // Is the APP stuck (not the explorer)? The page is alive, the last page-changing action
        // sent it BACK to a state it had already been in (it changed, then reverted — an action
        // that silently undid itself, like an import that never starts), and it stays there for
        // the stall window: a `ui-no-progress` hang, not generic no-progress. An action that simply
        // did nothing (same state before and after) stays plain no-progress.
        // The action's target state must NEVER have appeared (no new state since the action), and
        // the target must not have declared this route/action as expected to return (per-target ignore).
        const m = track.lastMutation;
        if (
          m !== null &&
          !m.sawNewState &&
          snap.signature !== m.before &&
          m.seenBefore.has(snap.signature) &&
          // A link that navigated to ANOTHER route already visited is ordinary navigation, not an
          // in-place action that silently undid itself (#153): the stall rule is for in-place actions.
          !((m.linkFromRoute ?? null) !== null && m.linkFromRoute !== hangRoute(snap.url)) &&
          !EXPECTED_RETURN.test(m.label) &&
          !ignoreNoProgress(m.label) &&
          !ignoreNoProgress(hangRoute(snap.url))
        ) {
          const waited = now() - m.at;
          if (waited < stallMs) await page.waitForTimeout(stallMs - waited);
          const again = await perceive(page, perceiveOpts);
          timings.push(again.timing);
          const stuck =
            again.hang ??
            (again.snapshot.signature === snap.signature && (await probeResponsive(page, cfg.hangProbeMs ?? HANG_PROBE_MS))
              ? ({
                  kind: "ui-no-progress",
                  detail: `after "${m.label}" the page returned to an earlier state and made no progress for ${Math.round((now() - m.at) / 1000)}s`,
                  route: hangRoute(snap.url),
                  url: redactUrl(snap.url),
                  pending: [],
                  lastState: { signature: snap.signature, controls: snap.controls.map((c) => c.summary) },
                } satisfies HangSignal)
              : null);
          if (stuck !== null) {
            transcript.record({
              op: null,
              control: null,
              confidence: null,
              chosenBy: "strategy",
              strategy: "hang-check",
              actOk: false,
              reason: `hang (${stuck.kind}): ${stuck.detail}`,
              snapshot: again.snapshot,
              timing: again.timing,
            });
            await assertTargetAnswering(livenessOf());
            const judged = await judgeHost();
            if (judged.starved !== null) {
              degradedStop(stuck.kind === "ui-no-progress" ? "no-progress" : "hang", `${stuck.kind}: ${stuck.detail}`, judged.starved);
              break;
            }
            const heapNow = await sampleHeap(page, 1_000);
            const withHost: HangSignal = { ...stuck, host: judged.host };
            hang = {
              signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
              recordingStepIndex: stuck.kind === "ui-no-progress" ? m.recordIndex : Math.max(0, recorder.stepCount - 1),
            };
            stop = "hang";
            break;
          }
        }
        if (!lastChanceGiven) {
          // #172 — one last-chance turn before the stop: the model has seen the page; it acts,
          // reports, or says done/blocked. For a find-out goal an idle choice becomes a report.
          lastChanceGiven = true;
          lastChanceTurn = true;
          history.push(LAST_CHANCE_NOTE);
        } else {
          stop = "no-progress";
          break;
        }
      }
      // Progress was made: a later stuck episode gets its own last chance.
      if (noProgress.streak === 0) lastChanceGiven = false;
      seen.add(snap.signature);

      // #90 — an interceptor proven by a real click failure stays blocked only while the page it was
      // proven on is still up; a re-render/navigation may have removed or moved it.
      if (blockedSinceSignature !== null && snap.signature !== blockedSinceSignature) {
        blockedInterceptors = [];
        blockedSinceSignature = null;
      }
      let modelControls = snap.controls;
      if (blockedInterceptors.length > 0) {
        const covered = new Set<number>();
        for (const c of snap.controls) {
          const loc = descriptorToLocator(page, c.descriptor);
          const hit = await loc.evaluate(coveredByInterceptors, blockedInterceptors).catch(() => false);
          if (hit) covered.add(c.index);
        }
        if (covered.size > 0) modelControls = snap.controls.filter((c) => !covered.has(c.index));
      }
      // #168 — a control the safety policy already refused this run is withheld from now on (never
      // re-offered, so the model cannot re-choose it and burn another action on the same refusal).
      if (refusedKeys.size > 0) modelControls = modelControls.filter((c) => !refusedKeys.has(keyOf(c)));

      // Conversation bookkeeping (independent code). A navigation takes any typed text with it;
      // a field that left the page took its text too.
      const path = safePath(snap.url);
      if (lastPath !== null && path !== lastPath) {
        unsent.submitted();
        valueLog.submitted();
        save.reset();
      }
      lastPath = path;
      if (listsSeveral && prevSignature !== null && prevSignature !== snap.signature) {
        const next = nextFrom.get(snap.signature);
        if (next !== undefined) {
          history.push(
            `this page is in the same state as earlier, where you went on with: ${next.join(", ")} — the goal lists several items: if one is still to do, the same steps apply to it`,
          );
        }
      }
      prevSignature = snap.signature;
      const keys = new Map<string, Control>(snap.controls.map((c) => [keyOf(c), c]));
      unsent.retain(new Set(keys.keys()));
      if (offerBaseline !== null) {
        const before = offerBaseline;
        offeredKeys = new Set([...keys.keys()].filter((k) => !before.has(k)));
        offerBaseline = null;
      }
      const offered = new Set(snap.controls.filter((c) => offeredKeys.has(keyOf(c))).map((c) => c.index));
      const unsubmitted = new Set(snap.controls.filter((c) => unsent.wouldRepeat(keyOf(c))).map((c) => c.index));

      // #207: a form field's current value is page content too (grounded as such, never as page text).
      const visibleText = await readPageText(page, secrets);
      // #223: a rich-text (contenteditable) control's text is its value too, groundable like an input's.
      const richFields: { label: string; value: string }[] = [];
      for (const c of snap.controls.filter((x) => x.richText === true).slice(0, 5)) {
        const t = (await readEditableText(page, c))?.trim() ?? "";
        if (t !== "") richFields.push({ label: c.name.trim() || c.role || c.tag, value: redactText(t, secrets) });
      }
      try {
        chrome.observe(new URL(snap.url).pathname, snap.controls);
      } catch {
        // an unparsable URL: no chrome evidence from it
      }
      observed.add(snap.url, visibleText, [...controlFields(snap.controls), ...richFields], {
        ...(await readPageHeadings(page, secrets)),
        // #223: the action / label names (a quote made only of them is a label, not an answer) and
        // the document's status (an answer on a 404 page is no answer). A link that is page content
        // (in the main content, a list, a table, a card) is NOT one: its text may be the answer.
        controlNames: snap.controls.filter((c) => isActionOrChromeName(c, chrome)).map((c) => c.name),
        // #229: the content links' text, in page order (a list's entries: "the first item").
        contentLinks: snap.controls.filter((c) => !isActionOrChromeName(c, chrome)).map((c) => c.name),
        // #238: where the page's navigation leads — the first page's is the absence-answer coverage floor.
        navLinks: snap.controls
          .filter((c) => c.role === "link" && (c.landmark === "navigation" || c.landmark === "banner"))
          .flatMap((c) => (typeof c.href === "string" && c.href !== "" ? [c.href] : [])),
        ...(documentStatus.has(docKey(page.url())) ? { status: documentStatus.get(docKey(page.url()))! } : {}),
      });
      noteReplyText(snap.url, visibleText);

      // #158 — the write requests the read-only guard aborted since the last decision: recorded
      // (jevitate's own refusal) and told to the model.
      {
        const blocked = readOnly?.drain() ?? [];
        if (blocked.length > 0) {
          const what = [...new Set(blocked.map((b) => `${b.method} ${b.path}`))].join(", ");
          // #194: a blocked write off the --allow origins says how to declare or exempt it.
          const hints = [...new Set(blocked.flatMap((b) => (b.hint === undefined ? [] : [b.hint])))];
          const note =
            `blocked write request(s) ${redactText(what, secrets)}: this find-out goal is read-only — find the answer without changing anything` +
            (hints.length === 0 ? "" : ` (${redactText(hints.join("; "), secrets)})`);
          history.push(note);
          transcript.record({
            op: null,
            control: null,
            confidence: null,
            chosenBy: "strategy",
            strategy: "read-only",
            actOk: false,
            reason: note,
            origin: "engine",
            snapshot: snap,
            timing: perception.timing,
          });
        }
      }

      let decision: Awaited<ReturnType<typeof decide>>;
      try {
        // #192: the choice cap is bounded in decide(); should the API still refuse the count (a
        // lower limit than documented), retry with a tighter budget instead of ending the run.
        const decideWith = (maxChoices?: number): Promise<Decision> =>
          decide(cfg.judge, {
            goal: cfg.goal,
            snapshot: modelControls === snap.controls ? snap : { ...snap, controls: modelControls },
            history,
            missionContext,
            secrets,
            // One fixture ⇒ one upload: once attached, upload actions leave the candidate set (the
            // model had kept re-choosing it after a successful attach instead of proceeding).
            uploadAvailable: fixture !== null && !fixtureAttached,
            offered,
            unsubmitted,
            ...(conversation.latestReply === null && conversation.sent.length === 0
              ? {}
              : { conversation: { latestReply: conversation.latestReply, sentMessages: conversation.sent } }),
            ...(isEmptyStatus(status) ? {} : { pageStatus: describeStatus(status) }),
            ...(maxChoices === undefined ? {} : { maxChoices }),
            ...(findOut ? { pageText: visibleText } : {}),
          });
        decision = await decideWith().catch(async (e: unknown) => {
          const refusal = firstLine(e);
          if (!TOO_MANY_CHOICES.test(refusal)) throw e;
          // The refusal names the limit it enforces ("at most N choices"): retry within it.
          const stated = Number(/at most (\d+)/i.exec(refusal)?.[1]);
          const budget = Number.isInteger(stated) && stated > 0 ? stated : TOO_MANY_CHOICES_RETRY;
          history.push(`the decision had too many choices for the model: retried with the ${budget} most relevant`);
          return decideWith(budget);
        });
      } catch (e) {
        // The decision IS the goal loop's engine: without it the run can prove nothing more, so it
        // ends `inconclusive` (typed) with everything recorded so far — never a throw, never clean.
        failure = { kind: "exception", message: `model decision unavailable: ${firstLine(e)}` };
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "model",
          actOk: false,
          reason: failure.message,
          snapshot: snap,
          timing: perception.timing,
        });
        stop = "inconclusive";
        break;
      }
      tracker.countDecision();
      if (
        lastChanceTurn &&
        cfg.readOnly === true &&
        (decision.op === "scroll_down" || decision.op === "scroll_up" || decision.op === "wait" || decision.op === "blocked")
      ) {
        // #172 — a find-out goal that has seen the whole page and still only idles (or gives up)
        // ends with a report ATTEMPT, grounded by code like any report, never a bare `blocked`.
        history.push(`last chance: "${decision.op}" became a report attempt — the answer must be on the pages already seen`);
        decision = { ...decision, op: "report", control: null, targetMissing: false };
      }
      if (findOut && decision.op === "blocked" && !blockedReported.has(snap.signature)) {
        // #207 — a find-out goal's `blocked` is never a bare give-up while the page may show the
        // answer as plain text: one report ATTEMPT on this page state first, grounded by code.
        blockedReported.add(snap.signature);
        history.push(`"blocked" became a report attempt — a find-out goal is answered from the pages already seen`);
        decision = { ...decision, op: "report", control: null, targetMissing: false };
      }

      const record = (
        actOk: boolean,
        reason?: string,
        extra: {
          message?: string;
          value?: string;
          reply?: ReplyResult;
          judgments?: Record<string, { value: boolean; probability: number }>;
          op?: typeof decision.op;
          control?: Control | null;
          strategy?: string;
          answer?: AnswerVerdict["answer"];
          /** See `TranscriptEntry.origin` — set for a refusal decided by jevitate's own guard/fail-closed logic, never after a real `act()` attempt. */
          origin?: "engine";
        } = {},
      ): void => {
        const op = extra.op ?? decision.op;
        const target = extra.control === undefined ? decision.control : extra.control;
        if (op === "type" || op === "send") auth.noteTyped(target, snap.url, actOk, target !== null && isBound(target));
        // #225: typed credentials make the pending submit a sign-in, never a save.
        if ((op === "type" || op === "send") && actOk && target !== null && (isBound(target) || isCredentialField(target))) save.noteCredential();
        if (actOk && target !== null && (op === "click" || op === "type" || op === "select")) {
          const steps = nextFrom.get(snap.signature) ?? [];
          // The first visit's steps only: a return must not overwrite what the state led to.
          if (!nextFrom.has(snap.signature) || steps.length < 4) {
            if (!steps.includes(`${op} ${quote(target.name || target.summary, 60)}`)) steps.push(`${op} ${quote(target.name || target.summary, 60)}`);
            nextFrom.set(snap.signature, steps);
          }
        }
        transcript.record({
          op: extra.op ?? decision.op,
          control: extra.control === undefined ? decision.control : extra.control,
          ...(extra.strategy === undefined ? {} : { strategy: extra.strategy }),
          ...(extra.answer === undefined || extra.answer === null ? {} : { answer: { ...extra.answer, accepted: actOk } }),
          confidence: decision.confidence,
          chosenBy: "model",
          actOk,
          ...(reason === undefined ? {} : { reason }),
          ...(extra.origin === undefined ? {} : { origin: extra.origin }),
          snapshot: snap,
          timing: perception.timing,
          ...(extra.message === undefined ? {} : { message: extra.message }),
          ...(extra.value === undefined ? {} : { value: extra.value }),
          ...(extra.reply === undefined ? {} : { reply: extra.reply }),
          ...(extra.judgments === undefined ? {} : { judgments: extra.judgments }),
        });
      };

      // Grounds "the goal is met on this page" (guardrail #4): typed-but-unsent text, the mission's
      // independent success condition, or — without one — an advisory goal judgment on the visible
      // page (the run's own messages removed) and its status text, which must clear the threshold.
      // A run that typed sign-in credentials also carries what code observed about the sign-in
      // (#188): shown to the judgment as a trusted fact, and weighed by `groundDone`.
      const signIn = auth.signal(snap, isBound);
      /**
       * #209: what an accepted verdict may claim. The in-run success condition is only a proposal's
       * grounding — when part of it is still pending (a `reloadThen` check judged after the run, a
       * check holding since before any action), the transcript says so instead of "goal verified".
       */
      const pendingNote = (o: RunOutcome): string | null =>
        o.status === "completed" && o.verifiedBy === "success-condition" ? (cfg.successCheckPending?.() ?? null) : null;
      const acceptedBy = (o: RunOutcome): string => {
        const pending = pendingNote(o);
        if (pending !== null) return `the in-run success checks held, but the final verdict is still pending — ${pending}`;
        return `goal verified by ${o.status === "completed" ? o.verifiedBy : "?"}`;
      };
      const groundGoal = async (advisoryOnly = false): Promise<{
        verdict: ReturnType<typeof groundDone>;
        judgments: Record<string, { value: boolean; probability: number }> | undefined;
      }> => {
        const unsubmittedLabels = [...unsent.pending().values()].map((p) => p.label);
        let successCheck: boolean | undefined;
        let goalMet: number | null | undefined;
        let goalIsSignIn: number | null = null;
        let goalIsSave: number | null = null;
        let saved: ReturnType<SaveProgress["signal"]> = null;
        if (unsubmittedLabels.length === 0) {
          if (cfg.successCheck !== undefined && !advisoryOnly) {
            successCheck = await cfg.successCheck().then(
              (v) => v,
              () => false,
            );
          } else {
            const fullText = await readPageText(page, secrets);
            const pageText = withoutAuthored(fullText, conversation.sent);
            // #225: the run's own save, as code observed it — its writes, the page's notice, and whether
            // the page still displays what it saved (a field's value is never in the page text).
            saved = save.signal(snap, status, sideEffects.lastClick(), fullText);
            const judged = await judgeGoalCompletion(cfg.judge, {
              goal: cfg.goal,
              url: snap.url,
              pageText,
              history,
              secrets,
              ...(isEmptyStatus(status) ? {} : { pageStatus: describeStatus(status) }),
              ...(signIn === null ? {} : { signInFacts: signIn.facts }),
              ...(saved === null ? {} : { saveFacts: saved.facts }),
              fieldValues: fieldValuesOf(snap.controls, isBound),
            }).catch(() => ({ goalMet: null, goalIsSignIn: null, goalIsSave: null }));
            goalMet = judged.goalMet;
            goalIsSignIn = judged.goalIsSignIn;
            goalIsSave = judged.goalIsSave;
          }
        }
        const verdict = groundDone({
          unsubmitted: unsubmittedLabels,
          ...(successCheck === undefined ? {} : { successCheck }),
          ...(goalMet === undefined ? {} : { goalMetProbability: goalMet }),
          ...(signIn === null || goalMet === undefined ? {} : { signIn: { completed: signIn.completed, goalIsSignIn } }),
          ...(saved === null || goalMet === undefined ? {} : { save: { completed: saved.completed, goalIsSave } }),
        });
        // `value` is code's reading of the probability (the acceptance threshold), not the port's
        // p >= 0.5 — a transcript must never show "goalMet: true" beside "done rejected" (#91).
        const judgments: Record<string, { value: boolean; probability: number }> = {};
        if (goalMet !== undefined && goalMet !== null) judgments.goalMet = { value: goalMet >= GOAL_MET_THRESHOLD, probability: goalMet };
        if (goalIsSignIn !== null) judgments.goalIsSignIn = { value: goalIsSignIn >= GOAL_MET_THRESHOLD, probability: goalIsSignIn };
        if (goalIsSave !== null) judgments.goalIsSave = { value: goalIsSave >= GOAL_MET_THRESHOLD, probability: goalIsSave };
        return { verdict, judgments: Object.keys(judgments).length === 0 ? undefined : judgments };
      };

      // The decision's advisory "already met?" signal (#91): the loop used to act past a met goal
      // because the model never proposed `done`. Code grounds it BEFORE acting — once per page
      // state — and stops `done` only on the same grounded verdict a proposed `done` needs.
      // Also grounded (#188): a model `blocked` — giving up on a page that already shows the goal met
      // must not end the run incomplete — and a state where code observed the run's sign-in complete.
      if (
        (decision.op === "blocked" ||
          signIn?.completed === true ||
          (decision.goalMet !== null && decision.goalMet >= GOAL_CHECK_TRIGGER)) &&
        decision.op !== "done" &&
        decision.op !== "report" &&
        // #235: an in-run check over nothing (every check is judged after the run) shows nothing held.
        cfg.successCheckDeferred !== true &&
        // #286: a goal that asks for a report is never "already met" without its answer.
        cfg.requireAnswer !== true &&
        // #207: a find-out goal is verified by a grounded answer; its `blocked` (after a report
        // attempt on this state found none) never becomes an answerless "goal already met".
        !(findOut && decision.op === "blocked") &&
        !goalChecked.has(snap.signature)
      ) {
        goalChecked.add(snap.signature);
        const { verdict, judgments } = await groundGoal();
        if (verdict.accept) {
          record(
            true,
            `goal already met — stopped instead of "${decision.op}": ${acceptedBy(verdict.outcome)}`,
            {
              op: "done",
              control: null,
              strategy: "goal-check",
              judgments: {
                ...(judgments ?? {}),
                ...(decision.goalMet === null
                  ? {}
                  : { goalAlreadyMet: { value: decision.goalMet >= GOAL_CHECK_TRIGGER, probability: decision.goalMet } }),
              },
            },
          );
          outcome = verdict.outcome;
          stop = "done";
          break;
        }
      }

      // #286: the goal asks for a report — `done` is no ending; the answer is (grounded by `report`).
      if (decision.op === "done" && cfg.requireAnswer === true) {
        doneRejections += 1;
        const why = "the goal asks you to report what you found: end with `report` (a grounded answer), not `done`";
        history.push(`done rejected: ${why}`);
        record(false, `done rejected (${doneRejections}/${MAX_DONE_REJECTIONS}): ${why}`);
        if (doneRejections >= MAX_DONE_REJECTIONS) {
          incomplete = `the model proposed done ${doneRejections} times, but ${why}`;
          endedOnRejectedDone = true;
          stop = "done";
          break;
        }
        continue;
      }
      // `done` is a PROPOSAL (guardrail #4), grounded by `groundGoal`.
      if (decision.op === "done") {
        const { verdict, judgments } = await groundGoal();
        if (verdict.accept) {
          record(true, `done accepted${pendingNote(verdict.outcome) === null ? "" : " provisionally"}: ${acceptedBy(verdict.outcome)}`, {
            ...(judgments === undefined ? {} : { judgments }),
          });
          outcome = verdict.outcome;
          stop = "done";
          break;
        }
        // #225: the model's `done` failed the independent success check, but the job itself is judged
        // done on this page (the advisory judgment / code-observed save, never the verdict): stop here
        // rather than spend the rest of the budget — the check's failure is the finding, and the
        // mission names it (`failed`, success-check-failed).
        if (cfg.stopWhenJudgedDone === true && cfg.successCheck !== undefined && unsent.pending().size === 0) {
          const advisory = await groundGoal(true);
          if (advisory.verdict.accept) {
            const reason = `the job was judged done on this page (${acceptedBy(advisory.verdict.outcome).replace(/^goal verified by /, "")}), but ${verdict.reason}`;
            record(false, `done rejected: ${reason} — stopped (the success check decides; it failed)`, {
              ...(advisory.judgments === undefined ? {} : { judgments: advisory.judgments }),
            });
            incomplete = reason;
            endedOnRejectedDone = true;
            stop = "done";
            break;
          }
        }
        doneRejections += 1;
        history.push(`done rejected: ${verdict.reason} — keep working toward the goal`);
        record(false, `done rejected (${doneRejections}/${MAX_DONE_REJECTIONS}): ${verdict.reason}`, {
          ...(judgments === undefined ? {} : { judgments }),
        });
        if (doneRejections >= MAX_DONE_REJECTIONS) {
          incomplete = `the model proposed done ${doneRejections} times, but ${verdict.reason}`;
          endedOnRejectedDone = true;
          // #217: the loop ended on the model's `done` (code rejected it) — the stop says so; it
          // never reads `blocked` (the model did not give up). The outcome stays incomplete.
          stop = "done";
          break;
        }
        continue;
      }
      // `report` (#101) ends a find-out goal with an ANSWER — a proposal too: the answer is generated
      // from the observed page text and accepted only when code grounds every claim on it.
      if (decision.op === "report") {
        if (replyGoal) {
          // #200 — a reply still on its way is listened for (what is left of the reply wait) before
          // the report is judged; then the current page's post-send text is taken in.
          if (awaitingReply && lastTurn !== null && busyWaitedMs < replyWaitMs) {
            const t0 = now();
            const listen = replyWaitMs - busyWaitedMs;
            const reply = await waitForReply(page, { secrets, ...lastTurn, timeoutMs: listen, ceilingMs: listen });
            busyWaitedMs += now() - t0;
            if (reply.received) {
              conversation.latestReply = reply.text;
              replies.add(snap.url, reply.text);
              awaitingReply = false;
              busyWaitedMs = 0;
              history.push(`waited for the reply → reply: ${quote(reply.text, 300)}`);
            }
          }
          noteReplyText(snap.url, await readPageText(page, secrets));
        }
        const replyPages = replyGoal ? replies.pages() : null;
        const verdict: AnswerVerdict =
          replyPages !== null && replyPages.length === 0
            ? {
                accept: false as const,
                reason:
                  preSend === null
                    ? "no reply observed: no message was sent yet — text on the page before the conversation is not a reply"
                    : `no reply observed: no new message appeared after the send within the reply wait (${Math.round(replyWaitMs / 1000)}s)`,
                answer: null,
              }
            : await reportAnswer(cfg.gen, {
                goal: cfg.goal,
                url: snap.url,
                pages: replyPages ?? observed.pages(),
                history,
                secrets,
                judge: cfg.judge,
                vetoes,
                // #238: "none exists" is an answer only on observed pages that cover the app enough.
                ...(replyPages === null ? { topNav: observed.topNavigation(), ownInputs: observed.ownInputs() } : {}),
              })
                // #239: a write goal's report settles nothing before a write of the run succeeded.
                .then((v): AnswerVerdict =>
                  v.accept && writeGoal && !wroteOk && v.answer.absent !== true ? { accept: false, reason: UNSAVED_WRITE_REASON, answer: v.answer } : v,
                )
                .catch((e: unknown) => ({ accept: false as const, reason: `no answer could be generated: ${firstLine(e)}`, answer: null }));
        if (verdict.accept) {
          const on = replyPages === null ? "the observed pages" : "the reply observed after the send";
          record(true, `report accepted: answer grounded on ${on} (${verdict.answer.evidence.length} claim(s))`, {
            answer: verdict.answer,
          });
          answer = verdict.answer;
          outcome = { status: "completed", verifiedBy: "grounded-answer" };
          stop = "done";
          break;
        }
        reportRejections += 1;
        // #223: an answer that is on the page but does not answer the question is no answer either.
        lastReportNotFound = (verdict.answer === null && verdict.reason === NO_ANSWER_REASON) || verdict.notAnswer === true;
        lastAbsenceUncovered = verdict.absenceUncovered === true ? verdict.reason : null;
        history.push(`report rejected: ${verdict.reason} — find the answer on the page before reporting`);
        record(false, `report rejected (${reportRejections}/${MAX_REPORT_REJECTIONS}): ${verdict.reason}`, {
          answer: verdict.answer,
        });
        if (reportRejections >= MAX_REPORT_REJECTIONS) {
          incomplete = `the model reported an answer ${reportRejections} times, but ${verdict.reason}`;
          stop = "blocked";
          break;
        }
        continue;
      }
      if (decision.op === "blocked") {
        // The page says work is under way (#92): "blocked" is premature while a job the page reports
        // is still running. Code defers it into a bounded job wait; past the budget it stands.
        const job = await readInProgressStatus(page);
        if (job !== null && jobWaitedMs < jobWaitMs) {
          const w = await waitOutJob(page, Math.min(jobWaitMs - jobWaitedMs, JOB_WAIT_SLICE_MS));
          jobWaitedMs = w.cleared ? 0 : jobWaitedMs + w.waitedMs;
          const note = `blocked deferred: the page shows ${job} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
            w.cleared ? "the status cleared" : `still in progress; ${Math.round(jobWaitedMs / 1000)}s of the ${Math.round(jobWaitMs / 1000)}s job-wait budget used`
          })`;
          history.push(note);
          record(true, note, { op: "wait" });
          idleSteps = 0;
          idleSince = null;
          quietWaits = 0;
          lastActedOp = "wait";
          statusAfter = "waiting";
          continue;
        }
        record(true, "model blocked");
        // #235: a control the goal needed may have been refused — the reason says so, actionably.
        incomplete = `the model reported the goal cannot be advanced from this page${lastRefusal === null ? "" : ` (${lastRefusal})`}`;
        stop = "blocked";
        break;
      }

      const control = decision.control;
      if (overlay !== null && (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait" || decision.op === "reload")) {
        await overlay.announce(page, { step: transcript.nextStep, strategy: "goal", op: decision.op, why: overlayWhy });
      }
      if (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait") {
        // No recorded mutation — but visible to history (J-4), and an idle streak is a stuck signal.
        let changed: boolean;
        let note: string;
        if (decision.op === "wait" && awaitingReply && lastTurn !== null && busyWaitedMs < replyWaitMs) {
          // Still listening for the last message's reply (a slow LLM turn): this wait keeps
          // listening, bounded by what is left of the reply wait, and records the reply if it lands.
          const t0 = now();
          const listen = Math.min(replyWaitMs - busyWaitedMs, 20_000);
          const reply = await waitForReply(page, { secrets, ...lastTurn, timeoutMs: listen, ceilingMs: listen });
          busyWaitedMs += now() - t0;
          if (reply.received) {
            conversation.latestReply = reply.text;
            replies.add(snap.url, reply.text);
            awaitingReply = false;
            busyWaitedMs = 0;
          }
          note = reply.received
            ? `waited ${((now() - t0) / 1000).toFixed(1)}s → reply: ${quote(reply.text, 300)}`
            : `waited ${((now() - t0) / 1000).toFixed(1)}s (the reply is still on its way)`;
          changed = true;
          quietWaits = 0;
          record(true, note, reply.received ? { reply } : {});
        } else if (decision.op === "wait" && jobWaitedMs < jobWaitMs && (await readInProgressStatus(page)) !== null) {
          // The page shows an in-progress status (#92: "Simulating…", aria-busy, a job "is running")
          // — pending work even with no request in flight (the app polls). Wait it out with backoff,
          // bounded by the job-wait budget: patience, never "nothing is pending".
          const job = (await readInProgressStatus(page)) ?? "an in-progress status";
          const w = await waitOutJob(page, Math.min(jobWaitMs - jobWaitedMs, JOB_WAIT_SLICE_MS));
          jobWaitedMs = w.cleared ? 0 : jobWaitedMs + w.waitedMs;
          note = `waited ${(w.waitedMs / 1000).toFixed(1)}s (${
            w.cleared
              ? `the in-progress status ${job} cleared`
              : `the page still shows ${job} — the app is still working; ${Math.round(jobWaitedMs / 1000)}s of the ${Math.round(jobWaitMs / 1000)}s job-wait budget used`
          })`;
          changed = true;
          quietWaits = 0;
          record(true, note);
        } else if (decision.op === "wait") {
          const t0 = now();
          changed = await waitForChange(page, waitOpMs);
          // No change while the app is still busy (a request in flight, a spinner) is patience —
          // a slow reply — not idleness: it does not count toward the idle cap.
          // Bounded: patience lasts as long as a conversational reply may take (`replyWaitMs`).
          // A sent message whose reply has not arrived yet is also still in flight.
          const pending =
            !changed && (awaitingReply || (await stillBusy(page)) || (await readInProgressStatus(page)) !== null);
          const busy = pending && busyWaitedMs < replyWaitMs;
          busyWaitedMs = busy ? busyWaitedMs + (now() - t0) : 0;
          // Nothing changed and nothing is pending: waiting again cannot help (#79).
          quietWaits = changed || pending ? 0 : quietWaits + 1;
          note = `waited ${((now() - t0) / 1000).toFixed(1)}s (${
            changed
              ? "the page changed"
              : busy
                ? "no change yet — the app is still working"
                : pending
                  ? "the page did not change"
                  : "the page did not change and nothing is pending — waiting again will not help"
          })`;
          if (busy) changed = true;
          record(true, note);
        } else {
          quietWaits = 0;
          // #109 — act() itself polls the scroll position (of the nearest scrollable container under
          // the pointer, else the window) until it settles, so this never reads immediately after the
          // wheel event before the scroll it dispatched has actually happened.
          const r = await act(cfg.actor, { op: decision.op, control: null });
          changed = r.moved === true;
          lastScrollMoved = r.ok && changed;
          note = `${decision.op === "scroll_down" ? "scrolled down" : "scrolled up"} (${changed ? "the page moved" : "the page did not move — nothing more that way"})`;
          record(r.ok, r.ok ? note : r.reason);
        }
        history.push(note);
        if (changed) {
          idleSteps = 0;
      idleSince = null;
          idleSince = null;
        } else {
          idleSteps += 1;
          idleSince = idleSince ?? now();
        }
        lastActedOp = decision.op;
        statusAfter = decision.op === "wait" ? "waiting" : "scrolling";
        if (quietWaits >= MAX_QUIET_WAITS) {
          const cause = blockingCause();
          incomplete = `stuck: ${cause ?? `${quietWaits} waits changed nothing and nothing was pending`}`;
          stop = "no-progress";
          break;
        }
        // Stuck = several idle steps AND for as long as a slow reply may take (`replyWaitMs`): a long
        // simulation or LLM turn gets that long before the run gives up on it.
        if (idleSteps >= MAX_IDLE_STEPS && idleSince !== null && now() - idleSince >= replyWaitMs) {
          incomplete = `stuck: ${idleSteps} wait/scroll steps over ${Math.round((now() - (idleSince ?? now())) / 1000)}s changed nothing`;
          stop = "no-progress";
          break;
        }
        continue;
      }
      idleSteps = 0;
      quietWaits = 0;

      if (decision.op === "reload") {
        // A reload is a navigation to the same page: recorded as such (replay re-loads the page),
        // and it counts as an action. Returning to the state the page had is its point, never a stall.
        if (!tracker.mayAct()) {
          record(false, "action budget exhausted", { origin: "engine" });
          stop = "exhausted";
          break;
        }
        // A write this run fired is still in flight (a job it started): reloading now abandons it and
        // invites a duplicate. Observe until it resolves instead (#92).
        if (sideEffects.inflight().length > 0) {
          const what = sideEffects
            .inflight()
            .map((w) => `${w.method} ${w.path}`)
            .join(", ");
          const w = await awaitWrites(monitorFor(page), sideEffects, replyCeilingMs);
          const note = `reload deferred: ${what} (sent by an earlier click) is still in flight — waited ${(w.waitedMs / 1000).toFixed(1)}s, ${
            w.resolved ? "it resolved" : "it is still in flight"
          }`;
          history.push(note);
          record(false, note, { origin: "engine" });
          lastActedOp = decision.op;
          continue;
        }
        const at = now();
        effectLog.mark(transcript.nextStep, "reload");
        cfg.onAction?.({ step: transcript.nextStep, at });
        readOnly?.beginAction();
        const r = await act(cfg.actor, { op: "reload", control: null });
        if (r.ok) {
          recorder.navigate(page.url(), at);
          track.lastMutation = { at, before: snap.signature, seenBefore: new Set(seen), label: "reload", recordIndex: recorder.stepCount - 1, sawNewState: false };
          track.lastRecordedTarget = null;
          tracker.countAction();
          // A reload retries the last submit: retyping what it sent is a retry, not a repeat (#184).
          valueLog.reloaded();
          save.reset();
          history.push(r.note === undefined ? "reloaded the page" : `reloaded the page (${r.note})`);
        } else {
          history.push(`reload failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason ?? r.note);
        lastActedOp = decision.op;
        continue;
      }

      // Target-requiring op with no valid target → fail-closed.
      if (control === null || decision.targetMissing) {
        record(false, "no valid target (fail-closed)", { origin: "engine" });
        stop = "blocked";
        break;
      }
      if (!tracker.mayAct()) {
        record(false, "action budget exhausted", { origin: "engine" });
        stop = "exhausted";
        break;
      }
      // #158 — a read-only (find-out) goal: code refuses a control that would start a write flow,
      // submit a form, send a message or upload. Refused before any interaction, recorded, told.
      if (readOnly !== null) {
        const refusal = readOnly.refuses(decision.op, control);
        if (refusal !== null) {
          history.push(refusal);
          record(false, refusal, { origin: "engine" });
          lastActedOp = decision.op;
          continue;
        }
      }
      // The shared safety policy (#116): a session-ending, destructive, paid or --deny'd control is
      // never clicked unless the goal itself asks for it (or --allow-destructive). Refused, recorded.
      if (decision.op === "click") {
        const unsafe = safety.refuses(control);
        if (unsafe !== null) {
          refusedKeys.add(keyOf(control));
          lastRefusal = unsafe.reason;
          history.push(unsafe.reason);
          record(false, unsafe.reason, { origin: "engine" });
          lastActedOp = decision.op;
          continue;
        }
      }
      // #245: the demo overlay says what is about to happen and highlights the target (display only) —
      // before the action's attribution window opens, so its brief pause never counts as the action's.
      if (overlay !== null) {
        await overlay.announce(
          page,
          { step: transcript.nextStep, strategy: "goal", op: decision.op, target: control.name || control.summary, why: overlayWhy },
          control,
        );
      }

      const at = now();
      const risk = safety.riskOf(control);
      effectLog.mark(transcript.nextStep, control.name || control.summary, risk);
      cfg.onAction?.({ step: transcript.nextStep, at });
      readOnly?.beginAction();

      // #150 — mission spend budget, pre-action: a paid control (#116) whose declared cost estimate
      // would cross what remains of the budget is refused BEFORE it fires — code decides, never the
      // model. The refusal is recorded and the run stops cleanly with `stop: "budget"`.
      if (cfg.onBeforeAction !== undefined) {
        const guard = await cfg.onBeforeAction({ op: decision.op, control: control.name || control.summary, paid: risk === "paid" });
        if (guard.refuse) {
          history.push(guard.reason);
          record(false, guard.reason, { origin: "engine" });
          incomplete = guard.reason;
          stop = "budget";
          break;
        }
      }

      // An EMPTY bound secret field (#111) is typed by code on its own — before a submit of its form,
      // or once a validation message names it: the model cannot see the value and was seen never
      // choosing `type` on it (a signup stuck on "Password: Please fill out this field"). Same
      // guarantees as the chosen-`type` path below: placeholder only, Recording `{ redacted: true }`.
      {
        const submitting = decision.op === "click" && submitsAForm(control) ? control : null;
        const due = secretFieldsToFill(snap.controls, cfg.secretFields, {
          submitting,
          status,
          exclude: decision.op === "type" ? control : null,
        });
        for (const { control: field, field: binding, why } of due) {
          if (!tracker.mayAct() || !(await secretFieldNeedsValue(page, field))) continue;
          const t = now();
          const value = secretFieldValue(binding, t);
          const placeholder = secretPlaceholder(binding);
          const r = await act(cfg.actor, { op: "type", control: field, value });
          const cause = why === "submit" ? `before submitting with ${control.name || control.summary}` : "a validation message names it";
          if (r.ok) {
            recorder.fill(field.descriptor, { redacted: true, length: value.length }, t);
            noteMutation(`type ${field.name}`, field.descriptor, snap.signature, t);
            tracker.countAction();
            history.push(`typed ${placeholder} into the empty ${field.name} (bound secret, typed by code — ${cause})`);
          } else {
            history.push(`type into ${field.name} failed: ${(r.reason ?? "?").split(value).join(placeholder)}`);
          }
          record(r.ok, r.ok ? `typed ${placeholder} (bound secret, typed by code — ${cause})` : (r.reason ?? "").split(value).join(placeholder), {
            op: "type",
            control: field,
            strategy: "secret-field",
            value: placeholder,
          });
        }
      }

      // A bound secret field (#72): code types the real value (a TOTP code is computed now); the model,
      // history and transcript see only the placeholder, the Recording `{ redacted: true }`.
      const bound = decision.op === "type" ? boundSecretField(control, cfg.secretFields) : null;
      if (bound !== null) {
        const value = secretFieldValue(bound, at);
        const placeholder = secretPlaceholder(bound);
        const r = await act(cfg.actor, { op: "type", control, value });
        if (r.ok) {
          recorder.fill(control.descriptor, { redacted: true, length: value.length }, at);
          noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value });
          tracker.countAction();
          history.push(`typed ${placeholder} into ${control.name} (bound secret, typed by code)`);
        } else {
          history.push(`type failed: ${(r.reason ?? "?").split(value).join(placeholder)}`);
        }
        record(r.ok, r.ok ? `typed ${placeholder} (bound secret, typed by code)` : (r.reason ?? "").split(value).join(placeholder), {
          value: placeholder,
        });
        lastActedOp = decision.op;
        continue;
      }

      // An edit INSIDE rich text (#148): the generator proposes an anchored edit, code validates it
      // (see ./rich-text.ts) and the shared page function performs it — never a whole retype.
      if (decision.op === "edit_text") {
        const planned =
          boundSecretField(control, cfg.secretFields) !== null
            ? { refused: "a bound secret field is never edited as rich text" }
            : await readEditableText(page, control).then((currentText) =>
                currentText === null
                  ? { refused: "the element's text could not be read" }
                  : planTextEdit(cfg.gen, { goal: cfg.goal, control, currentText, history, secrets }),
              ).catch((e: unknown) => ({ refused: `edit generation unavailable: ${firstLine(e)}` }));
        if ("refused" in planned) {
          history.push(`edit in ${control.name || control.summary} refused: ${planned.refused}`);
          record(false, planned.refused, { origin: "engine" });
        } else {
          const r = await act(cfg.actor, { op: "edit_text", control, edit: planned.edit });
          const what = describeTextEdit(planned.edit);
          if (r.ok) {
            recorder.editText(control.descriptor, planned.edit, at);
            noteMutation(`edit ${control.name}`, control.descriptor, snap.signature, at);
            tracker.countAction();
            history.push(`${what} in ${control.summary.slice(0, 80)}`);
            cleared(control);
          } else {
            history.push(`edit failed: ${failNote(r.reason, control)}`);
          }
          record(r.ok, r.ok ? what : failNote(r.reason, control), planned.edit.value === undefined ? {} : { value: planned.edit.value });
        }
        lastActedOp = decision.op;
        continue;
      }

      // The repeated-type anti-pattern (independent code): typing again into a field that holds text
      // this run typed and never sent overwrites it and still delivers nothing. Submit instead, and
      // count it as a stuck signal.
      let op = decision.op;
      let forcedNote: string | null = null;
      if (op === "type" && unsent.wouldRepeat(keyOf(control))) {
        const n = unsent.noteRepeat();
        forcedNote = `repeated type into ${control.name} without sending (stuck signal ${n}/${MAX_REPEAT_TYPE_SIGNALS}) — sent instead`;
        if (n >= MAX_REPEAT_TYPE_SIGNALS) {
          record(false, forcedNote, { origin: "engine" });
          incomplete = `stuck: typed into ${quote(control.name, 60)} ${n} times without sending`;
          stop = "no-progress";
          break;
        }
        if (sendable(control)) op = "send";
      }

      // Messages (a `send`, or typing into a message-shaped field) are conversation turns: generated
      // by `chat.reply` from the latest reply, capped, and never a repeat of an earlier message.
      const isMessage =
        op === "send" || (op === "type" && sendable(control));
      if (isMessage) {
        // Stuck detection (independent code, #122): the last user turns only acknowledged / promised,
        // or said the same thing again. The next turn is generated with the stuck brief (answer the
        // assistant's question with a concrete fact or choice), the decision is pointed at the
        // page's call to action, and a conversation still stuck after that ends the run.
        const stuck = repetitiveTurns(conversation.sent);
        stuckTurns = stuck ? stuckTurns + 1 : 0;
        if (stuckTurns > STUCK_TURNS) {
          const reason = `stuck: the messages kept acknowledging or repeating without answering the assistant (still after ${STUCK_TURNS} nudged turns)`;
          record(false, reason, { op });
          incomplete = reason;
          stop = "no-progress";
          break;
        }
        let text: string | null;
        try {
          text = await chatReply(cfg.gen, {
            goal: cfg.goal,
            fieldLabel: control.name || control.summary,
            latestReply: conversation.latestReply,
            sentMessages: conversation.sent,
            maxChars: replyMaxChars,
            secrets,
            question: lastQuestion(conversation.latestReply),
            stuck,
          });
        } catch (e) {
          const reason = `message generation unavailable: ${firstLine(e)}`;
          history.push(`${op} skipped: ${reason}`);
          record(false, reason, { op, origin: "engine" });
          lastActedOp = op;
          continue;
        }
        if (text === null) {
          blockers.failClosed = `no message for ${quote(control.name || control.summary, 80)} (the message generator returned none)`;
          record(false, "no message available (fail-closed)", { op, origin: "engine" });
          incomplete = "no message could be generated for the conversation";
          stop = "blocked";
          break;
        }
        const message = text;
        if (conversation.sent.some((m) => sameMessage(m, message))) {
          const n = unsent.noteRepeat();
          const reason = `message not sent: it repeats an earlier message (stuck signal ${n}/${MAX_REPEAT_TYPE_SIGNALS})`;
          history.push(`${reason} — answer the latest reply with something new`);
          record(false, reason, { op, message, origin: "engine" });
          lastActedOp = op;
          if (n >= MAX_REPEAT_TYPE_SIGNALS) {
            incomplete = "stuck: the generated messages kept repeating";
            stop = "no-progress";
            break;
          }
          continue;
        }
        if (op === "send") {
          const baseline = await readPageText(page, secrets);
          const before = new Set(keys.keys());
          const r = await act(cfg.actor, { op: "send", control, value: message, candidates: snap.controls });
          if (!r.ok) {
            history.push(`send failed: ${r.reason ?? "?"}`);
            record(false, forcedNote === null ? r.reason : `${forcedNote}; ${r.reason ?? ""}`, { op, message });
            lastActedOp = op;
            continue;
          }
          recorder.fill(control.descriptor, message, at);
          const via = r.submittedVia;
          if (via !== undefined && via.kind === "click") recorder.click(via.control.descriptor, now());
          else recorder.press("Enter", control.descriptor, now());
          noteMutation(`send ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: message });
          tracker.countAction();
          unsent.submitted();
          conversation.sent.push(message);
          preSend ??= baseline;
          const reply = await waitForReply(page, { secrets, baseline, sent: message, timeoutMs: replyWaitMs, ceilingMs: replyCeilingMs });
          if (reply.received) {
            conversation.latestReply = reply.text;
            replies.add(snap.url, reply.text);
          }
          awaitingReply = !reply.received;
          busyWaitedMs = reply.waitedMs;
          lastTurn = { baseline, sent: message };
          offerBaseline = before;
          history.push(
            `sent ${quote(message)} via ${via?.kind === "click" ? `"${via.control.name}"` : "Enter"} → ` +
              (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
          );
          noteStuckConversation(snap.controls);
          record(true, forcedNote ?? undefined, { op, message, reply });
          lastActedOp = op;
          continue;
        }
        // A plain `type` of a message: typed, NOT sent yet (the Send control or Enter still has to follow).
        const r = await act(cfg.actor, { op: "type", control, value: message });
        if (r.ok) {
          recorder.fill(control.descriptor, message, at);
          noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: message });
          tracker.countAction();
          unsent.typed(keyOf(control), control.name, message, true);
          history.push(`typed ${quote(message, 80)} into ${control.name} — NOT sent yet (send it)`);
        } else {
          history.push(`type failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason, { message });
        lastActedOp = op;
        continue;
      }

      if (op === "send") {
        // Not message-shaped after all (unreachable: `send` is always a message) — fail closed.
        record(false, "send without a message (fail-closed)", { op, origin: "engine" });
        stop = "blocked";
        break;
      }

      if (op === "select" && control.options !== undefined && control.options.length > 0) {
        // Options-aware select (J-5): the generator sees the real options, and code selects only an
        // option the page actually has — never a guessed value.
        let text: string | null;
        try {
          ({ text } = await fillHelper.valueFor({
            fieldLabel: control.name || control.summary,
            goal: cfg.goal,
            visibleContext: snap.controls.map((c) => c.summary).join("; "),
            history,
            secrets,
            options: control.options,
          }));
        } catch (e) {
          const reason = `value generation unavailable: ${firstLine(e)}`;
          history.push(`select skipped: ${reason}`);
          record(false, reason, { origin: "engine" });
          lastActedOp = op;
          continue;
        }
        const option = text === null ? null : matchOption(text, control.options);
        if (option === null) {
          fillHelper.commit();
          const reason = `no valid option chosen for ${control.name} (fail-closed)`;
          blockers.failClosed = `no valid option for field ${quote(control.name || control.summary, 80)} (fail-closed)`;
          history.push(`select failed: ${reason}`);
          record(false, reason, { origin: "engine" });
          lastActedOp = op;
          continue;
        }
        const r = await act(cfg.actor, { op: "select", control, value: option });
        if (r.ok) {
          recorder.select(control.descriptor, option, at);
          noteMutation(`select ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: option });
          tracker.countAction();
          fillHelper.commit();
          history.push(`selected ${quote(option, 80)} in ${control.name}`);
          cleared(control);
        } else {
          history.push(`select failed: ${failNote(r.reason, control)}`);
        }
        record(r.ok, r.ok ? r.reason : failNote(r.reason, control), { value: option });
        lastActedOp = op;
        continue;
      }

      if (decision.op === "type" || decision.op === "select") {
        // The generator supplies the text/option (never the model's choice head). It is a HELPER:
        // when it is unavailable the step fails (recorded, visible to the model) and the run goes on.
        let text: string | null;
        let rejected: string | undefined;
        let source: "goal" | "model" | undefined;
        try {
          ({ text, rejected, source } = await fillHelper.valueFor({
            fieldLabel: control.name || control.summary,
            goal: cfg.goal,
            visibleContext: snap.controls.map((c) => c.summary).join("; "),
            history,
            secrets,
            // A text field's value is field-scoped and checked before it is typed (#71); in an
            // add-another flow it is the next item, not one already submitted into this field (#123).
            ...(decision.op === "type"
              ? { field: { tag: control.tag, inputType: control.inputType }, alreadyUsed: valueLog.used(control.name || control.summary) }
              : {}),
          }));
        } catch (e) {
          const reason = `value generation unavailable: ${firstLine(e)}`;
          history.push(`${decision.op} skipped: ${reason}`);
          record(false, reason, { origin: "engine" });
          lastActedOp = decision.op;
          continue;
        }
        if (rejected !== undefined) {
          // Not a value for this one field (an essay, a JSON map, a `Label:` echo…): a failed act the
          // model sees in its history, never typed.
          const reason = `typed value rejected: ${rejected}`;
          history.push(`type into ${control.name} failed: ${reason} — the value must be only what goes in this one field`);
          record(false, reason, { origin: "engine" });
          lastActedOp = decision.op;
          continue;
        }
        if (text === null) {
          // The generator will not honestly supply a required value → never guess.
          blockers.failClosed = `no value for field ${quote(control.name || control.summary, 80)} (the value generator returned none)`;
          record(false, "no value available (fail-closed)", { origin: "engine" });
          stop = "blocked";
          break;
        }
        // Free-text form values are bounded too (dogfood: 2–3k-char markdown essays in "Rationale").
        // #281: a value the goal states verbatim is typed as stated (its line breaks kept), never capped.
        if (decision.op === "type" && source !== "goal" && (control.tag === "textarea" || control.inputType === "text" || control.inputType === "")) {
          text = capMessage(text, FORM_TEXT_MAX_CHARS);
        }
        const r = await act(cfg.actor, { op: decision.op, control, value: text });
        if (r.ok) {
          if (decision.op === "type") {
            // A form field (not a message composer) is submitted with its form's own button; retyping
            // it is a correction, not the chat anti-pattern — so only composers are tracked.
            recorder.fill(control.descriptor, text, at);
            valueLog.typed(control.name || control.summary, text);
            if (!isBound(control) && !isCredentialField(control) && !sendable(control)) {
              save.noteTyped(control.name || control.summary, text);
              // #239: until a write after it succeeds, the field shows what the run entered — not grounds.
              observed.noteOwnInput(text);
            }
          } else recorder.select(control.descriptor, text, at);
          noteMutation(`${decision.op} ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: text });
          tracker.countAction();
          fillHelper.commit();
          history.push(`${decision.op === "type" ? "typed into" : "selected in"} ${control.name}`);
          cleared(control);
        } else {
          history.push(`${decision.op} failed: ${failNote(r.reason, control)}`);
        }
        record(r.ok, r.ok ? r.reason : failNote(r.reason, control), { value: text });
      } else if (decision.op === "click") {
        // A click that submits typed text (the composer's Send) or picks a quick reply offered with the
        // latest reply is a conversation turn: its reply is awaited like a `send`'s.
        const pendingTexts = [...unsent.pending().values()].filter((p) => p.message).map((p) => p.text);
        const submits = pendingTexts.length > 0 && isSubmitControl(control);
        // A quick reply: a short button that arrived with the latest reply (a chip, "Yes, draft it").
        const quickReply =
          offeredKeys.has(keyOf(control)) && control.role === "button" && control.name.length <= 60 && !/[→›»]/.test(control.name);
        const turn = submits || quickReply;
        // The repeated-side-effect guard (#92): a click that already fired a write on this page is not
        // re-fired while that write is in flight (wait for it instead) or after it went through,
        // unless the page offers a retry. Refused — never clicked — and the reason is recorded.
        const repeat = sideEffects.check(keyOf(control), safePath(snap.url), {
          controlNames: snap.controls.map((c) => c.name),
          alerts: status.alerts,
        });
        if (repeat.refuse) {
          let note = repeat.reason;
          if (repeat.inflight) {
            const w = await awaitWrites(monitorFor(page), sideEffects, replyCeilingMs);
            note += ` (waited ${(w.waitedMs / 1000).toFixed(1)}s: ${w.resolved ? "it resolved" : "it is still in flight"})`;
          }
          history.push(note);
          record(false, note, { origin: "engine" });
          lastActedOp = decision.op;
          continue;
        }
        const baseline = turn ? await readPageText(page, secrets) : "";
        sideEffects.beginClick(keyOf(control), control.name || control.summary, safePath(snap.url), now());
        const r = await act(cfg.actor, { op: "click", control });
        let reply: ReplyResult | undefined;
        let message: string | undefined;
        if (r.ok) {
          recorder.click(control.descriptor, at);
          noteMutation(`click ${control.name}`, control.descriptor, snap.signature, at, undefined, control.role === "link" ? hangRoute(snap.url) : null);
          tracker.countAction();
          if (isSubmitControl(control)) unsent.submitted();
          // What was typed has now been submitted (a form's button): an add-another flow's next
          // item must differ from it (#123).
          if (buttonLike(control) || control.submits === true) {
            valueLog.submitted();
            save.noteSubmitClick(control.name || control.summary);
          }
          // Toggling an input (a checkbox, a radio, a switch) changes what a repeat would send (#92).
          if (TOGGLE_ROLES.has(control.role) || (control.tag === "input" && control.inputType !== "submit" && control.inputType !== "button")) {
            // A radio/option now holds "selected"; a checkbox/switch flips — so toggling twice is no
            // change (#123). Clicking into a text input changes nothing it would send.
            const picks = ["radio", "option", "menuitemradio"].includes(control.role) || control.inputType === "radio";
            const flips = ["checkbox", "switch", "menuitemcheckbox"].includes(control.role) || control.inputType === "checkbox";
            if (picks) sideEffects.inputChanged(keyOf(control), "selected");
            else if (flips) sideEffects.inputChanged(keyOf(control), { toggled: true });
          }
          if (turn) {
            message = submits ? pendingTexts.join("\n") : control.name;
            conversation.sent.push(message);
            preSend ??= baseline;
            reply = await waitForReply(page, { secrets, baseline, sent: message, timeoutMs: replyWaitMs, ceilingMs: replyCeilingMs });
            if (reply.received) {
              conversation.latestReply = reply.text;
              replies.add(snap.url, reply.text);
            }
            awaitingReply = !reply.received;
            busyWaitedMs = reply.waitedMs;
            lastTurn = { baseline, sent: message };
            offerBaseline = new Set(keys.keys());
            history.push(
              `clicked ${control.name}${quickReply ? " (a quick reply)" : ""} → ` +
                (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
            );
            noteStuckConversation(snap.controls);
          } else {
            history.push(`clicked ${control.name}`);
          }
          cleared(control);
        } else {
          history.push(`click failed: ${failNote(r.reason, control)}`);
          // #90 — a real "intercepts pointer events" failure proves what covers this control (and,
          // in practice, its neighbours under the same backdrop): remember it so the model is not
          // offered another target it covers until the page changes.
          const interceptor = r.reason === undefined ? null : parseInterceptor(r.reason);
          if (interceptor !== null && !blockedInterceptors.includes(interceptor)) {
            blockedInterceptors = [...blockedInterceptors, interceptor];
            blockedSinceSignature = snap.signature;
          }
        }
        record(r.ok, r.ok ? r.reason : failNote(r.reason, control), {
          ...(message === undefined ? {} : { message }),
          ...(reply === undefined ? {} : { reply }),
        });
      } else {
        // upload — act fails closed without a fixture.
        const r = await act(cfg.actor, { op: "upload", control, fixture });
        if (r.ok && fixture !== null) {
          // The recorded path goes through the shared redaction seam: a path that
          // contains a registered secret is recorded redacted (replay then fails
          // closed) rather than persisting the secret into the artifact.
          const recordedFile: ValueOrVar =
            redactText(fixture, secrets) === fixture
              ? { redacted: false, value: fixture }
              : { redacted: true, length: fixture.length };
          recorder.upload(control.descriptor, recordedFile, at);
        noteMutation(`upload into ${control.name}`, control.descriptor, snap.signature, at);
          tracker.countAction();
          history.push(`uploaded the fixture into ${control.name}`);
          fixtureAttached = true;
          cleared(control);
        } else {
          history.push(`upload failed: ${failNote(r.reason, control)}`);
        }
        record(r.ok, r.ok ? r.reason : failNote(r.reason, control));
      }

      lastActedOp = decision.op;
    }
  } catch (e) {
    if (!(e instanceof FirstNavigationFailedSentinel)) {
      // Engine failure (browser/page crash, automation error outside `act`'s own guard): a typed
      // `crashed` stop carrying the partial transcript and Recording — the run never throws here.
      failure = describeFailure(e, crashWatch.signals());
      // #226: the app stopped answering navigation (a frozen backend) — nothing in the engine broke:
      // `inconclusive` with the typed `target-unresponsive` reason, never `crashed`.
      stop = isTargetUnresponsive(failure) ? "inconclusive" : "crashed";
    }
    // Else (#128): `stop`/`failure` were already set to `inconclusive`/`target-unreachable` at the
    // point the first navigation failed — the sentinel only unwound the loop, nothing more to do.
  }

  // #230: a no-progress stop on an app that stopped answering is `target-unresponsive` — before the
  // host is blamed for it (#203).
  if (stop === "no-progress") {
    const unresponsive = await targetStoppedAnswering(livenessOf()).catch(() => null);
    if (unresponsive !== null) {
      failure = { kind: "target-unresponsive", message: unresponsive };
      stop = "inconclusive";
    }
  }

  // #203: a no-progress stop met while the host was starved is the host, not the app.
  if (stop === "no-progress" && cfg.hostHealth !== undefined) {
    const judged = await cfg.hostHealth.judge();
    if (judged.starved !== null) degradedStop("no-progress", "the last actions left the page unchanged", judged.starved);
  }

  // #238 — the latest report's answer was "none exists", but the run never covered enough of the app
  // to establish it: it proved nothing either way — `inconclusive` (insufficient coverage), never a defect.
  if (lastAbsenceUncovered !== null && answer === undefined && (stop === "no-progress" || stop === "blocked" || stop === "exhausted") && failure === undefined) {
    failure = { kind: "insufficient-coverage", message: lastAbsenceUncovered };
    incomplete = lastAbsenceUncovered;
    stop = "inconclusive";
    lastReportNotFound = false;
  }

  // #207 — a run whose latest report found no answer, and that then stopped for want of progress or
  // gave up, ends saying so and what it searched — not a generic "no progress" / "blocked".
  if (lastReportNotFound && answer === undefined && (stop === "no-progress" || stop === "blocked") && failure === undefined) {
    incomplete = answerNotFoundReason(observed.pages());
  }

  await readOnly?.disarm();
  page.off("request", onRequestSeen);
  page.off("response", onDocumentResponse);
  const finished = recorder.tryFinish({ intent: cfg.goal });
  const cause = blockingCause();
  const finalOutcome: RunOutcome =
    stop === "done" && outcome !== null && finished.ok
      ? outcome
      : { status: "incomplete", reason: withCause(incompleteReason(stop, incomplete, failure, hang, tracker), stop, cause) };
  if (!finished.ok) {
    // The Recording itself failed its fail-closed checks (schema / a surviving secret). It is not
    // written; the run is reported crashed so this can never read as a pass.
    failure = failure ?? { kind: "exception", message: `recording rejected: ${finished.reason}` };
    stop = "crashed";
  }
  const fired = effectLog.entries();
  effectLog.close();
  if (overlay !== null) {
    const banner = finalOutcome.status === "completed" ? `jevitate · done — ${stop}` : `jevitate · ${stop} — ${finalOutcome.reason}`;
    await overlay.finish(banner, finalOutcome.status === "completed", page);
  }
  return {
    sideEffects: fired.sideEffects,
    ...(fired.truncated > 0 ? { sideEffectsTruncated: fired.truncated } : {}),
    stop,
    recording: finished.ok ? finished.recording : emptyRecording(cfg.site ?? startOrigin, finished.reason),
    transcript: transcript.entries(),
    finalUrl: redactText(redactUrl(safeUrl(page)), secrets),
    decisions: tracker.decisions,
    actions: tracker.actions,
    ...(failure === undefined ? {} : { failure }),
    heap: heap.samples(),
    timing: summarizeTimings(timings),
    ...(hang === undefined ? {} : { hang }),
    outcome: finalOutcome,
    ...(answer !== undefined && finalOutcome.status === "completed" ? { answer } : {}),
    ...(cause === null ? {} : { blockingCause: cause }),
    ...(endedOnRejectedDone && stop === "done" ? { doneRejected: true as const } : {}),
    ...(stop === "crashed" && failure !== undefined
      ? { crash: buildCrashReport(failure, crashWatch.signals(), heap.samples(), { host: await probeHost() }) }
      : {}),
  };
}

/** Why a run that did not complete ended — always a stated reason, never a silent stop. */
function incompleteReason(
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
function withCause(reason: string, stop: StopReason, cause: string | null): string {
  if (cause === null || reason.includes(cause)) return reason;
  if (stop !== "blocked" && stop !== "no-progress" && stop !== "exhausted") return reason;
  if (reason === "blocked before the goal was met") return `blocked: ${cause}`;
  return `${reason} — last blocker: ${cause}`;
}

/** The path part of a URL (navigation detection); the raw string when it does not parse. */
function safePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** `page.url()` survives a closed page, but guard it: winding down must never throw. */
function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
}

