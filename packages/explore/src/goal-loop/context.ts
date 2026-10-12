/**
 * The goal loop's run state (#232): `RunContext` holds every closure variable `explore()` used to
 * keep (names unchanged), and `createRunContext` builds it — the same initializers, in the same
 * order, with the same page listeners attached — before the run's first navigation.
 */
import type { Page } from "playwright";
import type { WriteClassifier } from "@jevitate/recording";
import type { BoundsTracker, NoProgressDetector, Bounds, StopReason } from "../bounds.js";
import { assertAuthorizedExploreTarget } from "../authorized-targets.js";
import type { PageTiming } from "../timing.js";
import type { HostProbe } from "../host-pressure.js";
import type { HostJudgment } from "../host-health.js";
import type { HangConfig, SettleConfig, TimingConfig } from "../settle-config.js";
import type { AuthProgress } from "../auth-completion.js";
import type { SaveProgress } from "../save-completion.js";
import type { FieldValueLog, FillHelper } from "../fill.js";
import type { SideEffectGuard, SideEffectLog } from "../side-effects.js";
import type { Control } from "../snapshot.js";
import type { ObservedPages, VetoedAnswers, RunAnswer, AnswerEvidence } from "../answer.js";
import type { DepthLog, MinEffort } from "../run-depth.js";
import type { UnsubmittedTypeTracker, RunOutcome } from "../conversation.js";
import type { RunRecorder } from "../record.js";
import { resolveMissionFixture } from "../fixture.js";
import { fixtureNoRoot } from "@jevitate/recording";
import type { ChromeTracker } from "../feature/relevance.js";
import type { GoalFocus } from "./goal-focus.js";
import type { DemoOverlay } from "../demo-overlay.js";
import type { TranscriptLog } from "../transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import type { CrashWatch } from "../mission-failure.js";
import type { PageStatus } from "../status.js";
import type { SafetyPolicy } from "../safety.js";
import type { ReadOnlyGuard } from "../read-only.js";
import type { FirstPartyOrigins } from "../third-party.js";
import type { HeapLog } from "../crash-report.js";
import type { FailedActionStreak } from "../stuck-actions.js";
import type { LoopCycleDetector } from "../loop-cycle.js";
import type { ActionDeltas, DeltaVerdict } from "../action-delta.js";

import type { ExploreConfig, ExploreRun } from "../explore.js";
import { initSecrets } from "./context/secrets.js";
import { initTracking } from "./context/tracking.js";
import { initHost } from "./context/host.js";
import { initTranscript } from "./context/transcript.js";
import { initLoopState } from "./context/loop-state.js";
import { initConversation } from "./context/conversation.js";
import { initAnswers } from "./context/answers.js";
import { initProgress } from "./context/progress.js";
import { initBlockers } from "./context/blockers.js";
import { initPerception } from "./context/perception.js";
import { initObservation } from "./context/observation.js";
import { initGuards } from "./context/guards.js";
import { initMutation } from "./context/mutation.js";
import type { MutableRunContext } from "./context/types.js";

/** The goal loop's run state (#232): every closure variable of `explore()`, one field each, names unchanged. */
export interface RunContext {
  readonly cfg: ExploreConfig;
  readonly startOrigin: string;
  readonly fixture: string | null;
  /** #498: the project root the mission fixture must lie inside (`cfg.fixtureRoot`), or null. */
  readonly fixtureRoot: string | null;
  readonly secrets: string[];
  /** #359: how many times each `cmd:` binding's command has run this run (by descriptor). */
  readonly secretCommandRuns: Map<string, number>;
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
  /** #323: the page signatures this streak of moving scrolls has seen (a revisit is no progress). */
  scrollStreakSignatures: Set<string>;
  /** #367: the loop-cycle detector (period ≤ 2 alternation with no request and nothing new). */
  readonly cycles: LoopCycleDetector;
  /** #367: the action the latest recorded step took (identity + label), consumed by the progress check. */
  cycleAction: { action: string; label: string } | null;
  /** #367: when the last progress check ran — a write started after it is the next step's. */
  cycleMark: number;
  /** #390: the page's visible text (and its URL) at the last progress check — what an action added to it is told. */
  pageText: { readonly url: string; readonly text: string } | null;
  /** #446: the acted-on control's form text right before the action (null: no form, or no action). */
  formBefore: { readonly control: Control; readonly lines: readonly string[] } | null;
  /** #446: text that newly showed in the acted-on form after an action (redacted), while it still shows. */
  formMessage: { readonly lines: readonly string[]; readonly after: string } | null;
  /** #390: the last action was a conversation turn whose reply was already told (its text is not told again). */
  replyTold: boolean;
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
  /** #448: the run stopped fail-closed because the page offered no interactive control (the cause of a `blocked` miss). */
  noControls: boolean;
  /** #238: the latest report's "none exists" was below the coverage floor (its reason), else null. */
  lastAbsenceUncovered: string | null;
  /** #239: the last click whose window was settled, and whether any click's writes all succeeded (2xx). */
  settledClick: ReturnType<SideEffectGuard["lastClick"]>;
  /** #380: reads the clicked control's region state when its window closes (null when no click is open). */
  clickedRegion: (() => Promise<string | undefined>) | null;
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
  /** #424: how deep the run went (states, pages, submits, controls tried per page). */
  readonly depth: DepthLog;
  /** #424: the minimum effort before the model may conclude (null: none applies). */
  readonly minEffort: MinEffort | null;
  /** #424: the model's endings refused in a row for the minimum, and the action count they were refused at. */
  minEffortRefusals: number;
  minEffortRefusedAt: number;
  /** #424: a grounded answer reported before the minimum was met — kept, accepted if the run ends without a later one. */
  deferredAnswer: RunAnswer | undefined;
  /** #424: the grounded claims of the run's rejected reports (for the partial report). */
  readonly reportClaims: AnswerEvidence[];
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
  /**
   * #373: how long the run has waited, in total, for the reply to the last message sent — the send's
   * own wait plus every later `wait` / report listen on that turn. Bounded by `replyCeilingMs`.
   */
  replyWaitedMs: number;
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
  readonly blockers: {
    failClosed: string | null;
    /** `step`: the transcript step it was met at (#371: the latest blocker is named, not the first). */
    target: { key: string; text: string; step: number } | null;
    /** #371: the latest failed / rejected target action — its text, its own reason, and its step. */
    latest: { key: string; text: string; reason: string; step: number } | null;
  };
  /** #371: records a failed or refused target action as the latest blocker. */
  readonly noteFailure: (op: string, c: Control, reason: string | undefined, refused: boolean) => void;
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
  /** #331: how long a reply must hold still before it is complete (`replyQuietMs`). */
  readonly replyQuietMs: number;
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
  /** #338: the goal's area — once reached, navigation to sections the goal never names is off-goal. */
  readonly goalFocus: GoalFocus;
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
  /** #330: the operator set `--job-wait-ms` (the job-wait budget is theirs, not the default). */
  readonly jobWaitExplicit: boolean;
  /** How long `wait`s have waited on the in-progress status the page shows (bounded by `jobWaitMs`). */
  jobWaitedMs: number;
  /**
   * #379: how long the run has waited on a busy/progress overlay with no visible control (bounded by
   * `jobWaitMs`); reset once a page renders controls again, so an overlay that keeps coming back over
   * an empty page still ends.
   */
  overlayWaitedMs: number;
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

/** Builds the run state of one `explore()` run (everything before its first navigation). #500: assembled from per-concern modules, in the original order. */
export async function createRunContext(cfg: ExploreConfig): Promise<RunContext> {
  const ctx = {} as MutableRunContext;
  ctx.cfg = cfg;
  // #1 — authorize the start target before ANY snapshot/decision/action.
  ctx.startOrigin = assertAuthorizedExploreTarget(cfg.startUrl, cfg.allowlist);
  // Mission fixture: validated before any navigation/decision (fail fast).
  // #498: confined to the project root (realpath'd); a fixture with no root is refused (fail-closed).
  if (cfg.fixture !== undefined && cfg.fixtureRoot === undefined) throw fixtureNoRoot(cfg.fixture);
  ctx.fixture = cfg.fixture === undefined ? null : await resolveMissionFixture(cfg.fixture, cfg.fixtureRoot);
  ctx.fixtureRoot = cfg.fixtureRoot ?? null;

  initSecrets(ctx, cfg);
  initTracking(ctx, cfg);
  initHost(ctx, cfg);
  initTranscript(ctx, cfg);
  initLoopState(ctx);
  initConversation(ctx, cfg);
  initAnswers(ctx, cfg);
  initProgress(ctx, cfg);
  initBlockers(ctx);
  initPerception(ctx, cfg);
  initObservation(ctx, cfg);
  initGuards(ctx, cfg);
  initMutation(ctx);

  return ctx;
}
