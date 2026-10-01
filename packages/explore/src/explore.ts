import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Navigate } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import type { Page } from "playwright";
import { writeClassifier, type Recording, type ValueOrVar, type WriteClassifier } from "@jevitate/recording";
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
import { textMatcher, urlMatcher, type HangConfig, type SettleConfig, type TimingConfig } from "./settle-config.js";
import { DEFAULT_STALL_MS } from "./hang-repro.js";
import { decide, judgeGoalCompletion, type Decision } from "./decide.js";
import { AuthProgress, isCredentialField } from "./auth-completion.js";
import { SaveProgress } from "./save-completion.js";
import { FieldValueLog, FillHelper, capFormText, chatReply, goalListsSeveral, matchOption } from "./fill.js";
import { CLEARS_FIELD, isPlaceholderOption } from "./select-choice.js";
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
import { demoOverlayFor, type DemoOverlay } from "./demo-overlay.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptListener } from "./transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { CrashWatch, assertTargetAnswering, describeFailure, describeUnreachable, isPageUnresponsive, isTargetUnresponsive, isUnreachableTarget, targetStoppedAnswering, assertSeedReachable } from "./mission-failure.js";
import {
  EMPTY_STATUS,
  describeStatus,
  isEmptyStatus,
  readDocumentedWait,
  readInProgressStatus,
  readPageStatus,
  readWorkingStatus,
  statusDelta,
  type PageStatus,
} from "./status.js";
import { SafetyPolicy, type SafetyConfig } from "./safety.js";
import { NO_DESTRUCTIVE_NOTE, READ_ONLY_NOTE, ReadOnlyGuard } from "./read-only.js";
import { boundTypeFixture, markTypeFixtures, typeFixtureContext, typeFixturePlaceholder, type TypeFixture } from "./type-fixtures.js";
import { FirstPartyOrigins } from "./third-party.js";
import { HeapLog, buildCrashReport, sampleHeap, type CrashReport } from "./crash-report.js";
import { FailedActionStreak, backgroundEndpoints, openOverlayName, requestsStartedSince, writesStartedSince } from "./stuck-actions.js";
import type { HeapSample } from "@jevitate/domain";
import { ActionDeltas, deltaPromptLine, deltaQuotableText, deltaRecord, type ActionDeltaStats, type DeltaVerdict } from "./action-delta.js";
import * as limits from "./goal-loop/limits.js";
import {
  EXPECTED_RETURN,
  FirstNavigationFailedSentinel,
  JOB_WAIT_SLICE_MS,
  MAX_EARLY_BLOCKED_REFUSALS,
  MAX_TYPE_NO_EFFECT,
  TOGGLE_ROLES,
  TOO_MANY_CHOICES,
  TOO_MANY_CHOICES_RETRY,
  buttonLike,
  documentedWaitBudgetMs,
  fieldValuesOf,
  firstLine,
  incompleteReason,
  isActionOrChromeName as actionOrChromeName,
  keyOf,
  liveBusyWork,
  noReply,
  quote,
  safePath,
  safeUrl,
  savedAndLeft,
  searchLike,
  stateBesides,
  stillShowsWork,
  submitsAForm,
  waitOutJob,
  withCause,
} from "./goal-loop/helpers.js";

export type { TranscriptEntry } from "./transcript.js";
export type { RunOutcome } from "./conversation.js";

// The public limits are defined in ./goal-loop/limits.ts (the loop's step modules read them there)
// and re-declared here under the same names, so the package's export surface is unchanged (#232).
/** Default cap (chars) on a generated chat message. */
export const REPLY_MAX_CHARS = limits.REPLY_MAX_CHARS;
/** Default bound (ms) a `wait` decision waits for the page to change. */
export const WAIT_OP_MS = limits.WAIT_OP_MS;
/** Consecutive `wait`/`scroll` steps that change nothing before the run stops as no-progress. */
export const MAX_IDLE_STEPS = limits.MAX_IDLE_STEPS;
/** Cap (chars) on a generated free-text form value. */
export const FORM_TEXT_MAX_CHARS = limits.FORM_TEXT_MAX_CHARS;
/** Rejected `done` proposals before the run stops incomplete. */
export const MAX_DONE_REJECTIONS = limits.MAX_DONE_REJECTIONS;
/** Rejected (ungrounded) `report` answers before the run stops incomplete (#101). */
export const MAX_REPORT_REJECTIONS = limits.MAX_REPORT_REJECTIONS;
/** Repeated-type (typed, never sent, typed again) signals before the run stops as no-progress. */
export const MAX_REPEAT_TYPE_SIGNALS = limits.MAX_REPEAT_TYPE_SIGNALS;
/**
 * Consecutive `wait`s that changed nothing while NOTHING was pending (no request in flight, no busy
 * indicator, no awaited reply) before the run stops as stuck, naming what the page shows (#79).
 */
export const MAX_QUIET_WAITS = limits.MAX_QUIET_WAITS;
/**
 * Consecutive scrolls that MOVED the page (with no new page state) that count as progress (#172):
 * scrolling to read a long page is progress until the end is reached; past this bound (e.g. a
 * scroll up/down loop) a moved scroll counts as an unchanged step again.
 */
export const MAX_MOVING_SCROLLS = limits.MAX_MOVING_SCROLLS;
/** The one "last chance" turn the model gets before a no-progress stop (#172). */
export const LAST_CHANCE_NOTE = limits.LAST_CHANCE_NOTE;

/**
 * #223: a control whose name is an action or a label, not page content: every non-link control
 * (buttons, submit/reset inputs, form fields — named by their labels) and a chrome link (in a
 * nav / header / footer landmark, or repeated across pages). A link in the page's content — a list,
 * a table, a card — is content: its text may be the answer ("the title of the first item").
 * (Implemented in ./goal-loop/helpers.ts, #232.)
 */
export function isActionOrChromeName(c: Control, chrome: ChromeTracker): boolean {
  return actionOrChromeName(c, chrome);
}


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
  /**
   * #293 journey-anchored exploration: the page is ALREADY at the start state (a Journey's prefix was
   * replayed into this session — page, form contents, session kept), so the first navigation to
   * `startUrl` is skipped. The Recording still begins with a navigate to `startUrl` (where a replay
   * of a finding starts). Default: navigate.
   */
  readonly startInPlace?: boolean;
  readonly bounds?: Partial<Bounds>;
  /**
   * #271: the token a model-invented email / username gains so it is unique to this run (a sign-up
   * goal never collides with an account an earlier run created). Random per run unless pinned.
   */
  readonly identityToken?: string;
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
   * #270: a goal with no success check that asks for a change (so not `readOnly`) still never
   * performs a DESTRUCTIVE write: code refuses a destructive control (no goal-word lift) and aborts a
   * destructive write request (`DELETE`, `Remove*`/`Delete*`… RPCs) an action fires. Set by the goal
   * mission unless `--allow-writes` / `--allow-destructive`; ignored when `readOnly` is set.
   */
  readonly noDestructiveWrites?: boolean;
  /**
   * #281: fields bound to a file's exact text (`--type-fixture`): when the loop chooses `type` on a
   * bound control, code types the text verbatim (no value generator, no cap). See `type-fixtures.ts`.
   */
  readonly typeFixtures?: readonly TypeFixture[];
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
  /**
   * #303 — action deltas (OPT-IN, off by default): after each action, what changed on the page
   * (code's verdict `no-change` / `relevant-change` / `inconclusive`), attached to the transcript and
   * the Recording, told to the model, and then the ONLY input that may count an action toward
   * no-progress. Off (absent / `false`): nothing is captured, nothing is added to any prompt, and
   * the page signature alone decides no-progress, exactly as before. `jev: true` adds Jev's
   * advisory relevance labels; `volatilityGapMs` is the route baseline's no-action gap.
   */
  readonly actionDeltas?: boolean | { readonly jev?: boolean; readonly volatilityGapMs?: number };
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
  /** #303: the run's action deltas — verdict counts and the per-action overhead (absent when off). */
  readonly actionDeltas?: ActionDeltaStats;
}

/** The goal loop's run state (#232): every closure variable of `explore()`, one field each, names unchanged. */
interface RunContext {
  readonly startOrigin: string;
  readonly fixture: string | null;
  readonly secrets: string[];
  readonly secretContext: string | null;
  readonly missionContext: string | undefined;
  readonly bounds: Bounds;
  readonly tracker: BoundsTracker;
  readonly noProgress: NoProgressDetector;
  readonly fillHelper: FillHelper;
  readonly recorder: RunRecorder;
  readonly page: Page;
  readonly crashWatch: CrashWatch;
  readonly heap: HeapLog;
  readonly probeHost: HostProbe;
  /** #203: the fresh host sample around a finding, and whether the run's sampler calls it starved. */
  readonly judgeHost: () => Promise<HostJudgment>;
  /** #203: a finding the starved host explains ends the run `inconclusive`, never as a hang. */
  readonly degradedStop: (finding: "hang" | "no-progress", detail: string, starved: string) => void;
  /**
   * #230: before a hang/no-progress is a finding (or blamed on a starved host), did the app itself
   * stop answering? Throws `TargetUnresponsiveError` (→ `inconclusive` / `target-unresponsive`).
   */
  readonly livenessOf: () => { pageUrl: string; authorized: (u: string) => boolean; };
  readonly now: () => number;
  readonly transcript: TranscriptLog;
  readonly history: string[];
  /** #245: the demo overlay (null unless `demoOverlay`) — display only, never an input to the loop. */
  readonly overlay: DemoOverlay | null;
  readonly overlayWhy: string;
  stop: StopReason;
  failure: MissionFailure | undefined;
  lastActedOp: string | null;
  /** #172: did the last scroll move the page, and how many moved scrolls in a row on one state. */
  lastScrollMoved: boolean;
  movingScrolls: number;
  movingScrollsSignature: string | null;
  /** #172: the no-progress last-chance turn was given (it is given once per run). */
  lastChanceGiven: boolean;
  /** #172: this decision is the last-chance turn. */
  lastChanceTurn: boolean;
  fixtureAttached: boolean;
  hang: ExploreRun["hang"];
  outcome: RunOutcome | null;
  /** Why the run ended incomplete, when a specific detector ended it. */
  incomplete: string | null;
  /** #209: stopped because every `done` the model proposed was rejected. */
  endedOnRejectedDone: boolean;
  readonly unsent: UnsubmittedTypeTracker;
  readonly conversation: { latestReply: string | null; sent: string[] };
  /** Consecutive message generations made while the conversation was stuck (#122). */
  stuckTurns: number;
  /** The current stuck episode was already told to the decision (#122). */
  stuckNoted: boolean;
  /**
   * After a user turn went out (#122): when the conversation is now stuck on content-free / repeated
   * turns, the NEXT decision is told so once per episode — answer concretely, or take the page's
   * call to action toward the goal.
   */
  readonly noteStuckConversation: (controls: readonly Control[]) => void;
  /** The values this run typed into each form field, and which were submitted (#123). */
  readonly valueLog: FieldValueLog;
  /** Controls present just before a message was sent — the next snapshot's new ones were offered with the reply. */
  offerBaseline: Set<string> | null;
  offeredKeys: Set<string>;
  doneRejections: number;
  reportRejections: number;
  /** The visible text of every page state observed — what a reported answer is grounded against (#101). */
  readonly observed: ObservedPages;
  /**
   * #200 — a goal about a conversational reply (`goalAsksForReply`, code-side) is reported from, and
   * grounded on, ONLY text that appeared after the run's first send: each observed state's text minus
   * the pre-send snapshot and the run's own messages, plus every reply the reply wait read. A chat
   * panel's intro / placeholder copy, on screen before the conversation, is never a reply.
   */
  readonly replyGoal: boolean;
  /**
   * #207 — a find-out goal (read-only, #158; not a reply goal, #200) is answered from page text: its
   * decisions carry the page's visible text, and a model `blocked` on a page state is first turned
   * into one grounded report attempt there (the answer may be plain text no control carries).
   */
  readonly findOut: boolean;
  /** #207: page states whose `blocked` was already turned into a report attempt (once per state). */
  readonly blockedReported: Set<string>;
  /** #207: the latest report attempt found no answer — the run's end reason then names the pages seen. */
  lastReportNotFound: boolean;
  /** #238: the latest report's "none exists" was below the coverage floor (its reason), else null. */
  lastAbsenceUncovered: string | null;
  /** #239: the last click whose window was settled, and whether any click's writes all succeeded (2xx). */
  settledClick: ReturnType<SideEffectGuard["lastClick"]>;
  wroteOk: boolean;
  /** #239: a write goal ("record a decision…") is not settled by a report before the run saved anything. */
  readonly writeGoal: boolean;
  readonly vetoes: VetoedAnswers;
  readonly replies: ObservedPages;
  /** The page text just before the run's first message was sent (null until one is sent). */
  preSend: string | null;
  readonly noteReplyText: (url: string, pageText: string) => void;
  /** The grounded answer a `report` ended the run with. */
  answer: RunAnswer | undefined;
  /** Page states already goal-checked on the decision's "already met" signal (once each, #91). */
  readonly goalChecked: Set<string>;
  /** The run's own sign-in steps and the sign-in completion code observes on each state (#188). */
  readonly auth: AuthProgress;
  /** #225: the run's own typed-and-submitted form values, for the code-observed save signal. */
  readonly save: SaveProgress;
  readonly isBound: (c: Control) => boolean;
  idleSteps: number;
  idleSince: number | null;
  /** How long consecutive `wait`s have waited on a still-busy app (bounded by `replyWaitMs`). */
  busyWaitedMs: number;
  /** The last message sent got no reply yet (a slow LLM turn): `wait`s are patience, bounded. */
  awaitingReply: boolean;
  /** The page text before the last message, and the message — to keep listening for its reply. */
  lastTurn: { baseline: string; sent: string; sentAt: number; background: ReadonlySet<string> } | null;
  /**
   * #241 × #283: endpoints the run's own conversation turns wrote to (the chat's POST). Never the
   * page's background polling: the next turn's write to the same endpoint is that turn's own work.
   */
  readonly turnWrites: Set<string>;
  lastPath: string | null;
  readonly listsSeveral: boolean;
  readonly nextFrom: Map<string, string[]>;
  prevSignature: string | null;
  /** The page's status text (alerts, invalid fields) at the latest perception (#79). */
  status: PageStatus;
  /** The step whose effect the next status read reports ("after <step>: alert …"). */
  statusAfter: string | null;
  /** Consecutive `wait`s that changed nothing while nothing was pending. */
  quietWaits: number;
  /**
   * CSS selectors (parsed from a Playwright "intercepts pointer events" failure, #90) for elements
   * proven to cover a real click. Every control they still cover is withheld from the model until the
   * page state changes — a click failure otherwise burns the whole run re-choosing the same or a
   * sibling target under the same backdrop.
   */
  blockedInterceptors: readonly string[];
  /** The page signature blocked interceptors were recorded against — cleared once it changes. */
  blockedSinceSignature: string | null;
  /**
   * Controls the shared safety policy (#116) has refused this run (#168): once refused, a control is
   * withheld from the model's candidates for the rest of the run — same as the interceptor-blocked
   * set above — so a re-decide never re-chooses the same refused control.
   */
  readonly refusedKeys: Set<string>;
  /** #235: the latest safety refusal's reason (named when the model then gives up), else null. */
  lastRefusal: string | null;
  /**
   * #272 / #294: real actions that failed, in a row — a covered / unreachable target is withheld
   * after its second failure, and `MAX_FAILED_ACTIONS` failures in a row end the run, whatever the
   * page signature did meanwhile (a failed click that scrolls the page can flicker it).
   */
  readonly failedActs: FailedActionStreak;
  /**
   * #242: the last plain `type` into a form field, judged at the next perception — did anything
   * besides that field's own value change (a request, another control)? — and how many such types in
   * a row into the same field changed nothing else.
   */
  typeProbe: { key: string; label: string; at: number; background: Set<string>; state: string } | null;
  typeNoEffect: { key: string; count: number } | null;
  /**
   * #242 × #241: a type credited ONLY with requests to endpoints the page had not been seen requesting
   * yet (a background poll's FIRST tick can land in any action's window). Held, not trusted: once the
   * next type into the same field finds those endpoints are the page's background traffic, the
   * credited type was no effect either and the streak resumes instead of restarting.
   */
  typeCredit: { key: string; count: number; endpoints: readonly string[] } | null;
  /** #237: actions the run attempted (any target op or reload, landed or not), and early `blocked`s refused. */
  actionAttempts: number;
  earlyBlocked: number;
  /**
   * #276: steps since the last executed page-changing action that were jevitate's own refusals, or
   * scrolls that moved the page (the app answered them). A stall over such steps is the run's (nothing it tried reached the app), never an app
   * `ui-no-progress` hang.
   */
  refusedSinceMutation: number;
  scrollsSinceMutation: number;
  /** The concrete causes the run ran into, for a precise stop reason (#84). */
  readonly blockers: { failClosed: string | null; target: { key: string; text: string } | null };
  /**
   * The most concrete cause known now, in #84's priority order; null when there is none. An invalid
   * field is named ONLY when the last action taken was a click that sent no request at all (#130a) —
   * the shape of a form submit the browser's own validation silently blocked. A click that DID send a
   * request (even to the wrong endpoint — a `--success` typo, say) clears the field as the blocker: an
   * unrelated field's stale `:invalid` state elsewhere on the page never gets blamed for that. An
   * error toast/alert is preferred over a field either way.
   */
  readonly blockingCause: () => string | null;
  /**
   * A failed act's reason as the model sees it: a disabled / hidden target is named (its accessible
   * name often says why — "Analyze — enter a URL first"), and remembered as a blocker (#79, #84).
   */
  readonly failNote: (reason: string | undefined, c: Control) => string;
  /** A control acted on successfully is no longer the blocker. */
  readonly cleared: (c: Control) => void;
  /**
   * #272 / #294: a REAL action on `c` failed (act ran, `ok: false`). Tells the model when the target
   * is withheld; returns true when the run must stop (`stop` / `incomplete` are set) — too many
   * failed actions in a row, naming the overlay that covers the page when there is one.
   */
  readonly noteFailedAct: (c: Control, reason: string | undefined) => Promise<boolean>;
  readonly replyWaitMs: number;
  readonly replyCeilingMs: number;
  readonly replyMaxChars: number;
  readonly waitOpMs: number;
  /** Every page state seen so far (for "the action sent the page back to an earlier state"). */
  readonly seen: Set<string>;
  /** The last executed page-changing action: when, from which state, and its Recording index. */
  readonly track: {
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
      /** #289: ANY click — the route it was clicked on (null for any other action). */
      clickFromRoute?: string | null;
    } | null;
    /** The raw descriptor of the last RECORDED action's target, to check it is still on the page. */
    lastRecordedTarget: string | null;
  };
  readonly goalText: string;
  readonly perceiveOpts: { timingConfig?: TimingConfig | undefined; hangConfig?: HangConfig | undefined; settleConfig?: SettleConfig | undefined; requestBoundMs?: number | undefined; hangProbeMs?: number | undefined; renderWaitMs?: number | undefined; maxCandidates: number; mentioned: (name: string) => boolean; secrets: string[]; };
  readonly ignoreNoProgress: (text: string) => boolean;
  readonly stallMs: number;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  readonly timings: PageTiming[];
  readonly isWrite: WriteClassifier;
  /** The shared safety policy (#116): session-ending / destructive / paid / denied controls. */
  readonly safety: SafetyPolicy;
  /** The writes the run's actions fire (#116: the result's `sideEffects`). */
  /**
   * #194 — which origins are the app's: the allowlist's sites, plus every origin the page sends API
   * credentials to (observed on every request below). A write elsewhere is `thirdParty`.
   */
  readonly firstParty: FirstPartyOrigins;
  readonly onRequestSeen: (r: { url(): string; headers(): Record<string, string>; }) => void;
  /**
   * The repeated-side-effect guard (#92): a click that fired a write is not blindly re-fired. A
   * third-party beacon or a `--settle-ignore`d request is never a control's side effect (#274/#284).
   */
  readonly sideEffects: SideEffectGuard;
  /** The writes earlier clicks fired that are still in flight, named (#283). */
  readonly inflightWrites: () => string;
  readonly documentStatus: Map<string, number>;
  /** #223: controls repeated across pages (global chrome) — their link text is not page content. */
  readonly chrome: ChromeTracker;
  readonly docKey: (u: string) => string;
  readonly onDocumentResponse: (r: { url(): string; status(): number; request(): { isNavigationRequest(): boolean; frame(): unknown; }; }) => void;
  readonly effectLog: SideEffectLog;
  /** #303: what each action changed on the page (null when turned off). */
  readonly deltas: ActionDeltas | null;
  /** #303: write steps whose changes did not survive a reload (saved but not stored — evidence). */
  readonly notPersisted: Array<{ step: number; action: string; why: string }>;
  /** #303: the verdict of the last action's delta, until the no-progress check reads it. */
  deltaVerdict: DeltaVerdict | null;
  /** A find-out goal's read-only guard (#158), or null when the run may write. */
  readonly readOnly: ReadOnlyGuard | null;
  readonly jobWaitMs: number;
  /** How long `wait`s have waited on the in-progress status the page shows (bounded by `jobWaitMs`). */
  jobWaitedMs: number;
  /**
   * How long a hang signal has been deferred because the page is visibly WORKING (#153): never reset,
   * so a page that keeps "working" is still reported as a hang once the job-wait budget is spent.
   */
  hangWorkWaitedMs: number;
  /** #258: the longest wait the page has documented this run (its budget, ms); 0 when none. */
  documentedBudgetMs: number;
  readonly noteMutation: (label: string, descriptor: unknown, before: string, at: number, input?: { readonly field: string; readonly value: string; }, linkFromRoute?: string | null, clickFromRoute?: string | null) => void;
  firstNavNetError: string | null;
  readonly onFirstNavRequestFailed: (req: { failure(): { errorText: string; } | null; }) => void;
  firstNavFailed: boolean;
}

export async function explore(cfg: ExploreConfig): Promise<ExploreRun> {
  const ctx = {} as { -readonly [K in keyof RunContext]: RunContext[K] };
  // #1 — authorize the start target before ANY snapshot/decision/action.
  ctx.startOrigin = assertAuthorizedExploreTarget(cfg.startUrl, cfg.allowlist);
  // Mission fixture: validated before any navigation/decision (fail fast).
  ctx.fixture = cfg.fixture === undefined ? null : await resolveMissionFixture(cfg.fixture);

  // A bound secret field's value (or TOTP seed) is a run secret: every redaction seam scrubs it.
  ctx.secrets = [...(cfg.secrets ?? []), ...secretFieldSecrets(cfg.secretFields)];
  ctx.secretContext = secretFieldContext(cfg.secretFields);
  ctx.missionContext = [
      cfg.missionContext,
      ctx.secretContext,
      typeFixtureContext(cfg.typeFixtures),
      cfg.readOnly === true ? READ_ONLY_NOTE : cfg.noDestructiveWrites === true ? NO_DESTRUCTIVE_NOTE : null,
    ]
      .filter((c): c is string => c !== undefined && c !== null && c !== "")
      .join("; ") || undefined;
  ctx.bounds = resolveBounds(cfg.bounds);
  ctx.tracker = new BoundsTracker(ctx.bounds);
  ctx.noProgress = new NoProgressDetector(3);
  ctx.fillHelper = new FillHelper(cfg.gen, cfg.identityToken === undefined ? {} : { identityToken: cfg.identityToken });
  ctx.recorder = new RunRecorder(cfg.site ?? ctx.startOrigin, undefined, ctx.secrets, cfg.onRecording);
  ctx.page = cfg.actor.ability(BrowseTheWebToken).session.page;
  ctx.crashWatch = new CrashWatch(ctx.page);
  ctx.heap = new HeapLog();
  ctx.probeHost = cfg.hostProbe ?? hostProbe();
  /** #203: the fresh host sample around a finding, and whether the run's sampler calls it starved. */
  ctx.judgeHost = async (): Promise<HostJudgment> =>
    cfg.hostHealth === undefined ? { host: await ctx.probeHost(), starved: null } : cfg.hostHealth.judge();
  /** #203: a finding the starved host explains ends the run `inconclusive`, never as a hang. */
  ctx.degradedStop = (finding: "hang" | "no-progress", detail: string, starved: string): void => {
    cfg.hostHealth?.markDegraded({ finding, detail, step: Math.max(0, ctx.transcript.entries().length - 1) }, starved);
    ctx.failure = {
      kind: "degraded-environment",
      message: `environment-degraded ${finding} (${detail}) while the host was starved: ${starved} — not an app finding`,
    };
    ctx.stop = "inconclusive";
  };
  /**
   * #230: before a hang/no-progress is a finding (or blamed on a starved host), did the app itself
   * stop answering? Throws `TargetUnresponsiveError` (→ `inconclusive` / `target-unresponsive`).
   */
  ctx.livenessOf = () => ({
    pageUrl: ctx.page.url(),
    authorized: (u: string) => isAuthorizedExploreTarget(u, cfg.allowlist),
  });
  ctx.now = (): number => Date.now();

  ctx.transcript = new TranscriptLog(ctx.secrets, cfg.onTranscriptEntry);
  ctx.history = [];
  /** #245: the demo overlay (null unless `demoOverlay`) — display only, never an input to the loop. */
  ctx.overlay = demoOverlayFor(cfg.demoOverlay, ctx.secrets);
  ctx.overlayWhy = `goal: ${cfg.goal}`;

  ctx.stop = "exhausted";
  ctx.failure = undefined;
  ctx.lastActedOp = null;
  /** #172: did the last scroll move the page, and how many moved scrolls in a row on one state. */
  ctx.lastScrollMoved = false;
  ctx.movingScrolls = 0;
  ctx.movingScrollsSignature = null;
  /** #172: the no-progress last-chance turn was given (it is given once per run). */
  ctx.lastChanceGiven = false;
  /** #172: this decision is the last-chance turn. */
  ctx.lastChanceTurn = false;
  ctx.fixtureAttached = false;
  ctx.hang = undefined;
  ctx.outcome = null;
  /** Why the run ended incomplete, when a specific detector ended it. */
  ctx.incomplete = null;
  /** #209: stopped because every `done` the model proposed was rejected. */
  ctx.endedOnRejectedDone = false;
  ctx.unsent = new UnsubmittedTypeTracker();
  ctx.conversation = { latestReply: null, sent: [] };
  /** Consecutive message generations made while the conversation was stuck (#122). */
  ctx.stuckTurns = 0;
  /** The current stuck episode was already told to the decision (#122). */
  ctx.stuckNoted = false;
  /**
   * After a user turn went out (#122): when the conversation is now stuck on content-free / repeated
   * turns, the NEXT decision is told so once per episode — answer concretely, or take the page's
   * call to action toward the goal.
   */
  ctx.noteStuckConversation = (controls: readonly Control[]): void => {
    if (!repetitiveTurns(ctx.conversation.sent)) {
      ctx.stuckNoted = false;
      return;
    }
    if (ctx.stuckNoted) return;
    ctx.stuckNoted = true;
    const cta = goalCallToAction(controls, cfg.goal);
    ctx.history.push(
      `the conversation is stuck: your last ${STUCK_TURNS} messages acknowledged or repeated without answering — ` +
        `answer the assistant's question with a concrete fact or choice${cta === null ? "" : `, or take the page's call to action ${quote(cta.name, 80)}`}`,
    );
  };
  /** The values this run typed into each form field, and which were submitted (#123). */
  ctx.valueLog = new FieldValueLog();
  /** Controls present just before a message was sent — the next snapshot's new ones were offered with the reply. */
  ctx.offerBaseline = null;
  ctx.offeredKeys = new Set<string>();
  ctx.doneRejections = 0;
  ctx.reportRejections = 0;
  /** The visible text of every page state observed — what a reported answer is grounded against (#101). */
  ctx.observed = new ObservedPages(ctx.secrets);
  /**
   * #200 — a goal about a conversational reply (`goalAsksForReply`, code-side) is reported from, and
   * grounded on, ONLY text that appeared after the run's first send: each observed state's text minus
   * the pre-send snapshot and the run's own messages, plus every reply the reply wait read. A chat
   * panel's intro / placeholder copy, on screen before the conversation, is never a reply.
   */
  ctx.replyGoal = goalAsksForReply(cfg.goal);
  /**
   * #207 — a find-out goal (read-only, #158; not a reply goal, #200) is answered from page text: its
   * decisions carry the page's visible text, and a model `blocked` on a page state is first turned
   * into one grounded report attempt there (the answer may be plain text no control carries).
   */
  ctx.findOut = cfg.readOnly === true && !ctx.replyGoal;
  /** #207: page states whose `blocked` was already turned into a report attempt (once per state). */
  ctx.blockedReported = new Set<string>();
  /** #207: the latest report attempt found no answer — the run's end reason then names the pages seen. */
  ctx.lastReportNotFound = false;
  /** #238: the latest report's "none exists" was below the coverage floor (its reason), else null. */
  ctx.lastAbsenceUncovered = null;
  /** #239: the last click whose window was settled, and whether any click's writes all succeeded (2xx). */
  ctx.settledClick = null;
  ctx.wroteOk = false;
  /** #239: a write goal ("record a decision…") is not settled by a report before the run saved anything. */
  ctx.writeGoal = goalAsksToWrite(cfg.goal);
  // #229: answers Jev vetoed stay rejected for the rest of the run, however often they are re-reported.
  ctx.vetoes = new VetoedAnswers();
  ctx.replies = new ObservedPages(ctx.secrets);
  /** The page text just before the run's first message was sent (null until one is sent). */
  ctx.preSend = null;
  ctx.noteReplyText = (url: string, pageText: string): void => {
    if (ctx.preSend !== null) ctx.replies.add(url, withoutAuthored(newPageText(ctx.preSend, pageText, ""), ctx.conversation.sent));
  };
  /** The grounded answer a `report` ended the run with. */
  ctx.answer = undefined;
  /** Page states already goal-checked on the decision's "already met" signal (once each, #91). */
  ctx.goalChecked = new Set<string>();
  /** The run's own sign-in steps and the sign-in completion code observes on each state (#188). */
  ctx.auth = new AuthProgress();
  /** #225: the run's own typed-and-submitted form values, for the code-observed save signal. */
  ctx.save = new SaveProgress();
  ctx.isBound = (c: Control): boolean => boundSecretField(c, cfg.secretFields) !== null;
  ctx.idleSteps = 0;
  ctx.idleSince = null;
  /** How long consecutive `wait`s have waited on a still-busy app (bounded by `replyWaitMs`). */
  ctx.busyWaitedMs = 0;
  /** The last message sent got no reply yet (a slow LLM turn): `wait`s are patience, bounded. */
  ctx.awaitingReply = false;
  /** The page text before the last message, and the message — to keep listening for its reply. */
  ctx.lastTurn = null;
  /**
   * #241 × #283: endpoints the run's own conversation turns wrote to (the chat's POST). Never the
   * page's background polling: the next turn's write to the same endpoint is that turn's own work.
   */
  ctx.turnWrites = new Set<string>();
  ctx.lastPath = null;
  // #188 — an add-another flow (the goal lists several items) comes back to a state it already went
  // through (the second item's one-time dialog, identical to the first's). The model is reminded of
  // what it did next from there, once per return — it read the history as those steps being done.
  ctx.listsSeveral = goalListsSeveral(cfg.goal);
  ctx.nextFrom = new Map<string, string[]>();
  ctx.prevSignature = null;
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
    if (ctx.blockers.target !== null) return ctx.blockers.target.text;
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
    ctx.blockers.target = { key: keyOf(c), text: `${r === "target not enabled" ? "target disabled" : "target not visible"} — ${name}` };
    return r === "target not enabled"
      ? `${r}: ${name} is disabled — its label may say what it needs first`
      : `${r}: ${name}`;
  };
  /** A control acted on successfully is no longer the blocker. */
  ctx.cleared = (c: Control): void => {
    if (ctx.blockers.target?.key === keyOf(c)) ctx.blockers.target = null;
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
  ctx.replyWaitMs = cfg.replyWaitMs ?? REPLY_WAIT_MS;
  ctx.replyCeilingMs = Math.max(ctx.replyWaitMs, cfg.replyCeilingMs ?? REPLY_CEILING_MS);
  ctx.replyMaxChars = cfg.replyMaxChars ?? REPLY_MAX_CHARS;
  ctx.waitOpMs = cfg.waitOpMs ?? WAIT_OP_MS;
  /** Every page state seen so far (for "the action sent the page back to an earlier state"). */
  ctx.seen = new Set<string>();
  /** The last executed page-changing action: when, from which state, and its Recording index. */
  ctx.track = { lastMutation: null, lastRecordedTarget: null };
  // #192: an option the goal names (a country, a currency) is perceived even deep in a long list.
  ctx.goalText = cfg.goal.toLowerCase();
  ctx.perceiveOpts = {
    maxCandidates: ctx.bounds.maxCandidates,
    mentioned: (name: string) => name.trim().length >= 2 && ctx.goalText.includes(name.trim().toLowerCase()),
    // #219: page content is redacted of every registered secret as it is perceived.
    secrets: ctx.secrets,
    ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
    ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
    ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
    ...(cfg.settle === undefined ? {} : { settleConfig: cfg.settle }),
    ...(cfg.hangs === undefined ? {} : { hangConfig: cfg.hangs }),
    ...(cfg.timingConfig === undefined ? {} : { timingConfig: cfg.timingConfig }),
  };
  ctx.ignoreNoProgress = textMatcher(cfg.hangs?.ignoreNoProgress);
  ctx.stallMs = cfg.stallMs ?? DEFAULT_STALL_MS;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  ctx.timings = [];
  // A write is classified by the shared classifier (#110): a gRPC-web/Connect read is never guarded.
  ctx.isWrite = writeClassifier(cfg.safety?.readRequests === undefined ? {} : { readRequests: cfg.safety.readRequests });
  /** The shared safety policy (#116): session-ending / destructive / paid / denied controls. */
  ctx.safety = new SafetyPolicy(cfg.safety, { goal: cfg.goal });
  /** The writes the run's actions fire (#116: the result's `sideEffects`). */
  /**
   * #194 — which origins are the app's: the allowlist's sites, plus every origin the page sends API
   * credentials to (observed on every request below). A write elsewhere is `thirdParty`.
   */
  ctx.firstParty = new FirstPartyOrigins(cfg.allowlist);
  ctx.onRequestSeen = (r: { url(): string; headers(): Record<string, string> }): void => {
    ctx.firstParty.observe(r.url(), r.headers());
  };
  ctx.page.on("request", ctx.onRequestSeen);
  /**
   * The repeated-side-effect guard (#92): a click that fired a write is not blindly re-fired. A
   * third-party beacon or a `--settle-ignore`d request is never a control's side effect (#274/#284).
   */
  ctx.sideEffects = new SideEffectGuard(monitorFor(ctx.page), {
    isWrite: ctx.isWrite,
    allowlist: cfg.allowlist,
    firstParty: ctx.firstParty,
    ignoreRequests: urlMatcher(cfg.settle?.ignoreRequests),
  });
  /** The writes earlier clicks fired that are still in flight, named (#283). */
  ctx.inflightWrites = (): string =>
    [...new Set(ctx.sideEffects.inflight().map((w) => `${w.method} ${w.path}`))].join(", ");
  // #223: the main document's HTTP status per URL — an answer on a 404 / error page is no answer.
  ctx.documentStatus = new Map<string, number>();
  /** #223: controls repeated across pages (global chrome) — their link text is not page content. */
  ctx.chrome = new ChromeTracker();
  ctx.docKey = (u: string): string => u.split("#")[0] ?? u;
  ctx.onDocumentResponse = (r: { url(): string; status(): number; request(): { isNavigationRequest(): boolean; frame(): unknown } }): void => {
    try {
      if (!r.request().isNavigationRequest() || r.request().frame() !== ctx.page.mainFrame()) return;
      if (ctx.documentStatus.size >= 500) ctx.documentStatus.clear();
      ctx.documentStatus.set(ctx.docKey(r.url()), r.status());
    } catch {
      // a response whose frame is gone: nothing to record
    }
  };
  ctx.page.on("response", ctx.onDocumentResponse);
  // #194: a write to a third-party origin is listed with its full URL and `thirdParty: true`.
  ctx.effectLog = new SideEffectLog({ isWrite: ctx.isWrite, now: ctx.now, allowlist: cfg.allowlist, firstParty: ctx.firstParty });
  /** #303: what each action changed on the page (null when turned off). */
  ctx.deltas = cfg.actionDeltas === undefined || cfg.actionDeltas === false
      ? null
      : new ActionDeltas(ctx.page, {
          secrets: ctx.secrets,
          goal: cfg.goal,
          judge: typeof cfg.actionDeltas === "object" && cfg.actionDeltas.jev === true ? cfg.judge : null,
          ...(typeof cfg.actionDeltas === "object" && cfg.actionDeltas.volatilityGapMs !== undefined ? { volatilityGapMs: cfg.actionDeltas.volatilityGapMs } : {}),
          ownWrites: () => ctx.turnWrites,
          isWrite: ctx.isWrite,
          ignoreRequest: urlMatcher(cfg.settle?.ignoreRequests),
        });
  /** #303: write steps whose changes did not survive a reload (saved but not stored — evidence). */
  ctx.notPersisted = [];
  /** #303: the verdict of the last action's delta, until the no-progress check reads it. */
  ctx.deltaVerdict = null;
  /** A find-out goal's read-only guard (#158), or null when the run may write. */
  ctx.readOnly = cfg.readOnly === true || cfg.noDestructiveWrites === true
      ? new ReadOnlyGuard(ctx.isWrite, {
          mode: cfg.readOnly === true ? "read-only" : "no-destructive",
          // #194: only writes to the app's own origins are blocked; a third-party beacon passes (listed).
          allowlist: cfg.allowlist,
          firstParty: ctx.firstParty,
          ...(cfg.safety?.allowWriteRequests === undefined ? {} : { allowWrites: cfg.safety.allowWriteRequests }),
        })
      : null;
  ctx.jobWaitMs = cfg.jobWaitMs ?? ctx.replyCeilingMs;
  /** How long `wait`s have waited on the in-progress status the page shows (bounded by `jobWaitMs`). */
  ctx.jobWaitedMs = 0;
  /**
   * How long a hang signal has been deferred because the page is visibly WORKING (#153): never reset,
   * so a page that keeps "working" is still reported as a hang once the job-wait budget is spent.
   */
  ctx.hangWorkWaitedMs = 0;
  /** #258: the longest wait the page has documented this run (its budget, ms); 0 when none. */
  ctx.documentedBudgetMs = 0;
  ctx.noteMutation = (
    label: string,
    descriptor: unknown,
    before: string,
    at: number,
    input?: { readonly field: string; readonly value: string },
    linkFromRoute: string | null = null,
    clickFromRoute: string | null = null,
  ): void => {
    // An input change (type/select/send/upload) makes a repeat send something new — unless it set
    // the same value again (#123): the guard compares the values.
    if (!label.startsWith("click ")) ctx.sideEffects.inputChanged(input?.field, input?.value);
    ctx.deltas?.acted({ label, recordIndex: ctx.recorder.stepCount - 1, step: ctx.transcript.nextStep, ...(input === undefined ? {} : { value: input.value }) });
    ctx.failedActs.succeeded();
    if (!label.startsWith("type ")) {
      ctx.typeNoEffect = null;
      ctx.typeCredit = null;
    }
    ctx.track.lastMutation = { at, before, seenBefore: new Set(ctx.seen), label, recordIndex: ctx.recorder.stepCount - 1, sawNewState: false, linkFromRoute, clickFromRoute };
    ctx.refusedSinceMutation = 0;
    ctx.scrollsSinceMutation = 0;
    ctx.track.lastRecordedTarget = JSON.stringify(descriptor);
    ctx.statusAfter = label;
  };

  // #128: real network evidence for the FIRST navigation, preferred over whatever `page.goto`
  // itself reports — a refused connection can still surface as a bare navigation timeout.
  ctx.firstNavNetError = null;
  ctx.onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
    const text = req.failure()?.errorText;
    if (text !== undefined) ctx.firstNavNetError = text;
  };
  ctx.firstNavFailed = false;

  try {
    // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
    await monitorFor(ctx.page).instrument();
    await ctx.deltas?.enable();
    ctx.effectLog.attach(monitorFor(ctx.page));
    // Initial navigation (authorized above).
    ctx.page.on("requestfailed", ctx.onFirstNavRequestFailed);
    try {
      // #293: an anchored run starts on the live page its Journey prefix left — never a fresh load.
      if (cfg.startInPlace !== true) {
        await assertSeedReachable(cfg.actor, cfg.startUrl);
        await Navigate.to(cfg.startUrl).performAs(cfg.actor);
      }
    } catch (e) {
      const message = firstLine(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(ctx.firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem (a bad URL, the target not running). `inconclusive`, not `crashed`;
      // no crash report is built for it, so no issue is ever drafted from it.
      ctx.firstNavFailed = true;
      ctx.stop = "inconclusive";
      const cause = describeUnreachable(message, ctx.firstNavNetError);
      ctx.failure = { kind: "target-unreachable", message: `target unreachable (${cause})` };
      // #213: a bare load TIMEOUT (no network error) on a starved host is the host, not the target —
      // unless a fresh request for the page gets no response at all either (#230: the app is down).
      if (cause === "timed out before any response" && cfg.hostHealth !== undefined) {
        const judged = await cfg.hostHealth.judge();
        if (judged.starved !== null && (await targetStoppedAnswering({ pageUrl: cfg.startUrl }).catch(() => null)) === null) {
          const detail = `the start page did not load in time (${cause})`;
          cfg.hostHealth.markDegraded({ finding: "page-load-timeout", detail, step: 0 }, judged.starved);
          ctx.failure = {
            kind: "degraded-environment",
            message: `environment-degraded page load (${detail}) while the host was starved: ${judged.starved} — not an app or access finding`,
          };
        }
      }
    } finally {
      ctx.page.off("requestfailed", ctx.onFirstNavRequestFailed);
    }
    if (ctx.firstNavFailed) throw new FirstNavigationFailedSentinel();
    ctx.recorder.navigate(cfg.startUrl, ctx.now());
    // #158 — from here on, a read-only run's write requests never leave the browser.
    if (ctx.readOnly !== null) {
      await ctx.readOnly.arm(ctx.page);
      if (ctx.readOnly.mode === "read-only") {
        ctx.effectLog.markBackground();
        ctx.history.push(READ_ONLY_NOTE);
      } else ctx.history.push(NO_DESTRUCTIVE_NOTE);
    }

    for (;;) {
      if (!ctx.tracker.mayDecide()) {
        ctx.stop = "exhausted";
        break;
      }

      // Shared perception: never decide on an unrendered page (bounded render wait) and never
      // offer an occluded control (see `perceive`).
      const perceiveStartedAt = Date.now();
      const perception = await perceive(ctx.page, ctx.perceiveOpts);
      ctx.timings.push(perception.timing);
      // The last click's window closes here: what it wrote is now known (#92).
      ctx.sideEffects.settle();
      // #239: a click whose writes all succeeded saved what the run had typed — from here those values
      // are the app's, and the run has written (a write goal's report may settle it).
      {
        const lc = ctx.sideEffects.lastClick();
        if (lc !== null && lc !== ctx.settledClick) {
          ctx.settledClick = lc;
          if (lc.writes.length > 0 && lc.writes.every((w) => w.status !== null && w.status >= 200 && w.status < 300)) {
            ctx.observed.confirmOwnInputs();
            ctx.wroteOk = true;
          }
        }
      }
      // #158 — the action's window closes once the page settled: later writes are the app's own.
      if (ctx.readOnly?.settled() === true && ctx.readOnly.mode === "read-only") ctx.effectLog.markBackground();
      // A bound secret field shows the model its placeholder only (#72).
      const snap = markTypeFixtures(maskSecretFields(perception.snapshot, cfg.secretFields), cfg.typeFixtures);
      {
        const m = ctx.track.lastMutation;
        if (m !== null && snap.signature !== m.before && !m.seenBefore.has(snap.signature)) m.sawNewState = true;
      }
      await ctx.heap.sample(ctx.page, ctx.transcript.nextStep);
      // Re-observe the PREVIOUS action's effect: patch its postcondition + open
      // the next page segment if the URL changed (record-before-reobserve).
      const target = ctx.track.lastRecordedTarget;
      ctx.recorder.observed(
        snap.url,
        ctx.now(),
        perception.timing,
        target === null ? undefined : { lastTargetStillPresent: snap.controls.some((c) => JSON.stringify(c.descriptor) === target) },
      );
      ctx.track.lastRecordedTarget = null;
      // #303: what the previous action changed (code's verdict), attached to its transcript step and
      // Recording step, and told to the model; this capture is also the next action's baseline.
      if (ctx.deltas !== null) {
        // A bound secret field's value (a TOTP code, a password code types) is masked in every capture.
        for (const c of perception.snapshot.controls) if (ctx.isBound(c)) ctx.deltas.secretField(c.name);
        const d = await ctx.deltas.perceived(hangRoute(snap.url)).catch(() => null);
        if (d !== null) {
          ctx.deltaVerdict = d.delta.verdict;
          // #303 persistence: a write that went through and changed the page is re-checked after a
          // reload (a GET of the same URL — never a re-post), once, at this safe point (nothing typed
          // and unsent, no write still in flight, not a read-only run).
          let delta = d.delta;
          let reloaded = false;
          if (
            ctx.deltas.wroteLasting() &&
            cfg.readOnly !== true &&
            ctx.unsent.pending().size === 0 &&
            ctx.sideEffects.inflight().length === 0 &&
            /^https?:/i.test(ctx.page.url())
          ) {
            const url = ctx.page.url();
            const ok = await ctx.page
              .goto(url, { waitUntil: "load", timeout: 15_000 })
              .then(() => true)
              .catch(() => false);
            await monitorFor(ctx.page).waitSettled({ ceilingMs: 10_000 }).catch(() => undefined);
            const p = ok ? await ctx.deltas.persistence().catch(() => ({ persisted: "inconclusive" as const, why: "the check failed" })) : { persisted: "inconclusive" as const, why: "the reload failed" };
            delta = { ...delta, persisted: p.persisted, persistedWhy: p.why };
            if (p.persisted === "no") ctx.notPersisted.push({ step: d.step, action: delta.action, why: p.why });
            reloaded = true;
            ctx.recorder.navigate(url, ctx.now());
            ctx.history.push(`persistence check after ${delta.action}: ${p.persisted} — ${p.why}`);
          }
          ctx.transcript.attachDelta(d.step, delta);
          ctx.recorder.attachDelta(d.recordIndex, deltaRecord(delta));
          ctx.history.push(deltaPromptLine(delta));
          // #303 grounding: what the action announced or lastingly showed (a toast gone before the
          // report) is observed page text a report may quote — redacted, never a field's own value.
          const quotable = deltaQuotableText(delta);
          if (quotable !== "") ctx.observed.add(snap.url, quotable);
          if (reloaded) {
            ctx.transcript.record({
              op: "reload",
              control: null,
              confidence: null,
              chosenBy: "strategy",
              strategy: "persistence-check",
              actOk: true,
              reason: `persistence check after ${delta.action}: ${delta.persisted} — ${delta.persistedWhy ?? ""}`,
              snapshot: snap,
              timing: perception.timing,
            });
            continue;
          }
        }
      }

      // Long-running legitimate work is not a hang (#153): a page that shows an in-progress status
      // AND acknowledges it (a Cancel control, the pressed control disabled as "Analyzing...", a
      // determinate progress bar) is WORKING. Code waits it out, bounded by the job-wait budget;
      // past the budget the hang stands. A main thread that does not answer is never "working".
      // #258: a wait the page DOCUMENTS ("this usually takes less than a minute") is working too, and
      // its stated duration can raise the budget (twice the stated time plus a grace, capped). #288: so
      // is a busy indicator that outlasted the ceiling while the app visibly kept working (an
      // in-progress status, with its requests completing or its progress text changing meanwhile).
      const documented =
        perception.hang !== null && perception.hang.kind !== "main-thread-unresponsive" ? await readDocumentedWait(ctx.page) : null;
      if (documented !== null) ctx.documentedBudgetMs = Math.max(ctx.documentedBudgetMs, documentedWaitBudgetMs(documented.ms));
      const workBudgetMs = Math.max(ctx.jobWaitMs, ctx.documentedBudgetMs);
      if (perception.hang !== null && perception.hang.kind !== "main-thread-unresponsive" && ctx.hangWorkWaitedMs < workBudgetMs) {
        const working =
          (await readWorkingStatus(ctx.page)) ??
          (documented === null ? null : `a documented wait ("${documented.text}")`) ??
          (perception.hang.kind === "ui-no-progress" ? await liveBusyWork(ctx.page, perception.busyWait) : null);
        if (working !== null) {
          const w = await waitOutJob(ctx.page, Math.min(workBudgetMs - ctx.hangWorkWaitedMs, JOB_WAIT_SLICE_MS), stillShowsWork);
          // The perception's own wait counts too (its whole time, the busy-indicator wait included): the
          // budget bounds the whole time spent believing it.
          ctx.hangWorkWaitedMs += Date.now() - perceiveStartedAt;
          const note = `not a hang yet (${perception.hang.kind}): the page shows ${working} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
            w.cleared ? "the status cleared" : `still in progress; ${Math.round(ctx.hangWorkWaitedMs / 1000)}s of the ${Math.round(workBudgetMs / 1000)}s job-wait budget used`
          })`;
          ctx.history.push(note);
          ctx.transcript.record({
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
        ctx.transcript.record({
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
        await assertTargetAnswering(ctx.livenessOf());
        const judged = await ctx.judgeHost();
        if (judged.starved !== null) {
          ctx.degradedStop(perception.hang.kind === "ui-no-progress" ? "no-progress" : "hang", `${perception.hang.kind}: ${perception.hang.detail}`, judged.starved);
          break;
        }
        const heapNow = await sampleHeap(ctx.page, 1_000);
        // #288: a hang that stands after the page was believed to be working says how long, and how to
        // allow a longer job — the operator's knob, never a silent longer wait.
        const stood: HangSignal =
          ctx.hangWorkWaitedMs > 0
            ? {
                ...perception.hang,
                detail: `${perception.hang.detail} (still so after ${Math.round(ctx.hangWorkWaitedMs / 1000)}s of the page showing work — past the ${Math.round(workBudgetMs / 1000)}s job-wait budget; raise --job-wait-ms for longer jobs)`,
              }
            : perception.hang;
        const withHost: HangSignal = { ...stood, host: judged.host };
        ctx.hang = {
          signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
          recordingStepIndex: Math.max(0, ctx.recorder.stepCount - 1),
        };
        ctx.stop = "hang";
        break;
      }

      // #1 — mid-run origin guard (fail-closed): never act off an authorized origin.
      if (!isAuthorizedExploreTarget(snap.url, cfg.allowlist)) {
        ctx.stop = "blocked";
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
          ctx.transcript.record({
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
          ctx.incomplete = budget.reason;
          ctx.stop = "budget";
          break;
        }
      }

      // #174 — the success condition is already met (independent code): stop now, never act past it.
      if (cfg.successMetNow !== undefined) {
        const met = await cfg.successMetNow().catch(() => null);
        if (met !== null) {
          ctx.transcript.record({
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
          ctx.outcome = { status: "completed", verifiedBy: "success-condition" };
          ctx.stop = "done";
          break;
        }
      }

      if (!perception.rendered) {
        ctx.transcript.record({
          op: "wait",
          control: null,
          confidence: null,
          chosenBy: "strategy",
          actOk: false,
          reason: `${perception.reason} (fail-closed)`,
          snapshot: snap,
          timing: perception.timing,
        });
        ctx.stop = "blocked";
        break;
      }

      // Status text (#79): alerts / invalid fields are not controls, so the model would never see
      // them. What newly appeared after the last step goes into its history; what shows now goes
      // into its prompt.
      {
        const before = ctx.status;
        ctx.status = await readPageStatus(ctx.page);
        const appeared = statusDelta(before, ctx.status);
        if (ctx.transcript.nextStep > 0 && !isEmptyStatus(appeared)) {
          ctx.history.push(`after ${ctx.statusAfter ?? "the last step"}: ${describeStatus(appeared)}`);
        }
        ctx.statusAfter = null;
      }

      // #172 — a scroll that MOVED the page is progress (the model is reading a long page), even
      // though the control set — the signature — is the same; bounded, so a scroll loop still stops.
      const scrolledMoved = (ctx.lastActedOp === "scroll_down" || ctx.lastActedOp === "scroll_up") && ctx.lastScrollMoved;
      if (!scrolledMoved || snap.signature !== ctx.movingScrollsSignature) ctx.movingScrolls = 0;
      ctx.movingScrollsSignature = snap.signature;
      if (scrolledMoved) ctx.movingScrolls += 1;
      const scrollProgress = scrolledMoved && ctx.movingScrolls <= MAX_MOVING_SCROLLS;
      if (scrollProgress) ctx.noProgress.progress(snap.signature);
      ctx.lastChanceTurn = false;
      // #2 — no-progress: the last executed op left the page unchanged N times.
      // #303: the last action's delta decides when there is one — only `no-change` counts toward the
      // streak, `inconclusive` holds it; without one the page signature decides, as before.
      const verdictNow = ctx.deltaVerdict;
      ctx.deltaVerdict = null;
      if (ctx.lastActedOp !== null && !scrollProgress && ctx.noProgress.noteDelta(ctx.lastActedOp, snap.signature, verdictNow)) {
        // Is the APP stuck (not the explorer)? The page is alive, the last page-changing action
        // sent it BACK to a state it had already been in (it changed, then reverted — an action
        // that silently undid itself, like an import that never starts), and it stays there for
        // the stall window: a `ui-no-progress` hang, not generic no-progress. An action that simply
        // did nothing (same state before and after) stays plain no-progress.
        // The action's target state must NEVER have appeared (no new state since the action), and
        // the target must not have declared this route/action as expected to return (per-target ignore).
        const m = ctx.track.lastMutation;
        if (
          m !== null &&
          // #276: the steps since were refusals / moved scrolls — the app answered: plain no-progress.
          ctx.refusedSinceMutation === 0 &&
          ctx.scrollsSinceMutation === 0 &&
          !m.sawNewState &&
          snap.signature !== m.before &&
          m.seenBefore.has(snap.signature) &&
          // A link that navigated to ANOTHER route already visited is ordinary navigation, not an
          // in-place action that silently undid itself (#153): the stall rule is for in-place actions.
          !((m.linkFromRoute ?? null) !== null && m.linkFromRoute !== hangRoute(snap.url)) &&
          // #289: a click whose write went through and that then took the page to another route
          // (Save → back to the hub) did what it was for — a save-and-return, not an action that undid itself.
          !savedAndLeft(m, hangRoute(snap.url), ctx.sideEffects.lastClick()) &&
          !EXPECTED_RETURN.test(m.label) &&
          !ctx.ignoreNoProgress(m.label) &&
          !ctx.ignoreNoProgress(hangRoute(snap.url))
        ) {
          const waited = ctx.now() - m.at;
          if (waited < ctx.stallMs) await ctx.page.waitForTimeout(ctx.stallMs - waited);
          const again = await perceive(ctx.page, ctx.perceiveOpts);
          ctx.timings.push(again.timing);
          const stuck =
            again.hang ??
            (again.snapshot.signature === snap.signature && (await probeResponsive(ctx.page, cfg.hangProbeMs ?? HANG_PROBE_MS))
              ? ({
                  kind: "ui-no-progress",
                  detail: `after "${m.label}" the page returned to an earlier state and made no progress for ${Math.round((ctx.now() - m.at) / 1000)}s`,
                  route: hangRoute(snap.url),
                  url: redactUrl(snap.url),
                  pending: [],
                  lastState: { signature: snap.signature, controls: snap.controls.map((c) => c.summary) },
                } satisfies HangSignal)
              : null);
          if (stuck !== null) {
            ctx.transcript.record({
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
            await assertTargetAnswering(ctx.livenessOf());
            const judged = await ctx.judgeHost();
            if (judged.starved !== null) {
              ctx.degradedStop(stuck.kind === "ui-no-progress" ? "no-progress" : "hang", `${stuck.kind}: ${stuck.detail}`, judged.starved);
              break;
            }
            const heapNow = await sampleHeap(ctx.page, 1_000);
            const withHost: HangSignal = { ...stuck, host: judged.host };
            ctx.hang = {
              signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
              recordingStepIndex: stuck.kind === "ui-no-progress" ? m.recordIndex : Math.max(0, ctx.recorder.stepCount - 1),
            };
            ctx.stop = "hang";
            break;
          }
        }
        if (!ctx.lastChanceGiven) {
          // #172 — one last-chance turn before the stop: the model has seen the page; it acts,
          // reports, or says done/blocked. For a find-out goal an idle choice becomes a report.
          ctx.lastChanceGiven = true;
          ctx.lastChanceTurn = true;
          ctx.history.push(LAST_CHANCE_NOTE);
        } else {
          ctx.stop = "no-progress";
          break;
        }
      }
      // Progress was made: a later stuck episode gets its own last chance.
      if (ctx.noProgress.streak === 0) ctx.lastChanceGiven = false;
      ctx.seen.add(snap.signature);

      // #90 — an interceptor proven by a real click failure stays blocked only while the page it was
      // proven on is still up; a re-render/navigation may have removed or moved it.
      if (ctx.blockedSinceSignature !== null && snap.signature !== ctx.blockedSinceSignature) {
        ctx.blockedInterceptors = [];
        ctx.blockedSinceSignature = null;
      }
      let modelControls = snap.controls;
      if (ctx.blockedInterceptors.length > 0) {
        const covered = new Set<number>();
        for (const c of snap.controls) {
          const loc = descriptorToLocator(ctx.page, c.descriptor);
          const hit = await loc.evaluate(coveredByInterceptors, ctx.blockedInterceptors).catch(() => false);
          if (hit) covered.add(c.index);
        }
        if (covered.size > 0) modelControls = snap.controls.filter((c) => !covered.has(c.index));
      }
      // #168 — a control the safety policy already refused this run is withheld from now on (never
      // re-offered, so the model cannot re-choose it and burn another action on the same refusal).
      if (ctx.refusedKeys.size > 0) modelControls = modelControls.filter((c) => !ctx.refusedKeys.has(keyOf(c)));
      // #272 / #294 — a target whose action failed twice as covered / unreachable is withheld until
      // an action succeeds (the model was told why).
      {
        const withheld = ctx.failedActs.withheld();
        if (withheld.size > 0) modelControls = modelControls.filter((c) => !withheld.has(keyOf(c)));
      }

      // Conversation bookkeeping (independent code). A navigation takes any typed text with it;
      // a field that left the page took its text too.
      const path = safePath(snap.url);
      if (ctx.lastPath !== null && path !== ctx.lastPath) {
        ctx.failedActs.succeeded();
        ctx.unsent.submitted();
        ctx.valueLog.submitted();
        ctx.save.reset();
      }
      ctx.lastPath = path;
      if (ctx.listsSeveral && ctx.prevSignature !== null && ctx.prevSignature !== snap.signature) {
        const next = ctx.nextFrom.get(snap.signature);
        if (next !== undefined) {
          ctx.history.push(
            `this page is in the same state as earlier, where you went on with: ${next.join(", ")} — the goal lists several items: if one is still to do, the same steps apply to it`,
          );
        }
      }
      ctx.prevSignature = snap.signature;
      const keys = new Map<string, Control>(snap.controls.map((c) => [keyOf(c), c]));
      // #242: what the last plain `type` did besides setting its own field's value.
      if (ctx.typeProbe !== null) {
        const p = ctx.typeProbe;
        ctx.typeProbe = null;
        const sent = requestsStartedSince(monitorFor(ctx.page), p.at, p.background);
        const stateSame = stateBesides(snap, p.key) === p.state;
        if (sent.length === 0 && stateSame) {
          // A held credit whose endpoints turned out to be background polling: that type changed
          // nothing either — the streak goes on (it and this one), never restarts.
          const credit = ctx.typeCredit?.key === p.key && ctx.typeCredit.endpoints.every((e) => p.background.has(e)) ? ctx.typeCredit : null;
          ctx.typeCredit = null;
          const count: number = credit !== null ? credit.count + 2 : ctx.typeNoEffect?.key === p.key ? ctx.typeNoEffect.count + 1 : 1;
          ctx.typeNoEffect = { key: p.key, count };
          ctx.history.push(
            `typing into ${p.label} changed nothing but its own value (no request, nothing else on the page changed) — ` +
              "submit it (its form's button, or Enter) or do something else; typing it again will not help",
          );
        } else {
          // Only requests, nothing else on the page: held until the next type tells polling apart.
          ctx.typeCredit = stateSame ? { key: p.key, count: ctx.typeNoEffect?.key === p.key ? ctx.typeNoEffect.count : 0, endpoints: sent } : null;
          ctx.typeNoEffect = null;
        }
      }
      ctx.unsent.retain(new Set(keys.keys()));
      if (ctx.offerBaseline !== null) {
        const before = ctx.offerBaseline;
        ctx.offeredKeys = new Set([...keys.keys()].filter((k) => !before.has(k)));
        ctx.offerBaseline = null;
      }
      const offered = new Set(snap.controls.filter((c) => ctx.offeredKeys.has(keyOf(c))).map((c) => c.index));
      const unsubmitted = new Set(snap.controls.filter((c) => ctx.unsent.wouldRepeat(keyOf(c))).map((c) => c.index));

      // #207: a form field's current value is page content too (grounded as such, never as page text).
      const visibleText = await readPageText(ctx.page, ctx.secrets);
      // #223: a rich-text (contenteditable) control's text is its value too, groundable like an input's.
      const richFields: { label: string; value: string }[] = [];
      for (const c of snap.controls.filter((x) => x.richText === true).slice(0, 5)) {
        const t = (await readEditableText(ctx.page, c))?.trim() ?? "";
        if (t !== "") richFields.push({ label: c.name.trim() || c.role || c.tag, value: redactText(t, ctx.secrets) });
      }
      try {
        ctx.chrome.observe(new URL(snap.url).pathname, snap.controls);
      } catch {
        // an unparsable URL: no chrome evidence from it
      }
      ctx.observed.add(snap.url, visibleText, [...controlFields(snap.controls), ...richFields], {
        ...(await readPageHeadings(ctx.page, ctx.secrets)),
        // #223: the action / label names (a quote made only of them is a label, not an answer) and
        // the document's status (an answer on a 404 page is no answer). A link that is page content
        // (in the main content, a list, a table, a card) is NOT one: its text may be the answer.
        controlNames: snap.controls.filter((c) => isActionOrChromeName(c, ctx.chrome)).map((c) => c.name),
        // #229: the content links' text, in page order (a list's entries: "the first item").
        contentLinks: snap.controls.filter((c) => !isActionOrChromeName(c, ctx.chrome)).map((c) => c.name),
        // #238: where the page's navigation leads — the first page's is the absence-answer coverage floor.
        navLinks: snap.controls
          .filter((c) => c.role === "link" && (c.landmark === "navigation" || c.landmark === "banner"))
          .flatMap((c) => (typeof c.href === "string" && c.href !== "" ? [c.href] : [])),
        ...(ctx.documentStatus.has(ctx.docKey(ctx.page.url())) ? { status: ctx.documentStatus.get(ctx.docKey(ctx.page.url()))! } : {}),
      });
      ctx.noteReplyText(snap.url, visibleText);

      // #158 — the write requests the read-only guard aborted since the last decision: recorded
      // (jevitate's own refusal) and told to the model.
      {
        const blocked = ctx.readOnly?.drain() ?? [];
        if (blocked.length > 0) {
          const what = [...new Set(blocked.map((b) => `${b.method} ${b.path}`))].join(", ");
          // #194: a blocked write off the --allow origins says how to declare or exempt it.
          const hints = [...new Set(blocked.flatMap((b) => (b.hint === undefined ? [] : [b.hint])))];
          const note =
            `blocked write request(s) ${redactText(what, ctx.secrets)}: ${
              ctx.readOnly?.mode === "no-destructive"
                ? "a destructive write needs --allow-writes on a goal with no success check — report what you found instead"
                : "this find-out goal is read-only — find the answer without changing anything"
            }` +
            (hints.length === 0 ? "" : ` (${redactText(hints.join("; "), ctx.secrets)})`);
          ctx.history.push(note);
          ctx.transcript.record({
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
            history: ctx.history,
            missionContext: ctx.missionContext,
            secrets: ctx.secrets,
            // One fixture ⇒ one upload: once attached, upload actions leave the candidate set (the
            // model had kept re-choosing it after a successful attach instead of proceeding).
            uploadAvailable: ctx.fixture !== null && !ctx.fixtureAttached,
            offered,
            unsubmitted,
            ...(ctx.conversation.latestReply === null && ctx.conversation.sent.length === 0
              ? {}
              : { conversation: { latestReply: ctx.conversation.latestReply, sentMessages: ctx.conversation.sent } }),
            ...(isEmptyStatus(ctx.status) ? {} : { pageStatus: describeStatus(ctx.status) }),
            ...(maxChoices === undefined ? {} : { maxChoices }),
            ...(ctx.findOut ? { pageText: visibleText } : {}),
            ...(ctx.deltas === null ? {} : { actionDeltas: true }),
          });
        decision = await decideWith().catch(async (e: unknown) => {
          const refusal = firstLine(e);
          if (!TOO_MANY_CHOICES.test(refusal)) throw e;
          // The refusal names the limit it enforces ("at most N choices"): retry within it.
          const stated = Number(/at most (\d+)/i.exec(refusal)?.[1]);
          const budget = Number.isInteger(stated) && stated > 0 ? stated : TOO_MANY_CHOICES_RETRY;
          ctx.history.push(`the decision had too many choices for the model: retried with the ${budget} most relevant`);
          return decideWith(budget);
        });
      } catch (e) {
        // The decision IS the goal loop's engine: without it the run can prove nothing more, so it
        // ends `inconclusive` (typed) with everything recorded so far — never a throw, never clean.
        ctx.failure = { kind: "exception", message: `model decision unavailable: ${firstLine(e)}` };
        ctx.transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "model",
          actOk: false,
          reason: ctx.failure.message,
          snapshot: snap,
          timing: perception.timing,
        });
        ctx.stop = "inconclusive";
        break;
      }
      ctx.tracker.countDecision();
      if (
        ctx.lastChanceTurn &&
        cfg.readOnly === true &&
        (decision.op === "scroll_down" || decision.op === "scroll_up" || decision.op === "wait" || decision.op === "blocked")
      ) {
        // #172 — a find-out goal that has seen the whole page and still only idles (or gives up)
        // ends with a report ATTEMPT, grounded by code like any report, never a bare `blocked`.
        ctx.history.push(`last chance: "${decision.op}" became a report attempt — the answer must be on the pages already seen`);
        decision = { ...decision, op: "report", control: null, targetMissing: false };
      }
      if (ctx.findOut && decision.op === "blocked" && !ctx.blockedReported.has(snap.signature)) {
        // #207 — a find-out goal's `blocked` is never a bare give-up while the page may show the
        // answer as plain text: one report ATTEMPT on this page state first, grounded by code.
        ctx.blockedReported.add(snap.signature);
        ctx.history.push(`"blocked" became a report attempt — a find-out goal is answered from the pages already seen`);
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
        if (!actOk && extra.origin === "engine") ctx.refusedSinceMutation += 1;
        if (op === "type" || op === "send") ctx.auth.noteTyped(target, snap.url, actOk, target !== null && ctx.isBound(target));
        // #225: typed credentials make the pending submit a sign-in, never a save.
        if ((op === "type" || op === "send") && actOk && target !== null && (ctx.isBound(target) || isCredentialField(target))) ctx.save.noteCredential();
        if (actOk && target !== null && (op === "click" || op === "type" || op === "select")) {
          const steps = ctx.nextFrom.get(snap.signature) ?? [];
          // The first visit's steps only: a return must not overwrite what the state led to.
          if (!ctx.nextFrom.has(snap.signature) || steps.length < 4) {
            if (!steps.includes(`${op} ${quote(target.name || target.summary, 60)}`)) steps.push(`${op} ${quote(target.name || target.summary, 60)}`);
            ctx.nextFrom.set(snap.signature, steps);
          }
        }
        ctx.transcript.record({
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
      const signIn = ctx.auth.signal(snap, ctx.isBound);
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
        const unsubmittedLabels = [...ctx.unsent.pending().values()].map((p) => p.label);
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
            const fullText = await readPageText(ctx.page, ctx.secrets);
            const pageText = withoutAuthored(fullText, ctx.conversation.sent);
            // #225: the run's own save, as code observed it — its writes, the page's notice, and whether
            // the page still displays what it saved (a field's value is never in the page text).
            saved = ctx.save.signal(snap, ctx.status, ctx.sideEffects.lastClick(), fullText);
            const judged = await judgeGoalCompletion(cfg.judge, {
              goal: cfg.goal,
              url: snap.url,
              pageText,
              history: ctx.history,
              secrets: ctx.secrets,
              ...(isEmptyStatus(ctx.status) ? {} : { pageStatus: describeStatus(ctx.status) }),
              ...(signIn === null ? {} : { signInFacts: signIn.facts }),
              ...(saved === null ? {} : { saveFacts: saved.facts }),
              fieldValues: fieldValuesOf(snap.controls, ctx.isBound),
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
        !(ctx.findOut && decision.op === "blocked") &&
        !ctx.goalChecked.has(snap.signature)
      ) {
        ctx.goalChecked.add(snap.signature);
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
          ctx.outcome = verdict.outcome;
          ctx.stop = "done";
          break;
        }
      }

      // #286: the goal asks for a report — `done` is no ending; the answer is (grounded by `report`).
      if (decision.op === "done" && cfg.requireAnswer === true) {
        ctx.doneRejections += 1;
        const why = "the goal asks you to report what you found: end with `report` (a grounded answer), not `done`";
        ctx.history.push(`done rejected: ${why}`);
        record(false, `done rejected (${ctx.doneRejections}/${MAX_DONE_REJECTIONS}): ${why}`);
        if (ctx.doneRejections >= MAX_DONE_REJECTIONS) {
          ctx.incomplete = `the model proposed done ${ctx.doneRejections} times, but ${why}`;
          ctx.endedOnRejectedDone = true;
          ctx.stop = "done";
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
          ctx.outcome = verdict.outcome;
          ctx.stop = "done";
          break;
        }
        // #225: the model's `done` failed the independent success check, but the job itself is judged
        // done on this page (the advisory judgment / code-observed save, never the verdict): stop here
        // rather than spend the rest of the budget — the check's failure is the finding, and the
        // mission names it (`failed`, success-check-failed).
        if (cfg.stopWhenJudgedDone === true && cfg.successCheck !== undefined && ctx.unsent.pending().size === 0) {
          const advisory = await groundGoal(true);
          if (advisory.verdict.accept) {
            const reason = `the job was judged done on this page (${acceptedBy(advisory.verdict.outcome).replace(/^goal verified by /, "")}), but ${verdict.reason}`;
            record(false, `done rejected: ${reason} — stopped (the success check decides; it failed)`, {
              ...(advisory.judgments === undefined ? {} : { judgments: advisory.judgments }),
            });
            ctx.incomplete = reason;
            ctx.endedOnRejectedDone = true;
            ctx.stop = "done";
            break;
          }
        }
        ctx.doneRejections += 1;
        ctx.history.push(`done rejected: ${verdict.reason} — keep working toward the goal`);
        record(false, `done rejected (${ctx.doneRejections}/${MAX_DONE_REJECTIONS}): ${verdict.reason}`, {
          ...(judgments === undefined ? {} : { judgments }),
        });
        if (ctx.doneRejections >= MAX_DONE_REJECTIONS) {
          ctx.incomplete = `the model proposed done ${ctx.doneRejections} times, but ${verdict.reason}`;
          ctx.endedOnRejectedDone = true;
          // #217: the loop ended on the model's `done` (code rejected it) — the stop says so; it
          // never reads `blocked` (the model did not give up). The outcome stays incomplete.
          ctx.stop = "done";
          break;
        }
        continue;
      }
      // `report` (#101) ends a find-out goal with an ANSWER — a proposal too: the answer is generated
      // from the observed page text and accepted only when code grounds every claim on it.
      if (decision.op === "report") {
        if (ctx.replyGoal) {
          // #200 — a reply still on its way is listened for (what is left of the reply wait) before
          // the report is judged; then the current page's post-send text is taken in.
          if (ctx.awaitingReply && ctx.lastTurn !== null && ctx.busyWaitedMs < ctx.replyWaitMs) {
            const t0 = ctx.now();
            const listen = ctx.replyWaitMs - ctx.busyWaitedMs;
            const reply = await waitForReply(ctx.page, { secrets: ctx.secrets, ...ctx.lastTurn, timeoutMs: listen, ceilingMs: listen });
            ctx.busyWaitedMs += ctx.now() - t0;
            if (reply.received) {
              ctx.conversation.latestReply = reply.text;
              ctx.replies.add(snap.url, reply.text);
              ctx.awaitingReply = false;
              ctx.busyWaitedMs = 0;
              ctx.history.push(`waited for the reply → reply: ${quote(reply.text, 300)}`);
            }
          }
          ctx.noteReplyText(snap.url, await readPageText(ctx.page, ctx.secrets));
        }
        const replyPages = ctx.replyGoal ? ctx.replies.pages() : null;
        const verdict: AnswerVerdict =
          replyPages !== null && replyPages.length === 0
            ? {
                accept: false as const,
                reason:
                  ctx.preSend === null
                    ? "no reply observed: no message was sent yet — text on the page before the conversation is not a reply"
                    : `no reply observed: no new message appeared after the send within the reply wait (${Math.round(ctx.replyWaitMs / 1000)}s)`,
                answer: null,
              }
            : await reportAnswer(cfg.gen, {
                goal: cfg.goal,
                url: snap.url,
                pages: replyPages ?? ctx.observed.pages(),
                history: ctx.history,
                secrets: ctx.secrets,
                judge: cfg.judge,
                vetoes: ctx.vetoes,
                // #238: "none exists" is an answer only on observed pages that cover the app enough.
                ...(replyPages === null ? { topNav: ctx.observed.topNavigation(), ownInputs: ctx.observed.ownInputs() } : {}),
              })
                // #239: a write goal's report settles nothing before a write of the run succeeded.
                .then((v): AnswerVerdict =>
                  v.accept && ctx.writeGoal && !ctx.wroteOk && v.answer.absent !== true ? { accept: false, reason: UNSAVED_WRITE_REASON, answer: v.answer } : v,
                )
                .catch((e: unknown) => ({ accept: false as const, reason: `no answer could be generated: ${firstLine(e)}`, answer: null }));
        if (verdict.accept) {
          const on = replyPages === null ? "the observed pages" : "the reply observed after the send";
          record(true, `report accepted: answer grounded on ${on} (${verdict.answer.evidence.length} claim(s))`, {
            answer: verdict.answer,
          });
          ctx.answer = verdict.answer;
          ctx.outcome = { status: "completed", verifiedBy: "grounded-answer" };
          ctx.stop = "done";
          break;
        }
        ctx.reportRejections += 1;
        // #223: an answer that is on the page but does not answer the question is no answer either.
        ctx.lastReportNotFound = (verdict.answer === null && verdict.reason === NO_ANSWER_REASON) || verdict.notAnswer === true;
        ctx.lastAbsenceUncovered = verdict.absenceUncovered === true ? verdict.reason : null;
        ctx.history.push(`report rejected: ${verdict.reason} — find the answer on the page before reporting`);
        record(false, `report rejected (${ctx.reportRejections}/${MAX_REPORT_REJECTIONS}): ${verdict.reason}`, {
          answer: verdict.answer,
        });
        if (ctx.reportRejections >= MAX_REPORT_REJECTIONS) {
          ctx.incomplete = `the model reported an answer ${ctx.reportRejections} times, but ${verdict.reason}`;
          ctx.stop = "blocked";
          break;
        }
        continue;
      }
      if (decision.op === "blocked") {
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
          continue;
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
          continue;
        }
        // #237: giving up before trying anything proves nothing about the app. Refused (and the model
        // told to explore) while the page offers controls; a model that insists ends `inconclusive`.
        const untried = modelControls.filter((c) => c.enabled);
        // A find-out goal that already made a grounded report attempt here searched the page (#207).
        if (ctx.actionAttempts === 0 && untried.length > 0 && ctx.reportRejections === 0) {
          ctx.earlyBlocked += 1;
          if (ctx.earlyBlocked <= MAX_EARLY_BLOCKED_REFUSALS) {
            const nav = [...untried.filter((c) => (c.landmark ?? null) !== null), ...untried.filter((c) => (c.landmark ?? null) === null)];
            const names = nav.slice(0, 6).map((c) => quote(c.name || c.summary, 40)).join(", ");
            const reason = `blocked refused: nothing was tried yet — ${untried.length} control(s) on this page are untried (e.g. ${names}); explore them (the navigation, settings, menus) before giving up`;
            ctx.history.push(reason);
            record(false, reason, { origin: "engine" });
            continue;
          }
          record(false, "model blocked before trying any action", { origin: "engine" });
          ctx.failure = {
            kind: "insufficient-coverage",
            message: `the model gave up before trying any of the page's ${untried.length} controls — too little exploration to conclude the goal cannot be done`,
          };
          ctx.stop = "inconclusive";
          break;
        }
        record(true, "model blocked");
        // #235: a control the goal needed may have been refused — the reason says so, actionably.
        ctx.incomplete = `the model reported the goal cannot be advanced from this page${ctx.lastRefusal === null ? "" : ` (${ctx.lastRefusal})`}`;
        ctx.stop = "blocked";
        break;
      }

      const control = decision.control;
      if (ctx.overlay !== null && (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait" || decision.op === "reload")) {
        await ctx.overlay.announce(ctx.page, { step: ctx.transcript.nextStep, strategy: "goal", op: decision.op, why: ctx.overlayWhy });
      }
      if (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait") {
        // No recorded mutation — but visible to history (J-4), and an idle streak is a stuck signal.
        let changed: boolean;
        let note: string;
        if (decision.op === "wait" && ctx.awaitingReply && ctx.lastTurn !== null && ctx.busyWaitedMs < ctx.replyWaitMs) {
          // Still listening for the last message's reply (a slow LLM turn): this wait keeps
          // listening, bounded by what is left of the reply wait, and records the reply if it lands.
          const t0 = ctx.now();
          const listen = Math.min(ctx.replyWaitMs - ctx.busyWaitedMs, 20_000);
          const reply = await waitForReply(ctx.page, { secrets: ctx.secrets, ...ctx.lastTurn, timeoutMs: listen, ceilingMs: listen });
          ctx.busyWaitedMs += ctx.now() - t0;
          if (reply.received) {
            ctx.conversation.latestReply = reply.text;
            ctx.replies.add(snap.url, reply.text);
            ctx.awaitingReply = false;
            ctx.busyWaitedMs = 0;
          }
          // #241: no reply and nothing of the send's in flight (no request, no busy sign) — this wait
          // was quiet, not patience: repeated, it ends the run instead of listening on.
          const idle = !reply.received && reply.endedBy === "idle";
          note = reply.received
            ? `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s → reply: ${quote(reply.text, 300)}`
            : idle
              ? `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s (no reply, and the page shows no sign of working on one)`
              : `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s (the reply is still on its way)`;
          changed = !idle;
          ctx.quietWaits = idle ? ctx.quietWaits + 1 : 0;
          record(true, note, reply.received ? { reply } : {});
        } else if (decision.op === "wait" && ctx.jobWaitedMs < ctx.jobWaitMs && (await readInProgressStatus(ctx.page)) !== null) {
          // The page shows an in-progress status (#92: "Simulating…", aria-busy, a job "is running")
          // — pending work even with no request in flight (the app polls). Wait it out with backoff,
          // bounded by the job-wait budget: patience, never "nothing is pending".
          const job = (await readInProgressStatus(ctx.page)) ?? "an in-progress status";
          const w = await waitOutJob(ctx.page, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
          ctx.jobWaitedMs = w.cleared ? 0 : ctx.jobWaitedMs + w.waitedMs;
          note = `waited ${(w.waitedMs / 1000).toFixed(1)}s (${
            w.cleared
              ? `the in-progress status ${job} cleared`
              : `the page still shows ${job} — the app is still working; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
          })`;
          changed = true;
          ctx.quietWaits = 0;
          record(true, note);
        } else if (decision.op === "wait" && ctx.jobWaitedMs < ctx.jobWaitMs && ctx.sideEffects.inflight().length > 0) {
          // #283: a write an earlier click fired is still in flight (a unary RPC the server holds open
          // while its job runs, past the long-poll threshold): pending work, wherever the page shows
          // it. Observe it until it resolves, bounded by the job-wait budget — never "nothing is pending".
          const what = ctx.inflightWrites();
          const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
          ctx.jobWaitedMs = w.resolved ? 0 : ctx.jobWaitedMs + w.waitedMs;
          note = `waited ${(w.waitedMs / 1000).toFixed(1)}s (${
            w.resolved
              ? `${what} (sent by an earlier click) resolved`
              : `${what} (sent by an earlier click) is still in flight — the app is still working; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
          })`;
          changed = true;
          ctx.quietWaits = 0;
          record(true, note);
        } else if (decision.op === "wait") {
          const t0 = ctx.now();
          changed = await waitForChange(ctx.page, ctx.waitOpMs);
          // No change while the app is still busy (a request in flight, a spinner) is patience —
          // a slow reply — not idleness: it does not count toward the idle cap.
          // Bounded: patience lasts as long as a conversational reply may take (`replyWaitMs`).
          // A sent message whose reply has not arrived yet is also still in flight.
          const pending =
            !changed && (ctx.awaitingReply || (await stillBusy(ctx.page)) || (await readInProgressStatus(ctx.page)) !== null);
          const busy = pending && ctx.busyWaitedMs < ctx.replyWaitMs;
          ctx.busyWaitedMs = busy ? ctx.busyWaitedMs + (ctx.now() - t0) : 0;
          // Nothing changed and nothing is pending: waiting again cannot help (#79).
          ctx.quietWaits = changed || pending ? 0 : ctx.quietWaits + 1;
          note = `waited ${((ctx.now() - t0) / 1000).toFixed(1)}s (${
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
          ctx.quietWaits = 0;
          // #109 — act() itself polls the scroll position (of the nearest scrollable container under
          // the pointer, else the window) until it settles, so this never reads immediately after the
          // wheel event before the scroll it dispatched has actually happened.
          const r = await act(cfg.actor, { op: decision.op, control: null });
          if (r.ok && r.moved === true) ctx.scrollsSinceMutation += 1;
          changed = r.moved === true;
          ctx.lastScrollMoved = r.ok && changed;
          note = `${decision.op === "scroll_down" ? "scrolled down" : "scrolled up"} (${changed ? "the page moved" : "the page did not move — nothing more that way"})`;
          record(r.ok, r.ok ? note : r.reason);
        }
        ctx.history.push(note);
        if (changed) {
          ctx.idleSteps = 0;
      ctx.idleSince = null;
          ctx.idleSince = null;
        } else {
          ctx.idleSteps += 1;
          ctx.idleSince = ctx.idleSince ?? ctx.now();
        }
        ctx.lastActedOp = decision.op;
        ctx.statusAfter = decision.op === "wait" ? "waiting" : "scrolling";
        if (ctx.quietWaits >= MAX_QUIET_WAITS) {
          const cause = ctx.blockingCause();
          ctx.incomplete = `stuck: ${cause ?? `${ctx.quietWaits} waits changed nothing and nothing was pending`}`;
          ctx.stop = "no-progress";
          break;
        }
        // Stuck = several idle steps AND for as long as a slow reply may take (`replyWaitMs`): a long
        // simulation or LLM turn gets that long before the run gives up on it.
        if (ctx.idleSteps >= MAX_IDLE_STEPS && ctx.idleSince !== null && ctx.now() - ctx.idleSince >= ctx.replyWaitMs) {
          ctx.incomplete = `stuck: ${ctx.idleSteps} wait/scroll steps over ${Math.round((ctx.now() - (ctx.idleSince ?? ctx.now())) / 1000)}s changed nothing`;
          ctx.stop = "no-progress";
          break;
        }
        continue;
      }
      ctx.idleSteps = 0;
      ctx.quietWaits = 0;
      ctx.actionAttempts += 1;

      if (decision.op === "reload") {
        // A reload is a navigation to the same page: recorded as such (replay re-loads the page),
        // and it counts as an action. Returning to the state the page had is its point, never a stall.
        if (!ctx.tracker.mayAct()) {
          record(false, "action budget exhausted", { origin: "engine" });
          ctx.stop = "exhausted";
          break;
        }
        // A write this run fired is still in flight (a job it started): reloading now abandons it and
        // invites a duplicate. Observe until it resolves instead (#92).
        if (ctx.sideEffects.inflight().length > 0) {
          const what = ctx.sideEffects
            .inflight()
            .map((w) => `${w.method} ${w.path}`)
            .join(", ");
          const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, ctx.replyCeilingMs);
          const note = `reload deferred: ${what} (sent by an earlier click) is still in flight — waited ${(w.waitedMs / 1000).toFixed(1)}s, ${
            w.resolved ? "it resolved" : "it is still in flight"
          }`;
          ctx.history.push(note);
          record(false, note, { origin: "engine" });
          ctx.lastActedOp = decision.op;
          continue;
        }
        const at = ctx.now();
        ctx.effectLog.mark(ctx.transcript.nextStep, "reload");
        cfg.onAction?.({ step: ctx.transcript.nextStep, at });
        ctx.readOnly?.beginAction();
        const r = await act(cfg.actor, { op: "reload", control: null });
        if (r.ok) {
          ctx.recorder.navigate(ctx.page.url(), at);
          ctx.track.lastMutation = { at, before: snap.signature, seenBefore: new Set(ctx.seen), label: "reload", recordIndex: ctx.recorder.stepCount - 1, sawNewState: false };
          ctx.refusedSinceMutation = 0;
          ctx.scrollsSinceMutation = 0;
          ctx.track.lastRecordedTarget = null;
          ctx.tracker.countAction();
          ctx.failedActs.succeeded();
          // A reload retries the last submit: retyping what it sent is a retry, not a repeat (#184).
          ctx.valueLog.reloaded();
          ctx.save.reset();
          ctx.history.push(r.note === undefined ? "reloaded the page" : `reloaded the page (${r.note})`);
        } else {
          ctx.history.push(`reload failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason ?? r.note);
        ctx.lastActedOp = decision.op;
        continue;
      }

      // Target-requiring op with no valid target → fail-closed.
      if (control === null || decision.targetMissing) {
        record(false, "no valid target (fail-closed)", { origin: "engine" });
        ctx.stop = "blocked";
        break;
      }
      if (!ctx.tracker.mayAct()) {
        record(false, "action budget exhausted", { origin: "engine" });
        ctx.stop = "exhausted";
        break;
      }
      // #158 — a read-only (find-out) goal: code refuses a control that would start a write flow,
      // submit a form, send a message or upload. Refused before any interaction, recorded, told.
      if (ctx.readOnly !== null) {
        const refusal = ctx.readOnly.refuses(decision.op, control);
        if (refusal !== null) {
          ctx.history.push(refusal);
          record(false, refusal, { origin: "engine" });
          ctx.lastActedOp = decision.op;
          continue;
        }
      }
      // The shared safety policy (#116): a session-ending, destructive, paid or --deny'd control is
      // never clicked unless the goal itself asks for it (or --allow-destructive). Refused, recorded.
      if (decision.op === "click") {
        const unsafe = ctx.safety.refuses(control);
        if (unsafe !== null) {
          ctx.refusedKeys.add(keyOf(control));
          ctx.lastRefusal = unsafe.reason;
          ctx.history.push(unsafe.reason);
          record(false, unsafe.reason, { origin: "engine" });
          ctx.lastActedOp = decision.op;
          continue;
        }
      }
      // #245: the demo overlay says what is about to happen and highlights the target (display only) —
      // before the action's attribution window opens, so its brief pause never counts as the action's.
      if (ctx.overlay !== null) {
        await ctx.overlay.announce(
          ctx.page,
          { step: ctx.transcript.nextStep, strategy: "goal", op: decision.op, target: control.name || control.summary, why: ctx.overlayWhy },
          control,
        );
      }

      // #303: the page right before the action (and, with the perception's capture, the route's
      // volatility baseline) — the action's delta is read at the next perception.
      if (ctx.deltas !== null) await ctx.deltas.beforeAction(hangRoute(snap.url), decision.op, control).catch(() => ctx.deltas!.discard());
      const at = ctx.now();
      const risk = ctx.safety.riskOf(control);
      ctx.effectLog.mark(ctx.transcript.nextStep, control.name || control.summary, risk);
      cfg.onAction?.({ step: ctx.transcript.nextStep, at });
      ctx.readOnly?.beginAction();

      // #150 — mission spend budget, pre-action: a paid control (#116) whose declared cost estimate
      // would cross what remains of the budget is refused BEFORE it fires — code decides, never the
      // model. The refusal is recorded and the run stops cleanly with `stop: "budget"`.
      if (cfg.onBeforeAction !== undefined) {
        const guard = await cfg.onBeforeAction({ op: decision.op, control: control.name || control.summary, paid: risk === "paid" });
        if (guard.refuse) {
          ctx.history.push(guard.reason);
          record(false, guard.reason, { origin: "engine" });
          ctx.incomplete = guard.reason;
          ctx.stop = "budget";
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
          status: ctx.status,
          exclude: decision.op === "type" ? control : null,
        });
        for (const { control: field, field: binding, why } of due) {
          if (!ctx.tracker.mayAct() || !(await secretFieldNeedsValue(ctx.page, field))) continue;
          const t = ctx.now();
          const value = secretFieldValue(binding, t);
          const placeholder = secretPlaceholder(binding);
          const r = await act(cfg.actor, { op: "type", control: field, value });
          const cause = why === "submit" ? `before submitting with ${control.name || control.summary}` : "a validation message names it";
          if (r.ok) {
            ctx.recorder.fill(field.descriptor, { redacted: true, length: value.length }, t);
            ctx.noteMutation(`type ${field.name}`, field.descriptor, snap.signature, t);
            ctx.tracker.countAction();
            ctx.history.push(`typed ${placeholder} into the empty ${field.name} (bound secret, typed by code — ${cause})`);
          } else {
            ctx.history.push(`type into ${field.name} failed: ${(r.reason ?? "?").split(value).join(placeholder)}`);
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
          ctx.recorder.fill(control.descriptor, { redacted: true, length: value.length }, at);
          ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value });
          ctx.tracker.countAction();
          ctx.history.push(`typed ${placeholder} into ${control.name} (bound secret, typed by code)`);
        } else {
          ctx.history.push(`type failed: ${(r.reason ?? "?").split(value).join(placeholder)}`);
        }
        record(r.ok, r.ok ? `typed ${placeholder} (bound secret, typed by code)` : (r.reason ?? "").split(value).join(placeholder), {
          value: placeholder,
        });
        ctx.lastActedOp = decision.op;
        if (!r.ok && (await ctx.noteFailedAct(control, (r.reason ?? "").split(value).join(placeholder)))) break;
        continue;
      }

      // #281: a field bound to a type fixture — code types the file's exact text (line breaks kept,
      // never capped, never generated). The Recording keeps it so a Journey replays it exactly,
      // unless it holds a registered run secret (then `{ redacted: true }`, like a bound secret).
      const fixtureBinding = decision.op === "type" ? boundTypeFixture(control, cfg.typeFixtures) : null;
      if (fixtureBinding !== null) {
        const value = fixtureBinding.text;
        const placeholder = typeFixturePlaceholder(fixtureBinding);
        const holdsSecret = ctx.secrets.some((sec) => sec !== "" && value.includes(sec));
        const r = await act(cfg.actor, { op: "type", control, value });
        if (r.ok) {
          ctx.recorder.fill(control.descriptor, holdsSecret ? { redacted: true, length: value.length } : value, at);
          ctx.valueLog.typed(control.name || control.summary, value);
          ctx.save.noteTyped(control.name || control.summary, value);
          ctx.observed.noteOwnInput(value);
          ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value });
          ctx.tracker.countAction();
          ctx.cleared(control);
          ctx.history.push(`typed ${placeholder} into ${control.name} (type fixture, typed verbatim by code)`);
        } else {
          ctx.history.push(`type failed: ${redactText((r.reason ?? "?").split(value).join(placeholder), ctx.secrets)}`);
        }
        record(r.ok, r.ok ? `typed ${placeholder} (type fixture, typed verbatim by code)` : redactText((r.reason ?? "").split(value).join(placeholder), ctx.secrets), {
          value: placeholder,
        });
        ctx.lastActedOp = decision.op;
        continue;
      }

      // An edit INSIDE rich text (#148): the generator proposes an anchored edit, code validates it
      // (see ./rich-text.ts) and the shared page function performs it — never a whole retype.
      if (decision.op === "edit_text") {
        const planned =
          boundSecretField(control, cfg.secretFields) !== null
            ? { refused: "a bound secret field is never edited as rich text" }
            : await readEditableText(ctx.page, control).then((currentText) =>
                currentText === null
                  ? { refused: "the element's text could not be read" }
                  : planTextEdit(cfg.gen, { goal: cfg.goal, control, currentText, history: ctx.history, secrets: ctx.secrets }),
              ).catch((e: unknown) => ({ refused: `edit generation unavailable: ${firstLine(e)}` }));
        if ("refused" in planned) {
          ctx.history.push(`edit in ${control.name || control.summary} refused: ${planned.refused}`);
          record(false, planned.refused, { origin: "engine" });
        } else {
          const r = await act(cfg.actor, { op: "edit_text", control, edit: planned.edit });
          const what = describeTextEdit(planned.edit);
          if (r.ok) {
            ctx.recorder.editText(control.descriptor, planned.edit, at);
            ctx.noteMutation(`edit ${control.name}`, control.descriptor, snap.signature, at);
            ctx.tracker.countAction();
            ctx.history.push(`${what} in ${control.summary.slice(0, 80)}`);
            ctx.cleared(control);
          } else {
            ctx.history.push(`edit failed: ${ctx.failNote(r.reason, control)}`);
          }
          record(r.ok, r.ok ? what : ctx.failNote(r.reason, control), planned.edit.value === undefined ? {} : { value: planned.edit.value });
          if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
            ctx.lastActedOp = decision.op;
            break;
          }
        }
        ctx.lastActedOp = decision.op;
        continue;
      }

      // The repeated-type anti-pattern (independent code): typing again into a field that holds text
      // this run typed and never sent overwrites it and still delivers nothing. Submit instead, and
      // count it as a stuck signal.
      let op = decision.op;
      let forcedNote: string | null = null;
      if (op === "type" && ctx.unsent.wouldRepeat(keyOf(control))) {
        const n = ctx.unsent.noteRepeat();
        forcedNote = `repeated type into ${control.name} without sending (stuck signal ${n}/${MAX_REPEAT_TYPE_SIGNALS}) — sent instead`;
        if (n >= MAX_REPEAT_TYPE_SIGNALS) {
          record(false, forcedNote, { origin: "engine" });
          ctx.incomplete = `stuck: typed into ${quote(control.name, 60)} ${n} times without sending`;
          ctx.stop = "no-progress";
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
        const stuck = repetitiveTurns(ctx.conversation.sent);
        ctx.stuckTurns = stuck ? ctx.stuckTurns + 1 : 0;
        if (ctx.stuckTurns > STUCK_TURNS) {
          const reason = `stuck: the messages kept acknowledging or repeating without answering the assistant (still after ${STUCK_TURNS} nudged turns)`;
          record(false, reason, { op });
          ctx.incomplete = reason;
          ctx.stop = "no-progress";
          break;
        }
        let text: string | null;
        try {
          text = await chatReply(cfg.gen, {
            goal: cfg.goal,
            fieldLabel: control.name || control.summary,
            latestReply: ctx.conversation.latestReply,
            sentMessages: ctx.conversation.sent,
            maxChars: ctx.replyMaxChars,
            secrets: ctx.secrets,
            question: lastQuestion(ctx.conversation.latestReply),
            stuck,
          });
        } catch (e) {
          const reason = `message generation unavailable: ${firstLine(e)}`;
          ctx.history.push(`${op} skipped: ${reason}`);
          record(false, reason, { op, origin: "engine" });
          ctx.lastActedOp = op;
          continue;
        }
        if (text === null) {
          ctx.blockers.failClosed = `no message for ${quote(control.name || control.summary, 80)} (the message generator returned none)`;
          record(false, "no message available (fail-closed)", { op, origin: "engine" });
          ctx.incomplete = "no message could be generated for the conversation";
          ctx.stop = "blocked";
          break;
        }
        const message = text;
        if (ctx.conversation.sent.some((m) => sameMessage(m, message))) {
          const n = ctx.unsent.noteRepeat();
          const reason = `message not sent: it repeats an earlier message (stuck signal ${n}/${MAX_REPEAT_TYPE_SIGNALS})`;
          ctx.history.push(`${reason} — answer the latest reply with something new`);
          record(false, reason, { op, message, origin: "engine" });
          ctx.lastActedOp = op;
          if (n >= MAX_REPEAT_TYPE_SIGNALS) {
            ctx.incomplete = "stuck: the generated messages kept repeating";
            ctx.stop = "no-progress";
            break;
          }
          continue;
        }
        if (op === "send") {
          const baseline = await readPageText(ctx.page, ctx.secrets);
          const before = new Set(keys.keys());
          const sendBackground = backgroundEndpoints(monitorFor(ctx.page), at, ctx.turnWrites);
          const r = await act(cfg.actor, { op: "send", control, value: message, candidates: snap.controls });
          if (!r.ok) {
            ctx.history.push(`send failed: ${r.reason ?? "?"}`);
            record(false, forcedNote === null ? r.reason : `${forcedNote}; ${r.reason ?? ""}`, { op, message });
            ctx.lastActedOp = op;
            if (await ctx.noteFailedAct(control, r.reason)) break;
            continue;
          }
          // #241: a send that started no request and changed nothing on the page was not sent (Enter
          // in a field whose real submit is a separate control): a failed send, never a pending reply.
          const checkedFrom = ctx.now();
          await monitorFor(ctx.page).waitSettled({ ceilingMs: 3_000 }).catch(() => undefined);
          if (
            requestsStartedSince(monitorFor(ctx.page), at, sendBackground).length === 0 &&
            newPageText(baseline, await readPageText(ctx.page, ctx.secrets), "").trim() === ""
          ) {
            const reason = `message was not sent: ${r.submittedVia?.kind === "click" ? `clicking ${quote(r.submittedVia.control.name, 40)}` : "Enter"} in ${quote(control.name || control.summary, 60)} started no request and changed nothing on the page`;
            ctx.history.push(`${reason} — look for a send / continue control that submits it (it may need something else first)`);
            record(false, reason, { op, message });
            ctx.lastActedOp = op;
            if (await ctx.noteFailedAct(control, reason)) break;
            continue;
          }
          ctx.recorder.fill(control.descriptor, message, at);
          const via = r.submittedVia;
          if (via !== undefined && via.kind === "click") ctx.recorder.click(via.control.descriptor, ctx.now());
          else ctx.recorder.press("Enter", control.descriptor, ctx.now());
          ctx.noteMutation(`send ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: message });
          ctx.tracker.countAction();
          ctx.unsent.submitted();
          ctx.conversation.sent.push(message);
          ctx.preSend ??= baseline;
          // The reply wait counts from the send: the check above already waited part of it.
          const checkedMs = ctx.now() - checkedFrom;
          // The send's own writes (started by now: the not-sent check above settled) — never background.
          for (const k of writesStartedSince(monitorFor(ctx.page), at, ctx.isWrite)) if (!sendBackground.has(k)) ctx.turnWrites.add(k);
          const listened = await waitForReply(ctx.page, {
            secrets: ctx.secrets,
            baseline,
            sent: message,
            sentAt: at,
            background: sendBackground,
            timeoutMs: Math.max(1, ctx.replyWaitMs - checkedMs),
            ceilingMs: Math.max(1, ctx.replyCeilingMs - checkedMs),
          });
          const reply: ReplyResult = { ...listened, waitedMs: listened.waitedMs + checkedMs };
          if (reply.received) {
            ctx.conversation.latestReply = reply.text;
            ctx.replies.add(snap.url, reply.text);
          }
          ctx.awaitingReply = !reply.received;
          ctx.busyWaitedMs = reply.waitedMs;
          ctx.lastTurn = { baseline, sent: message, sentAt: at, background: sendBackground };
          ctx.offerBaseline = before;
          ctx.history.push(
            `sent ${quote(message)} via ${via?.kind === "click" ? `"${via.control.name}"` : "Enter"} → ` +
              (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
          );
          ctx.noteStuckConversation(snap.controls);
          record(true, forcedNote ?? undefined, { op, message, reply });
          ctx.lastActedOp = op;
          continue;
        }
        // A plain `type` of a message: typed, NOT sent yet (the Send control or Enter still has to follow).
        const r = await act(cfg.actor, { op: "type", control, value: message });
        if (r.ok) {
          ctx.recorder.fill(control.descriptor, message, at);
          ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: message });
          ctx.tracker.countAction();
          ctx.unsent.typed(keyOf(control), control.name, message, true);
          ctx.history.push(`typed ${quote(message, 80)} into ${control.name} — NOT sent yet (send it)`);
        } else {
          ctx.history.push(`type failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason, { message });
        ctx.lastActedOp = op;
        if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) break;
        continue;
      }

      if (op === "send") {
        // Not message-shaped after all (unreachable: `send` is always a message) — fail closed.
        record(false, "send without a message (fail-closed)", { op, origin: "engine" });
        ctx.stop = "blocked";
        break;
      }

      if (op === "select" && control.options !== undefined && control.options.length > 0) {
        // Options-aware select (J-5): the generator sees the real options, and code selects only an
        // option the page actually has — never a guessed value.
        // #273: never the option already selected (a no-op), never a placeholder ("—", "Select…")
        // unless the goal asks to clear the field.
        const current = control.selected ?? null;
        const clearing = CLEARS_FIELD.test(cfg.goal);
        const choices = control.options.filter((o) => o !== current && (clearing || !isPlaceholderOption(o)));
        const untried = (): string => choices.map((o) => quote(o, 60)).join(", ");
        if (choices.length === 0) {
          const reason = `no other option to choose in ${control.name || control.summary}${current === null ? "" : ` (${quote(current, 60)} is already selected)`}`;
          ctx.history.push(`select refused: ${reason}`);
          record(false, reason, { origin: "engine" });
          ctx.lastActedOp = op;
          continue;
        }
        let text: string | null;
        try {
          ({ text } = await ctx.fillHelper.valueFor({
            fieldLabel: control.name || control.summary,
            goal: cfg.goal,
            visibleContext: snap.controls.map((c) => c.summary).join("; "),
            history: ctx.history,
            secrets: ctx.secrets,
            options: choices,
          }));
        } catch (e) {
          const reason = `value generation unavailable: ${firstLine(e)}`;
          ctx.history.push(`select skipped: ${reason}`);
          record(false, reason, { origin: "engine" });
          ctx.lastActedOp = op;
          continue;
        }
        const named = text === null ? null : matchOption(text, control.options);
        if (named !== null && !choices.includes(named)) {
          // The current option (or a placeholder) again: never acted — the page would not change.
          ctx.fillHelper.commit();
          const why = named === current ? `${quote(named, 60)} is already selected` : `${quote(named, 60)} is a placeholder, not a choice`;
          const reason = `select refused: ${why} in ${control.name || control.summary} — options not tried: ${untried()}`;
          ctx.history.push(reason);
          record(false, reason, { origin: "engine", value: named });
          ctx.lastActedOp = op;
          continue;
        }
        const option = named;
        if (option === null) {
          ctx.fillHelper.commit();
          const reason = `no valid option chosen for ${control.name} (fail-closed)`;
          ctx.blockers.failClosed = `no valid option for field ${quote(control.name || control.summary, 80)} (fail-closed)`;
          ctx.history.push(`select failed: ${reason}`);
          record(false, reason, { origin: "engine" });
          ctx.lastActedOp = op;
          continue;
        }
        const r = await act(cfg.actor, { op: "select", control, value: option });
        if (r.ok) {
          ctx.recorder.select(control.descriptor, option, at);
          ctx.noteMutation(`select ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: option });
          ctx.tracker.countAction();
          ctx.fillHelper.commit();
          ctx.history.push(`selected ${quote(option, 80)} in ${control.name}`);
          ctx.cleared(control);
        } else {
          ctx.history.push(`select failed: ${ctx.failNote(r.reason, control)}`);
        }
        record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control), { value: option });
        ctx.lastActedOp = op;
        if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) break;
        continue;
      }

      if (decision.op === "type" || decision.op === "select") {
        // The generator supplies the text/option (never the model's choice head). It is a HELPER:
        // when it is unavailable the step fails (recorded, visible to the model) and the run goes on.
        let text: string | null;
        let rejected: string | undefined;
        let source: "goal" | "model" | undefined;
        try {
          ({ text, rejected, source } = await ctx.fillHelper.valueFor({
            fieldLabel: control.name || control.summary,
            goal: cfg.goal,
            visibleContext: snap.controls.map((c) => c.summary).join("; "),
            history: ctx.history,
            secrets: ctx.secrets,
            // A text field's value is field-scoped and checked before it is typed (#71); in an
            // add-another flow it is the next item, not one already submitted into this field (#123).
            ...(decision.op === "type"
              ? { field: { tag: control.tag, inputType: control.inputType }, alreadyUsed: ctx.valueLog.used(control.name || control.summary) }
              : {}),
          }));
        } catch (e) {
          const reason = `value generation unavailable: ${firstLine(e)}`;
          ctx.history.push(`${decision.op} skipped: ${reason}`);
          record(false, reason, { origin: "engine" });
          ctx.lastActedOp = decision.op;
          continue;
        }
        if (rejected !== undefined) {
          // Not a value for this one field (an essay, a JSON map, a `Label:` echo…): a failed act the
          // model sees in its history, never typed.
          const reason = `typed value rejected: ${rejected}`;
          ctx.history.push(`type into ${control.name} failed: ${reason} — the value must be only what goes in this one field`);
          record(false, reason, { origin: "engine" });
          ctx.lastActedOp = decision.op;
          continue;
        }
        if (text === null) {
          // The generator will not honestly supply a required value → never guess.
          ctx.blockers.failClosed = `no value for field ${quote(control.name || control.summary, 80)} (the value generator returned none)`;
          record(false, "no value available (fail-closed)", { origin: "engine" });
          ctx.stop = "blocked";
          break;
        }
        // Free-text form values are bounded too (dogfood: 2–3k-char markdown essays in "Rationale").
        // #281: a value the goal states verbatim is typed as stated (its line breaks kept), never capped.
        if (decision.op === "type" && source !== "goal" && (control.tag === "textarea" || control.inputType === "text" || control.inputType === "")) {
          text = capFormText(text, FORM_TEXT_MAX_CHARS, control.tag === "textarea");
        }
        // #242: retyping a field whose last type(s) changed nothing else — a search-like field is
        // submitted this time (it searches on Enter); any other field ends the run once it is stuck.
        const retypes = decision.op === "type" && ctx.typeNoEffect?.key === keyOf(control) ? ctx.typeNoEffect.count : 0;
        if (retypes >= MAX_TYPE_NO_EFFECT) {
          const reason = `stuck: typed into ${quote(control.name || control.summary, 60)} ${retypes} times in a row: nothing changed but its own value (no request, nothing else on the page)`;
          record(false, reason, { origin: "engine" });
          ctx.incomplete = reason;
          ctx.stop = "no-progress";
          break;
        }
        const submitSearch = retypes >= 1 && searchLike(control);
        const typedAt = ctx.now();
        const typedBackground = decision.op === "type" ? backgroundEndpoints(monitorFor(ctx.page), typedAt) : new Set<string>();
        const typedState = stateBesides(snap, keyOf(control));
        const r = submitSearch
          ? await act(cfg.actor, { op: "send", control, value: text, candidates: snap.controls })
          : await act(cfg.actor, { op: decision.op, control, value: text });
        if (r.ok && submitSearch) {
          ctx.recorder.fill(control.descriptor, text, at);
          const via = r.submittedVia;
          if (via !== undefined && via.kind === "click") ctx.recorder.click(via.control.descriptor, ctx.now());
          else ctx.recorder.press("Enter", control.descriptor, ctx.now());
          ctx.valueLog.typed(control.name || control.summary, text);
          ctx.valueLog.submitted();
          ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: text });
          ctx.tracker.countAction();
          ctx.fillHelper.commit();
          ctx.typeNoEffect = null;
          ctx.typeCredit = null;
          ctx.history.push(
            `submitted ${quote(control.name || control.summary, 60)} with ${via?.kind === "click" ? `its ${quote(via.control.name, 40)} button` : "Enter"} (typing alone fired nothing) — searched for ${quote(text, 80)}`,
          );
          ctx.cleared(control);
          record(true, "typed and submitted (typing alone fired nothing)", { value: text });
          ctx.lastActedOp = decision.op;
          continue;
        }
        if (r.ok) {
          if (decision.op === "type") {
            ctx.typeProbe = { key: keyOf(control), label: quote(control.name || control.summary, 60), at: typedAt, background: typedBackground, state: typedState };
            // A form field (not a message composer) is submitted with its form's own button; retyping
            // it is a correction, not the chat anti-pattern — so only composers are tracked.
            ctx.recorder.fill(control.descriptor, text, at);
            ctx.valueLog.typed(control.name || control.summary, text);
            if (!ctx.isBound(control) && !isCredentialField(control) && !sendable(control)) {
              ctx.save.noteTyped(control.name || control.summary, text);
              // #239: until a write after it succeeds, the field shows what the run entered — not grounds.
              ctx.observed.noteOwnInput(text);
            }
          } else ctx.recorder.select(control.descriptor, text, at);
          ctx.noteMutation(`${decision.op} ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: text });
          ctx.tracker.countAction();
          ctx.fillHelper.commit();
          ctx.history.push(`${decision.op === "type" ? "typed into" : "selected in"} ${control.name}`);
          ctx.cleared(control);
        } else {
          ctx.history.push(`${decision.op} failed: ${ctx.failNote(r.reason, control)}`);
        }
        record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control), { value: text });
        if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
          ctx.lastActedOp = decision.op;
          break;
        }
      } else if (decision.op === "click") {
        // A click that submits typed text (the composer's Send) or picks a quick reply offered with the
        // latest reply is a conversation turn: its reply is awaited like a `send`'s.
        const pendingTexts = [...ctx.unsent.pending().values()].filter((p) => p.message).map((p) => p.text);
        const submits = pendingTexts.length > 0 && isSubmitControl(control);
        // A quick reply: a short button that arrived with the latest reply (a chip, "Yes, draft it").
        const quickReply =
          ctx.offeredKeys.has(keyOf(control)) && control.role === "button" && control.name.length <= 60 && !/[→›»]/.test(control.name);
        const turn = submits || quickReply;
        // The repeated-side-effect guard (#92): a click that already fired a write on this page is not
        // re-fired while that write is in flight (wait for it instead) or after it went through,
        // unless the page offers a retry. Refused — never clicked — and the reason is recorded.
        const repeat = ctx.sideEffects.check(keyOf(control), safePath(snap.url), {
          controlNames: snap.controls.map((c) => c.name),
          alerts: ctx.status.alerts,
        });
        if (repeat.refuse) {
          let note = repeat.reason;
          if (repeat.inflight) {
            const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, ctx.replyCeilingMs);
            note += ` (waited ${(w.waitedMs / 1000).toFixed(1)}s: ${w.resolved ? "it resolved" : "it is still in flight"})`;
          }
          ctx.history.push(note);
          record(false, note, { origin: "engine" });
          ctx.lastActedOp = decision.op;
          continue;
        }
        const baseline = turn ? await readPageText(ctx.page, ctx.secrets) : "";
        ctx.sideEffects.beginClick(keyOf(control), control.name || control.summary, safePath(snap.url), ctx.now());
        const r = await act(cfg.actor, { op: "click", control });
        let reply: ReplyResult | undefined;
        let message: string | undefined;
        if (r.ok) {
          ctx.recorder.click(control.descriptor, at);
          ctx.noteMutation(`click ${control.name}`, control.descriptor, snap.signature, at, undefined, control.role === "link" ? hangRoute(snap.url) : null, hangRoute(snap.url));
          ctx.tracker.countAction();
          if (isSubmitControl(control)) ctx.unsent.submitted();
          // What was typed has now been submitted (a form's button): an add-another flow's next
          // item must differ from it (#123).
          if (buttonLike(control) || control.submits === true) {
            ctx.valueLog.submitted();
            ctx.save.noteSubmitClick(control.name || control.summary);
          }
          // Toggling an input (a checkbox, a radio, a switch) changes what a repeat would send (#92).
          if (TOGGLE_ROLES.has(control.role) || (control.tag === "input" && control.inputType !== "submit" && control.inputType !== "button")) {
            // A radio/option now holds "selected"; a checkbox/switch flips — so toggling twice is no
            // change (#123). Clicking into a text input changes nothing it would send.
            const picks = ["radio", "option", "menuitemradio"].includes(control.role) || control.inputType === "radio";
            const flips = ["checkbox", "switch", "menuitemcheckbox"].includes(control.role) || control.inputType === "checkbox";
            if (picks) ctx.sideEffects.inputChanged(keyOf(control), "selected");
            else if (flips) ctx.sideEffects.inputChanged(keyOf(control), { toggled: true });
          }
          if (turn) {
            message = submits ? pendingTexts.join("\n") : control.name;
            ctx.conversation.sent.push(message);
            ctx.preSend ??= baseline;
            // The endpoints requested before the click (computed after it: only requests started
            // before `at` count) — the turn's own write is its work, never background (#241 × #283).
            const turnBackground = backgroundEndpoints(monitorFor(ctx.page), at, ctx.turnWrites);
            for (const k of writesStartedSince(monitorFor(ctx.page), at, ctx.isWrite)) if (!turnBackground.has(k)) ctx.turnWrites.add(k);
            reply = await waitForReply(ctx.page, {
              secrets: ctx.secrets,
              baseline,
              sent: message,
              sentAt: at,
              background: turnBackground,
              timeoutMs: ctx.replyWaitMs,
              ceilingMs: ctx.replyCeilingMs,
            });
            if (reply.received) {
              ctx.conversation.latestReply = reply.text;
              ctx.replies.add(snap.url, reply.text);
            }
            ctx.awaitingReply = !reply.received;
            ctx.busyWaitedMs = reply.waitedMs;
            ctx.lastTurn = { baseline, sent: message, sentAt: at, background: turnBackground };
            ctx.offerBaseline = new Set(keys.keys());
            ctx.history.push(
              `clicked ${control.name}${quickReply ? " (a quick reply)" : ""} → ` +
                (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
            );
            ctx.noteStuckConversation(snap.controls);
          } else {
            ctx.history.push(`clicked ${control.name}`);
          }
          ctx.cleared(control);
        } else {
          ctx.history.push(`click failed: ${ctx.failNote(r.reason, control)}`);
          // #90 — a real "intercepts pointer events" failure proves what covers this control (and,
          // in practice, its neighbours under the same backdrop): remember it so the model is not
          // offered another target it covers until the page changes.
          const interceptor = r.reason === undefined ? null : parseInterceptor(r.reason);
          if (interceptor !== null && !ctx.blockedInterceptors.includes(interceptor)) {
            ctx.blockedInterceptors = [...ctx.blockedInterceptors, interceptor];
            ctx.blockedSinceSignature = snap.signature;
          }
        }
        record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control), {
          ...(message === undefined ? {} : { message }),
          ...(reply === undefined ? {} : { reply }),
        });
        if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
          ctx.lastActedOp = decision.op;
          break;
        }
      } else {
        // upload — act fails closed without a fixture.
        const r = await act(cfg.actor, { op: "upload", control, fixture: ctx.fixture });
        if (r.ok && ctx.fixture !== null) {
          // The recorded path goes through the shared redaction seam: a path that
          // contains a registered secret is recorded redacted (replay then fails
          // closed) rather than persisting the secret into the artifact.
          const recordedFile: ValueOrVar =
            redactText(ctx.fixture, ctx.secrets) === ctx.fixture
              ? { redacted: false, value: ctx.fixture }
              : { redacted: true, length: ctx.fixture.length };
          ctx.recorder.upload(control.descriptor, recordedFile, at);
        ctx.noteMutation(`upload into ${control.name}`, control.descriptor, snap.signature, at);
          ctx.tracker.countAction();
          ctx.history.push(`uploaded the fixture into ${control.name}`);
          ctx.fixtureAttached = true;
          ctx.cleared(control);
        } else {
          ctx.history.push(`upload failed: ${ctx.failNote(r.reason, control)}`);
        }
        record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control));
        if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
          ctx.lastActedOp = decision.op;
          break;
        }
      }

      ctx.lastActedOp = decision.op;
    }
  } catch (e) {
    if (!(e instanceof FirstNavigationFailedSentinel)) {
      // Engine failure (browser/page crash, automation error outside `act`'s own guard): a typed
      // `crashed` stop carrying the partial transcript and Recording — the run never throws here.
      ctx.failure = describeFailure(e, ctx.crashWatch.signals());
      // #226: the app stopped answering navigation (a frozen backend) — nothing in the engine broke:
      // `inconclusive` with the typed `target-unresponsive` reason, never `crashed`.
      // #296: likewise a page whose renderer stopped answering (closed by the liveness watchdog).
      ctx.stop = isTargetUnresponsive(ctx.failure) || isPageUnresponsive(ctx.failure) ? "inconclusive" : "crashed";
    }
    // Else (#128): `stop`/`failure` were already set to `inconclusive`/`target-unreachable` at the
    // point the first navigation failed — the sentinel only unwound the loop, nothing more to do.
  }

  // #230: a no-progress stop on an app that stopped answering is `target-unresponsive` — before the
  // host is blamed for it (#203).
  if (ctx.stop === "no-progress") {
    const unresponsive = await targetStoppedAnswering(ctx.livenessOf()).catch(() => null);
    if (unresponsive !== null) {
      ctx.failure = { kind: "target-unresponsive", message: unresponsive };
      ctx.stop = "inconclusive";
    }
  }

  // #203: a no-progress stop met while the host was starved is the host, not the app.
  if (ctx.stop === "no-progress" && cfg.hostHealth !== undefined) {
    const judged = await cfg.hostHealth.judge();
    if (judged.starved !== null) ctx.degradedStop("no-progress", "the last actions left the page unchanged", judged.starved);
  }

  // #238 — the latest report's answer was "none exists", but the run never covered enough of the app
  // to establish it: it proved nothing either way — `inconclusive` (insufficient coverage), never a defect.
  if (ctx.lastAbsenceUncovered !== null && ctx.answer === undefined && (ctx.stop === "no-progress" || ctx.stop === "blocked" || ctx.stop === "exhausted") && ctx.failure === undefined) {
    ctx.failure = { kind: "insufficient-coverage", message: ctx.lastAbsenceUncovered };
    ctx.incomplete = ctx.lastAbsenceUncovered;
    ctx.stop = "inconclusive";
    ctx.lastReportNotFound = false;
  }

  // #207 — a run whose latest report found no answer, and that then stopped for want of progress or
  // gave up, ends saying so and what it searched — not a generic "no progress" / "blocked".
  if (ctx.lastReportNotFound && ctx.answer === undefined && (ctx.stop === "no-progress" || ctx.stop === "blocked") && ctx.failure === undefined) {
    ctx.incomplete = answerNotFoundReason(ctx.observed.pages());
  }

  await ctx.readOnly?.disarm();
  ctx.page.off("request", ctx.onRequestSeen);
  ctx.page.off("response", ctx.onDocumentResponse);
  const finished = ctx.recorder.tryFinish({ intent: cfg.goal });
  const cause = ctx.blockingCause();
  const finalOutcome: RunOutcome =
    ctx.stop === "done" && ctx.outcome !== null && finished.ok
      ? ctx.outcome
      : { status: "incomplete", reason: withCause(incompleteReason(ctx.stop, ctx.incomplete, ctx.failure, ctx.hang, ctx.tracker), ctx.stop, cause) };
  if (!finished.ok) {
    // The Recording itself failed its fail-closed checks (schema / a surviving secret). It is not
    // written; the run is reported crashed so this can never read as a pass.
    ctx.failure = ctx.failure ?? { kind: "exception", message: `recording rejected: ${finished.reason}` };
    ctx.stop = "crashed";
  }
  const fired = ctx.effectLog.entries();
  ctx.effectLog.close();
  if (ctx.overlay !== null) {
    const banner = finalOutcome.status === "completed" ? `jevitate · done — ${ctx.stop}` : `jevitate · ${ctx.stop} — ${finalOutcome.reason}`;
    await ctx.overlay.finish(banner, finalOutcome.status === "completed", ctx.page);
  }
  return {
    sideEffects: fired.sideEffects,
    ...(fired.truncated > 0 ? { sideEffectsTruncated: fired.truncated } : {}),
    ...(ctx.deltas === null ? {} : { actionDeltas: { ...ctx.deltas.stats(), ...(ctx.notPersisted.length === 0 ? {} : { notPersisted: ctx.notPersisted }) } }),
    stop: ctx.stop,
    recording: finished.ok ? finished.recording : emptyRecording(cfg.site ?? ctx.startOrigin, finished.reason),
    transcript: ctx.transcript.entries(),
    finalUrl: redactText(redactUrl(safeUrl(ctx.page)), ctx.secrets),
    decisions: ctx.tracker.decisions,
    actions: ctx.tracker.actions,
    ...(ctx.failure === undefined ? {} : { failure: ctx.failure }),
    heap: ctx.heap.samples(),
    timing: summarizeTimings(ctx.timings),
    ...(ctx.hang === undefined ? {} : { hang: ctx.hang }),
    outcome: finalOutcome,
    ...(ctx.answer !== undefined && finalOutcome.status === "completed" ? { answer: ctx.answer } : {}),
    ...(cause === null ? {} : { blockingCause: cause }),
    ...(ctx.endedOnRejectedDone && ctx.stop === "done" ? { doneRejected: true as const } : {}),
    ...(ctx.stop === "crashed" && ctx.failure !== undefined
      ? { crash: buildCrashReport(ctx.failure, ctx.crashWatch.signals(), ctx.heap.samples(), { host: await ctx.probeHost() }) }
      : {}),
  };
}


