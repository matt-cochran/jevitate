/**
 * The goal loop's run state (#232): `RunContext` holds every closure variable `explore()` used to
 * keep (names unchanged), and `createRunContext` builds it — the same initializers, in the same
 * order, with the same page listeners attached — before the run's first navigation.
 */
import { BrowseTheWebToken } from "@jevitate/screenplay";
import type { Page } from "playwright";
import { writeClassifier, type WriteClassifier } from "@jevitate/recording";
import {
  BoundsTracker,
  NoProgressDetector,
  resolveBounds,
  type Bounds,
  type StopReason,
} from "../bounds.js";
import {
  assertAuthorizedExploreTarget,
  isAuthorizedExploreTarget,
} from "../authorized-targets.js";
import { monitorFor } from "../page-monitor.js";
import { type PageTiming } from "../timing.js";
import { hostProbe, type HostProbe } from "../host-pressure.js";
import type { HostJudgment } from "../host-health.js";
import { textMatcher, urlMatcher, type HangConfig, type SettleConfig, type TimingConfig } from "../settle-config.js";
import { DEFAULT_STALL_MS } from "../hang-repro.js";
import { AuthProgress } from "../auth-completion.js";
import { SaveProgress } from "../save-completion.js";
import { FieldValueLog, FillHelper, goalListsSeveral } from "../fill.js";
import {
  boundSecretField,
  secretFieldContext,
  secretFieldSecrets,
} from "../secret-fields.js";
import { SideEffectGuard, SideEffectLog } from "../side-effects.js";
import type { Control } from "../snapshot.js";
import {
  ObservedPages,
  goalAsksToWrite,
  goalAsksForReply,
  VetoedAnswers,
  type RunAnswer,
} from "../answer.js";
import {
  REPLY_CEILING_MS,
  REPLY_QUIET_MS,
  REPLY_WAIT_MS,
  STUCK_TURNS,
  UnsubmittedTypeTracker,
  goalCallToAction,
  newPageText,
  repetitiveTurns,
  withoutAuthored,
  type RunOutcome,
} from "../conversation.js";
import { RunRecorder } from "../record.js";
import { resolveMissionFixture } from "../fixture.js";
import { ChromeTracker } from "../feature/relevance.js";
import { REPLY_MAX_CHARS, WAIT_OP_MS } from "./limits.js";
import { demoOverlayFor, type DemoOverlay } from "../demo-overlay.js";
import { TranscriptLog } from "../transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { CrashWatch } from "../mission-failure.js";
import {
  EMPTY_STATUS,
  type PageStatus,
} from "../status.js";
import { SafetyPolicy } from "../safety.js";
import { NO_DESTRUCTIVE_NOTE, READ_ONLY_NOTE, ReadOnlyGuard } from "../read-only.js";
import { typeFixtureContext } from "../type-fixtures.js";
import { FirstPartyOrigins } from "../third-party.js";
import { HeapLog } from "../crash-report.js";
import { FailedActionStreak, openOverlayName } from "../stuck-actions.js";
import { ActionDeltas, type DeltaVerdict } from "../action-delta.js";
import {
  keyOf,
  quote,
} from "./helpers.js";

import type { ExploreConfig, ExploreRun } from "../explore.js";
import { clock } from "@jevitate/domain";

/** The goal loop's run state (#232): every closure variable of `explore()`, one field each, names unchanged. */
export interface RunContext {
  readonly cfg: ExploreConfig;
  readonly startOrigin: string;
  readonly fixture: string | null;
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

/** Builds the run state of one `explore()` run (everything before its first navigation). */
export async function createRunContext(cfg: ExploreConfig): Promise<RunContext> {
  const ctx = {} as { -readonly [K in keyof RunContext]: RunContext[K] };
  ctx.cfg = cfg;
  // #1 — authorize the start target before ANY snapshot/decision/action.
  ctx.startOrigin = assertAuthorizedExploreTarget(cfg.startUrl, cfg.allowlist);
  // Mission fixture: validated before any navigation/decision (fail fast).
  ctx.fixture = cfg.fixture === undefined ? null : await resolveMissionFixture(cfg.fixture);

  // A bound secret field's value (or TOTP seed) is a run secret: every redaction seam scrubs it.
  ctx.secrets = [...(cfg.secrets ?? []), ...secretFieldSecrets(cfg.secretFields)];
  ctx.secretCommandRuns = new Map();
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
  ctx.now = (): number => clock.now();

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
  ctx.scrollStreakSignatures = new Set<string>();
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
  ctx.replyQuietMs = cfg.replyQuietMs ?? REPLY_QUIET_MS;
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
  ctx.jobWaitExplicit = cfg.jobWaitMs !== undefined;
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

  return ctx;
}
