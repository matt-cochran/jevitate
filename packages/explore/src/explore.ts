import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { type Recording, type ValueOrVar } from "@jevitate/recording";
import {
  type Bounds,
  type StopReason,
} from "./bounds.js";
import {
  isAuthorizedExploreTarget,
} from "./authorized-targets.js";
import type { Snapshot } from "./snapshot.js";
import { perceive } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { summarizeTimings, type TimingSummary } from "./timing.js";
import { hangRoute, probeResponsive, type HangSignal } from "./hang.js";
import { type HostProbe } from "./host-pressure.js";
import type { HostHealthSampler } from "./host-health.js";
import { HANG_PROBE_MS } from "./perceive.js";
import { type HangConfig, type SettleConfig, type TimingConfig } from "./settle-config.js";
import { decide, type Decision } from "./decide.js";
import { isCredentialField } from "./auth-completion.js";
import { capFormText, chatReply, matchOption } from "./fill.js";
import { CLEARS_FIELD, isPlaceholderOption } from "./select-choice.js";
import {
  type SecretField,
  boundSecretField,
  maskSecretFields,
} from "./secret-fields.js";
import { act, parseInterceptor } from "./act.js";
import { awaitWrites, type SideEffect } from "./side-effects.js";
import { sendable } from "./actions.js";
import type { Control } from "./snapshot.js";
import { coveredByInterceptors } from "./occlusion.js";
import { descriptorToLocator } from "@jevitate/recorder";
import {
  answerNotFoundReason,
  controlFields,
  type RunAnswer,
} from "./answer.js";
import {
  STUCK_TURNS,
  isSubmitControl,
  lastQuestion,
  newPageText,
  readPageHeadings,
  readPageText,
  repetitiveTurns,
  sameMessage,
  waitForReply,
  type ReplyResult,
  type RunOutcome,
} from "./conversation.js";
import { emptyRecording } from "./record.js";
import { planTextEdit, readEditableText } from "./rich-text.js";
import { describeTextEdit } from "@jevitate/interpreter";
import { ChromeTracker } from "./feature/relevance.js";
import { redactText, redactUrl } from "./redact.js";
import { type TranscriptEntry, type TranscriptListener } from "./transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { assertTargetAnswering, describeFailure, describeUnreachable, isPageUnresponsive, isTargetUnresponsive, isUnreachableTarget, targetStoppedAnswering, assertSeedReachable } from "./mission-failure.js";
import {
  describeStatus,
  isEmptyStatus,
  readDocumentedWait,
  readPageStatus,
  readWorkingStatus,
  statusDelta,
} from "./status.js";
import { type SafetyConfig } from "./safety.js";
import { NO_DESTRUCTIVE_NOTE, READ_ONLY_NOTE } from "./read-only.js";
import { markTypeFixtures, type TypeFixture } from "./type-fixtures.js";
import { buildCrashReport, sampleHeap, type CrashReport } from "./crash-report.js";
import { backgroundEndpoints, requestsStartedSince, writesStartedSince } from "./stuck-actions.js";
import type { HeapSample } from "@jevitate/domain";
import { deltaPromptLine, deltaQuotableText, deltaRecord, type ActionDeltaStats } from "./action-delta.js";
import * as limits from "./goal-loop/limits.js";
import { createRunContext } from "./goal-loop/context.js";
import { newStep, type ActStep } from "./goal-loop/step.js";
import { handleReport } from "./goal-loop/handle-report.js";
import {
  EXPECTED_RETURN,
  FirstNavigationFailedSentinel,
  JOB_WAIT_SLICE_MS,
  MAX_TYPE_NO_EFFECT,
  TOGGLE_ROLES,
  TOO_MANY_CHOICES,
  TOO_MANY_CHOICES_RETRY,
  buttonLike,
  documentedWaitBudgetMs,
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
  waitOutJob,
  withCause,
} from "./goal-loop/helpers.js";
import { handleDone } from "./goal-loop/handle-done.js";
import { handleBlocked } from "./goal-loop/handle-blocked.js";
import { handleWaitOrScroll } from "./goal-loop/handle-idle.js";
import { handleReload } from "./goal-loop/handle-reload.js";
import { beginAction } from "./goal-loop/act-gate.js";
import { refuseAction } from "./goal-loop/act-gate.js";
import { handleCodeTypedField } from "./goal-loop/handle-code-typed.js";

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


export async function explore(cfg: ExploreConfig): Promise<ExploreRun> {
  const ctx = await createRunContext(cfg);

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

      const step = newStep(ctx, { perceiveStartedAt, perception, snap, modelControls, keys, offered, unsubmitted, visibleText, decision });
      const { record, signIn, pendingNote, acceptedBy, groundGoal } = step;

      const flow = await handleDone(ctx, step);
      if (flow === "stop") break;
      if (flow === "continue") continue;
      // `report` (#101) ends a find-out goal with an ANSWER — a proposal too: the answer is generated
      // from the observed page text and accepted only when code grounds every claim on it.
      if (decision.op === "report") {
        const flow = await handleReport(ctx, step);
        if (flow === "stop") break;
        continue;
      }
      if (decision.op === "blocked") {
        const flow = await handleBlocked(ctx, step);
        if (flow === "stop") break;
        continue;
      }

      const control = decision.control;
      if (ctx.overlay !== null && (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait" || decision.op === "reload")) {
        await ctx.overlay.announce(ctx.page, { step: ctx.transcript.nextStep, strategy: "goal", op: decision.op, why: ctx.overlayWhy });
      }
      if (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait") {
        const flow = await handleWaitOrScroll(ctx, step);
        if (flow === "stop") break;
        continue;
      }
      ctx.idleSteps = 0;
      ctx.quietWaits = 0;
      ctx.actionAttempts += 1;

      if (decision.op === "reload") {
        const flow = await handleReload(ctx, step);
        if (flow === "stop") break;
        continue;
      }

      // Target-requiring op with no valid target → fail-closed.
      if (control === null || decision.targetMissing) {
        record(false, "no valid target (fail-closed)", { origin: "engine" });
        ctx.stop = "blocked";
        break;
      }
      const refused = await refuseAction(ctx, step, control);
      if (refused === "stop") break;
      if (refused === "continue") continue;
      const at = await beginAction(ctx, step, control);
      if (at === "stop") break;
      const acting: ActStep = { ...step, control, at };

      const typed = await handleCodeTypedField(ctx, acting);
      if (typed === "stop") break;
      if (typed === "continue") continue;

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


