import type { Actor } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { type Recording } from "@jevitate/recording";
import {
  type Bounds,
  type StopReason,
} from "./bounds.js";
import type { Snapshot } from "./snapshot.js";
import { type TimingSummary } from "./timing.js";
import { type HangSignal } from "./hang.js";
import { type HostProbe } from "./host-pressure.js";
import type { HostHealthSampler } from "./host-health.js";
import { type HangConfig, type SettleConfig, type TimingConfig } from "./settle-config.js";
import {
  type SecretField,
} from "./secret-fields.js";
import { type SideEffect } from "./side-effects.js";
import { sendable } from "./actions.js";
import type { Control } from "./snapshot.js";
import {
  type RunAnswer,
} from "./answer.js";
import {
  type RunOutcome,
} from "./conversation.js";
import { ChromeTracker } from "./feature/relevance.js";
import { type TranscriptEntry, type TranscriptListener } from "./transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { describeFailure, isPageUnresponsive, isTargetUnresponsive } from "./mission-failure.js";
import { type SafetyConfig } from "./safety.js";
import { type TypeFixture } from "./type-fixtures.js";
import { type CrashReport } from "./crash-report.js";
import type { HeapSample } from "@jevitate/domain";
import { type ActionDeltaStats } from "./action-delta.js";
import * as limits from "./goal-loop/limits.js";
import { createRunContext } from "./goal-loop/context.js";
import { newStep, type ActStep } from "./goal-loop/step.js";
import { handleReport } from "./goal-loop/handle-report.js";
import {
  FirstNavigationFailedSentinel,
  isActionOrChromeName as actionOrChromeName,
  keyOf,
  quote,
} from "./goal-loop/helpers.js";
import { handleDone } from "./goal-loop/handle-done.js";
import { handleBlocked } from "./goal-loop/handle-blocked.js";
import { handleWaitOrScroll } from "./goal-loop/handle-idle.js";
import { handleReload } from "./goal-loop/handle-reload.js";
import { beginAction } from "./goal-loop/act-gate.js";
import { refuseAction } from "./goal-loop/act-gate.js";
import { handleCodeTypedField } from "./goal-loop/handle-code-typed.js";
import { handleEditText } from "./goal-loop/handle-edit-text.js";
import { handleMessage } from "./goal-loop/handle-message.js";
import { handleSelectOption } from "./goal-loop/handle-select.js";
import { handleUpload } from "./goal-loop/handle-upload.js";
import { handleClick } from "./goal-loop/handle-click.js";
import { handleFill } from "./goal-loop/handle-fill.js";
import { perceiveStep } from "./goal-loop/observe.js";
import { captureDelta } from "./goal-loop/observe.js";
import { checkHang } from "./goal-loop/hang-check.js";
import { checkSettled } from "./goal-loop/settled-checks.js";
import { checkProgress } from "./goal-loop/progress.js";
import { viewPage } from "./goal-loop/page-view.js";
import { decideStep } from "./goal-loop/decide-step.js";
import { finishRun } from "./goal-loop/finish.js";
import { openRun } from "./goal-loop/start.js";

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
    await openRun(ctx);

    for (;;) {
      if (!ctx.tracker.mayDecide()) {
        ctx.stop = "exhausted";
        break;
      }

      const seen = await perceiveStep(ctx);
      const { perceiveStartedAt, perception, snap } = seen;
      const delta = await captureDelta(ctx, seen);
      if (delta === "continue") continue;

      const hung = await checkHang(ctx, seen);
      if (hung === "stop") break;
      if (hung === "continue") continue;

      const settled = await checkSettled(ctx, seen);
      if (settled === "stop") break;

      const progressed = await checkProgress(ctx, seen);
      if (progressed === "stop") break;

      const view = await viewPage(ctx, seen);
      const { modelControls, keys, offered, unsubmitted, visibleText } = view;

      const decision = await decideStep(ctx, seen, view);
      if (decision === "stop") break;
      const step = newStep(ctx, { perceiveStartedAt, perception, snap, modelControls, keys, offered, unsubmitted, visibleText, decision });
      const { record } = step;

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
        const flow = await handleEditText(ctx, acting);
        if (flow === "stop") break;
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
        const flow = await handleMessage(ctx, acting, op, forcedNote);
        if (flow === "stop") break;
        continue;
      }

      if (op === "send") {
        // Not message-shaped after all (unreachable: `send` is always a message) — fail closed.
        record(false, "send without a message (fail-closed)", { op, origin: "engine" });
        ctx.stop = "blocked";
        break;
      }

      if (op === "select" && control.options !== undefined && control.options.length > 0) {
        const flow = await handleSelectOption(ctx, acting, op);
        if (flow === "stop") break;
        continue;
      }

      if (decision.op === "type" || decision.op === "select") {
        const flow = await handleFill(ctx, acting);
        if (flow === "stop") break;
        if (flow === "continue") continue;
      } else if (decision.op === "click") {
        const flow = await handleClick(ctx, acting);
        if (flow === "stop") break;
        if (flow === "continue") continue;
      } else {
        const flow = await handleUpload(ctx, acting);
        if (flow === "stop") break;
        if (flow === "continue") continue;
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

  return finishRun(ctx);
}


