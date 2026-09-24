import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Navigate } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import type { Recording, ValueOrVar } from "@jevitate/recording";
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
import { HANG_PROBE_MS } from "./perceive.js";
import { textMatcher, type HangConfig, type SettleConfig, type TimingConfig } from "./settle-config.js";
import { DEFAULT_STALL_MS } from "./hang-repro.js";
import { decide, judgeGoalMet } from "./decide.js";
import { FillHelper, capMessage, chatReply, matchOption } from "./fill.js";
import {
  type SecretField,
  boundSecretField,
  maskSecretFields,
  secretFieldContext,
  secretFieldSecrets,
  secretFieldValue,
  secretPlaceholder,
} from "./secret-fields.js";
import { act } from "./act.js";
import { SideEffectGuard, awaitWrites } from "./side-effects.js";
import { sendable } from "./actions.js";
import type { Control } from "./snapshot.js";
import { ObservedPages, reportAnswer, type AnswerVerdict, type RunAnswer } from "./answer.js";
import {
  REPLY_CEILING_MS,
  GOAL_CHECK_TRIGGER,
  GOAL_MET_THRESHOLD,
  REPLY_WAIT_MS,
  UnsubmittedTypeTracker,
  groundDone,
  isSubmitControl,
  readPageText,
  sameMessage,
  stillBusy,
  waitForChange,
  waitForReply,
  withoutAuthored,
  type ReplyResult,
  type RunOutcome,
} from "./conversation.js";
import { RunRecorder, emptyRecording } from "./record.js";
import { resolveMissionFixture } from "./fixture.js";
import { redactText, redactUrl } from "./redact.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptListener } from "./transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { CrashWatch, describeFailure, describeUnreachable, isUnreachableTarget } from "./mission-failure.js";
import { EMPTY_STATUS, describeStatus, isEmptyStatus, readPageStatus, statusDelta, type PageStatus } from "./status.js";
import { HeapLog, buildCrashReport, sampleHeap, type CrashReport } from "./crash-report.js";
import type { HeapSample } from "@jevitate/domain";

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
}

/**
 * Actions whose own name says "go back" (Back, Cancel, Close, Undo, …): returning to an earlier
 * state is exactly their target state, never a stall.
 */
const EXPECTED_RETURN = /\b(?:back|cancel|close|dismiss|undo|previous|prev|reset|discard|clear|exit|reload)\b/i;

/** Roles whose click changes an input's value (so a later repeat of a write sends something new). */
const TOGGLE_ROLES: ReadonlySet<string> = new Set(["checkbox", "radio", "switch", "option", "menuitemcheckbox", "menuitemradio"]);

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
    secretContext === null ? cfg.missionContext : cfg.missionContext ? `${cfg.missionContext}; ${secretContext}` : secretContext;
  const bounds = resolveBounds(cfg.bounds);
  const tracker = new BoundsTracker(bounds);
  const noProgress = new NoProgressDetector(3);
  const fillHelper = new FillHelper(cfg.gen);
  const recorder = new RunRecorder(cfg.site ?? startOrigin, undefined, secrets, cfg.onRecording);
  const page = cfg.actor.ability(BrowseTheWebToken).session.page;
  const crashWatch = new CrashWatch(page);
  const heap = new HeapLog();
  const probeHost = cfg.hostProbe ?? hostProbe();
  const now = (): number => Date.now();

  const transcript = new TranscriptLog(secrets, cfg.onTranscriptEntry);
  const history: string[] = [];

  let stop: StopReason = "exhausted";
  let failure: MissionFailure | undefined;
  let lastActedOp: string | null = null;
  let fixtureAttached = false;
  let hang: ExploreRun["hang"];
  let outcome: RunOutcome | null = null;
  /** Why the run ended incomplete, when a specific detector ended it. */
  let incomplete: string | null = null;
  const unsent = new UnsubmittedTypeTracker();
  const conversation: { latestReply: string | null; sent: string[] } = { latestReply: null, sent: [] };
  /** Controls present just before a message was sent — the next snapshot's new ones were offered with the reply. */
  let offerBaseline: Set<string> | null = null;
  let offeredKeys = new Set<string>();
  let doneRejections = 0;
  let reportRejections = 0;
  /** The visible text of every page state observed — what a reported answer is grounded against (#101). */
  const observed = new ObservedPages(secrets);
  /** The grounded answer a `report` ended the run with. */
  let answer: RunAnswer | undefined;
  /** Page states already goal-checked on the decision's "already met" signal (once each, #91). */
  const goalChecked = new Set<string>();
  let idleSteps = 0;
  let idleSince: number | null = null;
  /** How long consecutive `wait`s have waited on a still-busy app (bounded by `replyWaitMs`). */
  let busyWaitedMs = 0;
  /** The last message sent got no reply yet (a slow LLM turn): `wait`s are patience, bounded. */
  let awaitingReply = false;
  /** The page text before the last message, and the message — to keep listening for its reply. */
  let lastTurn: { baseline: string; sent: string } | null = null;
  let lastPath: string | null = null;
  /** The page's status text (alerts, invalid fields) at the latest perception (#79). */
  let status: PageStatus = EMPTY_STATUS;
  /** The step whose effect the next status read reports ("after <step>: alert …"). */
  let statusAfter: string | null = null;
  /** Consecutive `wait`s that changed nothing while nothing was pending. */
  let quietWaits = 0;
  /** The concrete causes the run ran into, for a precise stop reason (#84). */
  const blockers: { failClosed: string | null; target: { key: string; text: string } | null } = {
    failClosed: null,
    target: null,
  };
  /** The most concrete cause known now, in #84's priority order; null when there is none. */
  const blockingCause = (): string | null => {
    if (blockers.failClosed !== null) return blockers.failClosed;
    if (blockers.target !== null) return blockers.target.text;
    const field = status.invalid[0];
    if (field !== undefined) return `field ${quote(field.name, 80)} is invalid — ${quote(field.message)}`;
    const alert = status.alerts[0];
    if (alert !== undefined) return `the page shows alert ${quote(alert)}`;
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
    } | null;
    /** The raw descriptor of the last RECORDED action's target, to check it is still on the page. */
    lastRecordedTarget: string | null;
  } = { lastMutation: null, lastRecordedTarget: null };
  const perceiveOpts = {
    maxCandidates: bounds.maxCandidates,
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
  const sideEffects = new SideEffectGuard(monitorFor(page));
  const noteMutation = (label: string, descriptor: unknown, before: string, at: number): void => {
    // Any input change (type/select/send/upload) makes a repeat send something new.
    if (!label.startsWith("click ")) sideEffects.inputChanged();
    track.lastMutation = { at, before, seenBefore: new Set(seen), label, recordIndex: recorder.stepCount - 1, sawNewState: false };
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
    // Initial navigation (authorized above).
    page.on("requestfailed", onFirstNavRequestFailed);
    try {
      await Navigate.to(cfg.startUrl).performAs(cfg.actor);
    } catch (e) {
      const message = firstLine(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem (a bad URL, the target not running). `inconclusive`, not `crashed`;
      // no crash report is built for it, so no issue is ever drafted from it.
      firstNavFailed = true;
      stop = "inconclusive";
      failure = { kind: "target-unreachable", message: `target unreachable (${describeUnreachable(message, firstNavNetError)})` };
    } finally {
      page.off("requestfailed", onFirstNavRequestFailed);
    }
    if (firstNavFailed) throw new FirstNavigationFailedSentinel();
    recorder.navigate(cfg.startUrl, now());

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
        const heapNow = await sampleHeap(page, 1_000);
        const withHost: HangSignal = { ...perception.hang, host: await probeHost() };
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

      // #2 — no-progress: the last executed op left the page unchanged N times.
      if (lastActedOp !== null && noProgress.note(lastActedOp, snap.signature)) {
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
            const heapNow = await sampleHeap(page, 1_000);
            const withHost: HangSignal = { ...stuck, host: await probeHost() };
            hang = {
              signal: heapNow === null ? withHost : { ...withHost, heapBytes: heapNow.usedBytes },
              recordingStepIndex: stuck.kind === "ui-no-progress" ? m.recordIndex : Math.max(0, recorder.stepCount - 1),
            };
            stop = "hang";
            break;
          }
        }
        stop = "no-progress";
        break;
      }
      seen.add(snap.signature);

      // Conversation bookkeeping (independent code). A navigation takes any typed text with it;
      // a field that left the page took its text too.
      const path = safePath(snap.url);
      if (lastPath !== null && path !== lastPath) unsent.submitted();
      lastPath = path;
      const keys = new Map<string, Control>(snap.controls.map((c) => [keyOf(c), c]));
      unsent.retain(new Set(keys.keys()));
      if (offerBaseline !== null) {
        const before = offerBaseline;
        offeredKeys = new Set([...keys.keys()].filter((k) => !before.has(k)));
        offerBaseline = null;
      }
      const offered = new Set(snap.controls.filter((c) => offeredKeys.has(keyOf(c))).map((c) => c.index));
      const unsubmitted = new Set(snap.controls.filter((c) => unsent.wouldRepeat(keyOf(c))).map((c) => c.index));

      observed.add(snap.url, await readPageText(page));

      let decision: Awaited<ReturnType<typeof decide>>;
      try {
        decision = await decide(cfg.judge, {
          goal: cfg.goal,
          snapshot: snap,
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
        } = {},
      ): void => {
        transcript.record({
          op: extra.op ?? decision.op,
          control: extra.control === undefined ? decision.control : extra.control,
          ...(extra.strategy === undefined ? {} : { strategy: extra.strategy }),
          ...(extra.answer === undefined || extra.answer === null ? {} : { answer: { ...extra.answer, accepted: actOk } }),
          confidence: decision.confidence,
          chosenBy: "model",
          actOk,
          ...(reason === undefined ? {} : { reason }),
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
      const groundGoal = async (): Promise<{
        verdict: ReturnType<typeof groundDone>;
        judgments: Record<string, { value: boolean; probability: number }> | undefined;
      }> => {
        const unsubmittedLabels = [...unsent.pending().values()].map((p) => p.label);
        let successCheck: boolean | undefined;
        let goalMet: number | null | undefined;
        if (unsubmittedLabels.length === 0) {
          if (cfg.successCheck !== undefined) {
            successCheck = await cfg.successCheck().then(
              (v) => v,
              () => false,
            );
          } else {
            const pageText = withoutAuthored(await readPageText(page), conversation.sent);
            goalMet = await judgeGoalMet(cfg.judge, {
              goal: cfg.goal,
              url: snap.url,
              pageText,
              history,
              secrets,
              ...(isEmptyStatus(status) ? {} : { pageStatus: describeStatus(status) }),
            }).catch(() => null);
          }
        }
        const verdict = groundDone({
          unsubmitted: unsubmittedLabels,
          ...(successCheck === undefined ? {} : { successCheck }),
          ...(goalMet === undefined ? {} : { goalMetProbability: goalMet }),
        });
        // `value` is code's reading of the probability (the acceptance threshold), not the port's
        // p >= 0.5 — a transcript must never show "goalMet: true" beside "done rejected" (#91).
        const judgments =
          goalMet === undefined || goalMet === null
            ? undefined
            : { goalMet: { value: goalMet >= GOAL_MET_THRESHOLD, probability: goalMet } };
        return { verdict, judgments };
      };

      // The decision's advisory "already met?" signal (#91): the loop used to act past a met goal
      // because the model never proposed `done`. Code grounds it BEFORE acting — once per page
      // state — and stops `done` only on the same grounded verdict a proposed `done` needs.
      if (
        decision.goalMet !== null &&
        decision.goalMet >= GOAL_CHECK_TRIGGER &&
        decision.op !== "done" &&
        decision.op !== "report" &&
        decision.op !== "blocked" &&
        !goalChecked.has(snap.signature)
      ) {
        goalChecked.add(snap.signature);
        const { verdict, judgments } = await groundGoal();
        if (verdict.accept) {
          record(
            true,
            `goal already met — stopped instead of "${decision.op}": verified by ${verdict.outcome.status === "completed" ? verdict.outcome.verifiedBy : "?"}`,
            {
              op: "done",
              control: null,
              strategy: "goal-check",
              judgments: {
                ...(judgments ?? {}),
                goalAlreadyMet: { value: true, probability: decision.goalMet },
              },
            },
          );
          outcome = verdict.outcome;
          stop = "done";
          break;
        }
      }

      // `done` is a PROPOSAL (guardrail #4), grounded by `groundGoal`.
      if (decision.op === "done") {
        const { verdict, judgments } = await groundGoal();
        if (verdict.accept) {
          record(true, `done accepted: goal verified by ${verdict.outcome.status === "completed" ? verdict.outcome.verifiedBy : "?"}`, {
            ...(judgments === undefined ? {} : { judgments }),
          });
          outcome = verdict.outcome;
          stop = "done";
          break;
        }
        doneRejections += 1;
        history.push(`done rejected: ${verdict.reason} — keep working toward the goal`);
        record(false, `done rejected (${doneRejections}/${MAX_DONE_REJECTIONS}): ${verdict.reason}`, {
          ...(judgments === undefined ? {} : { judgments }),
        });
        if (doneRejections >= MAX_DONE_REJECTIONS) {
          incomplete = `the model proposed done ${doneRejections} times, but ${verdict.reason}`;
          stop = "blocked";
          break;
        }
        continue;
      }
      // `report` (#101) ends a find-out goal with an ANSWER — a proposal too: the answer is generated
      // from the observed page text and accepted only when code grounds every claim on it.
      if (decision.op === "report") {
        const verdict: AnswerVerdict = await reportAnswer(cfg.gen, {
          goal: cfg.goal,
          url: snap.url,
          pages: observed.pages(),
          history,
          secrets,
        }).catch((e: unknown) => ({ accept: false as const, reason: `no answer could be generated: ${firstLine(e)}`, answer: null }));
        if (verdict.accept) {
          record(true, `report accepted: answer grounded on the observed pages (${verdict.answer.evidence.length} claim(s))`, {
            answer: verdict.answer,
          });
          answer = verdict.answer;
          outcome = { status: "completed", verifiedBy: "grounded-answer" };
          stop = "done";
          break;
        }
        reportRejections += 1;
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
        record(true, "model blocked");
        incomplete = "the model reported the goal cannot be advanced from this page";
        stop = "blocked";
        break;
      }

      const control = decision.control;
      if (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait") {
        // No recorded mutation — but visible to history (J-4), and an idle streak is a stuck signal.
        let changed: boolean;
        let note: string;
        if (decision.op === "wait" && awaitingReply && lastTurn !== null && busyWaitedMs < replyWaitMs) {
          // Still listening for the last message's reply (a slow LLM turn): this wait keeps
          // listening, bounded by what is left of the reply wait, and records the reply if it lands.
          const t0 = now();
          const listen = Math.min(replyWaitMs - busyWaitedMs, 20_000);
          const reply = await waitForReply(page, { ...lastTurn, timeoutMs: listen, ceilingMs: listen });
          busyWaitedMs += now() - t0;
          if (reply.received) {
            conversation.latestReply = reply.text;
            awaitingReply = false;
            busyWaitedMs = 0;
          }
          note = reply.received
            ? `waited ${((now() - t0) / 1000).toFixed(1)}s → reply: ${quote(reply.text, 300)}`
            : `waited ${((now() - t0) / 1000).toFixed(1)}s (the reply is still on its way)`;
          changed = true;
          quietWaits = 0;
          record(true, note, reply.received ? { reply } : {});
        } else if (decision.op === "wait") {
          const t0 = now();
          changed = await waitForChange(page, waitOpMs);
          // No change while the app is still busy (a request in flight, a spinner) is patience —
          // a slow reply — not idleness: it does not count toward the idle cap.
          // Bounded: patience lasts as long as a conversational reply may take (`replyWaitMs`).
          // A sent message whose reply has not arrived yet is also still in flight.
          const pending = !changed && (awaitingReply || (await stillBusy(page)));
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
          const y0 = await page.evaluate(() => window.scrollY).catch(() => null);
          const r = await act(cfg.actor, { op: decision.op, control: null });
          const y1 = await page.evaluate(() => window.scrollY).catch(() => null);
          changed = y0 !== null && y1 !== null && y0 !== y1;
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
          record(false, "action budget exhausted");
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
          record(false, note);
          lastActedOp = decision.op;
          continue;
        }
        const at = now();
        const r = await act(cfg.actor, { op: "reload", control: null });
        if (r.ok) {
          recorder.navigate(page.url(), at);
          track.lastMutation = { at, before: snap.signature, seenBefore: new Set(seen), label: "reload", recordIndex: recorder.stepCount - 1, sawNewState: false };
          track.lastRecordedTarget = null;
          tracker.countAction();
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
        record(false, "no valid target (fail-closed)");
        stop = "blocked";
        break;
      }
      if (!tracker.mayAct()) {
        record(false, "action budget exhausted");
        stop = "exhausted";
        break;
      }
      const at = now();

      // A bound secret field (#72): code types the real value (a TOTP code is computed now); the model,
      // history and transcript see only the placeholder, the Recording `{ redacted: true }`.
      const bound = decision.op === "type" ? boundSecretField(control, cfg.secretFields) : null;
      if (bound !== null) {
        const value = secretFieldValue(bound, at);
        const placeholder = secretPlaceholder(bound);
        const r = await act(cfg.actor, { op: "type", control, value });
        if (r.ok) {
          recorder.fill(control.descriptor, { redacted: true, length: value.length }, at);
          noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at);
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

      // The repeated-type anti-pattern (independent code): typing again into a field that holds text
      // this run typed and never sent overwrites it and still delivers nothing. Submit instead, and
      // count it as a stuck signal.
      let op = decision.op;
      let forcedNote: string | null = null;
      if (op === "type" && unsent.wouldRepeat(keyOf(control))) {
        const n = unsent.noteRepeat();
        forcedNote = `repeated type into ${control.name} without sending (stuck signal ${n}/${MAX_REPEAT_TYPE_SIGNALS}) — sent instead`;
        if (n >= MAX_REPEAT_TYPE_SIGNALS) {
          record(false, forcedNote);
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
        let text: string | null;
        try {
          text = await chatReply(cfg.gen, {
            goal: cfg.goal,
            fieldLabel: control.name || control.summary,
            latestReply: conversation.latestReply,
            sentMessages: conversation.sent,
            maxChars: replyMaxChars,
            secrets,
          });
        } catch (e) {
          const reason = `message generation unavailable: ${firstLine(e)}`;
          history.push(`${op} skipped: ${reason}`);
          record(false, reason, { op });
          lastActedOp = op;
          continue;
        }
        if (text === null) {
          blockers.failClosed = `no message for ${quote(control.name || control.summary, 80)} (the message generator returned none)`;
          record(false, "no message available (fail-closed)", { op });
          incomplete = "no message could be generated for the conversation";
          stop = "blocked";
          break;
        }
        const message = text;
        if (conversation.sent.some((m) => sameMessage(m, message))) {
          const n = unsent.noteRepeat();
          const reason = `message not sent: it repeats an earlier message (stuck signal ${n}/${MAX_REPEAT_TYPE_SIGNALS})`;
          history.push(`${reason} — answer the latest reply with something new`);
          record(false, reason, { op, message });
          lastActedOp = op;
          if (n >= MAX_REPEAT_TYPE_SIGNALS) {
            incomplete = "stuck: the generated messages kept repeating";
            stop = "no-progress";
            break;
          }
          continue;
        }
        if (op === "send") {
          const baseline = await readPageText(page);
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
          noteMutation(`send ${control.name}`, control.descriptor, snap.signature, at);
          tracker.countAction();
          unsent.submitted();
          conversation.sent.push(message);
          const reply = await waitForReply(page, { baseline, sent: message, timeoutMs: replyWaitMs, ceilingMs: replyCeilingMs });
          if (reply.received) conversation.latestReply = reply.text;
          awaitingReply = !reply.received;
          busyWaitedMs = reply.waitedMs;
          lastTurn = { baseline, sent: message };
          offerBaseline = before;
          history.push(
            `sent ${quote(message)} via ${via?.kind === "click" ? `"${via.control.name}"` : "Enter"} → ` +
              (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
          );
          record(true, forcedNote ?? undefined, { op, message, reply });
          lastActedOp = op;
          continue;
        }
        // A plain `type` of a message: typed, NOT sent yet (the Send control or Enter still has to follow).
        const r = await act(cfg.actor, { op: "type", control, value: message });
        if (r.ok) {
          recorder.fill(control.descriptor, message, at);
          noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at);
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
        record(false, "send without a message (fail-closed)", { op });
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
          record(false, reason);
          lastActedOp = op;
          continue;
        }
        const option = text === null ? null : matchOption(text, control.options);
        if (option === null) {
          fillHelper.commit();
          const reason = `no valid option chosen for ${control.name} (fail-closed)`;
          blockers.failClosed = `no valid option for field ${quote(control.name || control.summary, 80)} (fail-closed)`;
          history.push(`select failed: ${reason}`);
          record(false, reason);
          lastActedOp = op;
          continue;
        }
        const r = await act(cfg.actor, { op: "select", control, value: option });
        if (r.ok) {
          recorder.select(control.descriptor, option, at);
          noteMutation(`select ${control.name}`, control.descriptor, snap.signature, at);
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
        try {
          ({ text, rejected } = await fillHelper.valueFor({
            fieldLabel: control.name || control.summary,
            goal: cfg.goal,
            visibleContext: snap.controls.map((c) => c.summary).join("; "),
            history,
            secrets,
            // A text field's value is field-scoped and checked before it is typed (#71).
            ...(decision.op === "type" ? { field: { tag: control.tag, inputType: control.inputType } } : {}),
          }));
        } catch (e) {
          const reason = `value generation unavailable: ${firstLine(e)}`;
          history.push(`${decision.op} skipped: ${reason}`);
          record(false, reason);
          lastActedOp = decision.op;
          continue;
        }
        if (rejected !== undefined) {
          // Not a value for this one field (an essay, a JSON map, a `Label:` echo…): a failed act the
          // model sees in its history, never typed.
          const reason = `typed value rejected: ${rejected}`;
          history.push(`type into ${control.name} failed: ${reason} — the value must be only what goes in this one field`);
          record(false, reason);
          lastActedOp = decision.op;
          continue;
        }
        if (text === null) {
          // The generator will not honestly supply a required value → never guess.
          blockers.failClosed = `no value for field ${quote(control.name || control.summary, 80)} (the value generator returned none)`;
          record(false, "no value available (fail-closed)");
          stop = "blocked";
          break;
        }
        // Free-text form values are bounded too (dogfood: 2–3k-char markdown essays in "Rationale").
        if (decision.op === "type" && (control.tag === "textarea" || control.inputType === "text" || control.inputType === "")) {
          text = capMessage(text, FORM_TEXT_MAX_CHARS);
        }
        const r = await act(cfg.actor, { op: decision.op, control, value: text });
        if (r.ok) {
          if (decision.op === "type") {
            // A form field (not a message composer) is submitted with its form's own button; retyping
            // it is a correction, not the chat anti-pattern — so only composers are tracked.
            recorder.fill(control.descriptor, text, at);
          } else recorder.select(control.descriptor, text, at);
          noteMutation(`${decision.op} ${control.name}`, control.descriptor, snap.signature, at);
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
          record(false, note);
          lastActedOp = decision.op;
          continue;
        }
        const baseline = turn ? await readPageText(page) : "";
        sideEffects.beginClick(keyOf(control), control.name || control.summary, safePath(snap.url), now());
        const r = await act(cfg.actor, { op: "click", control });
        let reply: ReplyResult | undefined;
        let message: string | undefined;
        if (r.ok) {
          recorder.click(control.descriptor, at);
          noteMutation(`click ${control.name}`, control.descriptor, snap.signature, at);
          tracker.countAction();
          if (isSubmitControl(control)) unsent.submitted();
          // Toggling an input (a checkbox, a radio, a switch) changes what a repeat would send (#92).
          if (TOGGLE_ROLES.has(control.role) || (control.tag === "input" && control.inputType !== "submit" && control.inputType !== "button")) {
            sideEffects.inputChanged();
          }
          if (turn) {
            message = submits ? pendingTexts.join("\n") : control.name;
            conversation.sent.push(message);
            reply = await waitForReply(page, { baseline, sent: message, timeoutMs: replyWaitMs, ceilingMs: replyCeilingMs });
            if (reply.received) conversation.latestReply = reply.text;
            awaitingReply = !reply.received;
            busyWaitedMs = reply.waitedMs;
            lastTurn = { baseline, sent: message };
            offerBaseline = new Set(keys.keys());
            history.push(
              `clicked ${control.name}${quickReply ? " (a quick reply)" : ""} → ` +
                (reply.received ? `reply: ${quote(reply.text, 300)}` : noReply(reply)),
            );
          } else {
            history.push(`clicked ${control.name}`);
          }
          cleared(control);
        } else {
          history.push(`click failed: ${failNote(r.reason, control)}`);
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
      stop = "crashed";
    }
    // Else (#128): `stop`/`failure` were already set to `inconclusive`/`target-unreachable` at the
    // point the first navigation failed — the sentinel only unwound the loop, nothing more to do.
  }

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
  return {
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

