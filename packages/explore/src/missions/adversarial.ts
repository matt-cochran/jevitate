import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { redactUrl, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { type Bounds } from "../bounds.js";
import type { Snapshot } from "../snapshot.js";
import { monitorFor } from "../page-monitor.js";
import { type ActionDeltaStats } from "../action-delta.js";
import type { ActionDeltaRecord } from "@jevitate/recording";
import { type TimingSummary } from "../timing.js";
import { type HostProbe } from "../host-pressure.js";
import type { HostHealthSampler } from "../host-health.js";
import type { HangConfig, SettleConfig, TimingConfig } from "../settle-config.js";
import { type HangFinding } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";
import {
  type TranscriptEntry,
  type TranscriptListener,
} from "../transcript.js";
import { describeFailure, describeUnreachable, isPageUnresponsive, isTargetUnresponsive, isUnreachableTarget, type Triage, assertSeedReachable } from "../mission-failure.js";
import { type CrashReport } from "../crash-report.js";
import type { HeapSample } from "@jevitate/domain";
import { type DefectSignal } from "../adversarial/defect-oracle.js";
import {
  normalizeRoute,
} from "../adversarial/defect-fingerprint.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import {
  controlKey,
  detectForms,
  isExercisable,
  planMisuseEpisode,
  type EpisodeContext,
  type MisuseStep,
} from "../adversarial/form-misuse.js";
import { controlIdentity } from "../coverage/fingerprint.js";
import {
  type AdversarialCoverage,
  type CoverageThresholds,
} from "../adversarial/run-coverage.js";
import { seedRedirectReason } from "../seed-redirect.js";
import type { SafetyConfig } from "../safety.js";
import { type SideEffect } from "../side-effects.js";
import type { InvariantSpec } from "@jevitate/recording";
import {
  type InvariantReport,
  type InvariantViolation,
} from "../declared-invariants.js";
import { type BudgetTrajectory } from "../budget.js";
import { demoOverlayFor, type DemoOverlay } from "../demo-overlay.js";
import { identityChange, readIdentity } from "../adversarial/identity.js";
import { canaryPayloadOf, canaryTokenOf } from "../adversarial/markup-canary.js";
import {
  FORM_STRATEGY,
  isDisabledNow,
  isUnactionableFailure,
  joinReasons,
  nativeValidationMessage,
  submitRequestSent,
} from "./adversarial-hunt/helpers.js";
import { startHunt } from "./adversarial-hunt/start.js";
import { createHuntContext, type HuntState } from "./adversarial-hunt/context.js";
import { DEFAULT_TIME_BUDGET_MS } from "./adversarial-hunt/helpers.js";

/**
 * runAdversarialMission — a bounded "try to break it" run that KEEPS HUNTING.
 *
 * The mission cycles bounded misuse strategies (ordering violations,
 * repeated/rapid actions, navigation during pending async, boundary/invalid
 * inputs chosen by field semantics, contradictory actions, following links to
 * other routes) until its step, action or time budget runs out, and after EVERY
 * step asks a TRUSTED HARD-SIGNAL oracle (`PageSignalCollector`) whether the app
 * broke — a console error, an HTTP 5xx, a failed request, an unhandled page
 * exception — plus the user's invariants: an optional code-level `userInvariant` and the app-
 * declared invariant spec (#86), both evaluated around every adjudicated step.
 *
 * A defect is the mission's SUCCESS case, so it is data: finding one does not
 * stop the run. Each defect is keyed by a stable fingerprint (signal kind +
 * normalized route/endpoint + status/message class — see
 * `defect-fingerprint.ts`); a later occurrence of the same fingerprint only
 * counts an occurrence. Every defect carries its reproduction: the ordered
 * transcript steps that led to it and the flat index of the Recording step to
 * replay up to (`RecordingInterpreter.runToCheckpoint`), which `verifyFix`
 * replays to decide "fixed" vs "still reproduces".
 *
 * GUARDRAIL #4 (the mission's defining property): a defect comes EXCLUSIVELY
 * from that independent oracle or the user invariant. Jev's `Noul` "does this
 * look broken?" is a SOFT augment only — recorded in the transcript and
 * discarded; it can never, alone, conclude a defect. A "looks broken" Noul with
 * no hard signal MUST NOT surface as a defect (proved in adversarial.test.ts).
 *
 * The triage narrative gets a REDACTED failure summary + URL only (never raw
 * form state — guardrail #3). It is a HELPER: when it cannot be generated the
 * defect is still recorded with its raw evidence and the triage is marked
 * `unavailable` with the reason.
 *
 * The outcome is always a typed result, never a throw: an engine failure
 * (browser/page crash, unexpected exception) returns `crashed` with the partial
 * transcript, Recording and every defect found so far; a seed page that never
 * renders returns `inconclusive`. Neither can ever read as `clean`.
 */

/** How to reproduce a defect: the steps that led to it and where to replay the Recording to. */
export interface DefectRepro {
  /** The ordered transcript steps up to and including the one that surfaced the defect. */
  readonly steps: TranscriptEntry[];
  /** Flat index (pages→steps) of the last Recording step to replay; `runToCheckpoint` target. */
  readonly recordingStepIndex: number;
  /**
   * The Recording to replay, when the finding came after a RESET (the mission started over on a
   * fresh page after a hang): that segment's own Recording. Absent ⇒ the run's `recording`.
   */
  readonly recording?: Recording;
}

/**
 * #301 — a field whose submitted input the app rendered as MARKUP: the inert canary
 * (`<i data-jev-canary=…>` or an attribute break) became a real element/attribute in the page's DOM.
 */
export interface MarkupInjection {
  /** The field's accessible name. */
  readonly field: string;
  /** `html`: an injected element; `attribute`: a quoted attribute value broken out of. */
  readonly payload: "html" | "attribute";
  /** The (redacted) page the canary was submitted on. */
  readonly submittedOn: string;
  /** The (redacted) page it was found rendered as markup on. */
  readonly renderedOn: string;
  /** Seen right after the submit settled. */
  readonly afterSubmit: boolean;
  /** Seen after the page was loaded again (a GET of the same URL — never a re-sent form). */
  readonly afterReload: boolean;
  /** Persisted (seen after a reload, or on a later page): `stored`; else `reflected`. */
  readonly stored: boolean;
}

export interface AdversarialDefect {
  /** Stable identity (16 hex): same bug, same fingerprint — across steps and across runs. */
  readonly fingerprint: string;
  /** Every signal fingerprint seen with it (the cascade one broken call fires). */
  readonly related: string[];
  /** #303 (`actionDeltas`): what the action at its first occurrence changed on the page — evidence. */
  readonly actionDelta?: ActionDeltaRecord;
  readonly kind: DefectSignal["kind"] | "invariant" | "markup-injection";
  readonly title: string;
  /** Normalized route (path pattern) of the page it was first seen on. */
  readonly route: string;
  /** The (redacted) page URL it was first seen on. */
  readonly url: string;
  /** The raw hard-signal evidence of its first occurrence. */
  readonly signals: DefectSignal[];
  /** The invariant's reason, for an `invariant` defect. */
  readonly invariantReason?: string;
  /** For a DECLARED invariant (#86): its id, expression, before/after values, action and evidence. */
  readonly invariant?: InvariantViolation;
  /** For a `markup-injection` defect (#301): the field, the pages, and stored vs reflected. */
  readonly markupInjection?: MarkupInjection;
  readonly firstSeenStep: number;
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
  readonly repro: DefectRepro;
  readonly triage: Triage;
}

/**
 * A console error correlated with a captured 4xx response (#88): reported for visibility, but
 * NEVER a defect — a 4xx is a response the server returned by design (an authorization refusal, a
 * validation error), so it is advisory, lower severity, and never counted toward `defects-found`.
 * A 5xx-correlated (or uncorrelated) console error is unaffected and still files as a defect.
 */
export interface AdvisorySignal {
  /** Stable identity (16 hex): same signal, same fingerprint — across steps and across runs. */
  readonly fingerprint: string;
  readonly kind: "console-error";
  readonly title: string;
  /** Normalized route (path pattern) of the page it was first seen on. */
  readonly route: string;
  /** The (redacted) page URL it was first seen on. */
  readonly url: string;
  /** The correlated response's status (a 4xx); unset for a third-party frame's error (#297). */
  readonly status?: number;
  /** The raw console-error detail. */
  readonly detail: string;
  /** #297: the (redacted) URL of the frame that logged it, when known. */
  readonly frameUrl?: string;
  /** #297: the third-party frame's origin — the vendor's own error, never the app's defect. */
  readonly thirdPartyFrame?: string;
  readonly firstSeenStep: number;
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
}

/** Why the hunt ended (the mission's budget, or nothing left to try). */
export type AdversarialStop =
  | "step-budget"
  | "action-budget"
  | "time-budget"
  | "strategies-exhausted"
  | "not-rendered"
  /** The start URL did not stay in scope (it redirected elsewhere), so the target could not be tested. */
  | "scope-unreachable"
  | "hang"
  | "crashed"
  /** A declared mission spend budget (#150) was crossed, or a paid action was refused before crossing it. */
  | "budget"
  /**
   * #209: every target control the run found was refused by the safety policy (paid, destructive,
   * `--deny`'d) and none could be exercised — hunting on would only scroll and re-plan. The run is
   * `inconclusive` (`insufficient-coverage`), its shortfall naming the refusal and how to permit it.
   */
  | "targets-refused"
  /** #226: the app stopped answering navigation mid-run (e.g. its server froze): `inconclusive`, `failure.kind: "target-unresponsive"`. */
  | "target-unresponsive"
  /**
   * #300: an action switched the signed-in identity and the original one could not be restored (no
   * fresh session from the original storage state, or it no longer signs in as the same identity):
   * `inconclusive`, `failure.kind: "identity-changed"` — a defect found before still wins.
   */
  | "identity-changed"
  /** #296: the page's renderer stopped answering and was closed by the liveness watchdog: `inconclusive`, `failure.kind: "stalled"`. */
  | "stalled"
  /** #205: the run's browsers went over the memory ceiling and the governor ended the session: `inconclusive`, `failure.kind: "resource-limit"`. */
  | "resource-limit";

/**
 * #300 — one time an action switched the signed-in identity (a "Continue as demo" shortcut on a
 * login page, a "switch user" control). The step's invariants were NOT judged (they were declared
 * for the original identity), the control is never picked again, and the run went back to the start
 * URL in a fresh session from the original storage state. Names auth state by name only — never a
 * cookie or token value.
 */
export interface IdentityChange {
  /** The transcript step whose action switched the identity. */
  readonly step: number;
  /** What was acted on (control name or op). */
  readonly action: string;
  /** The (redacted) URL the action landed on. */
  readonly url: string;
  /** Normalized route of that URL. */
  readonly route: string;
  /** What changed (auth entries by name: appeared, removed, re-issued, another subject). */
  readonly reason: string;
  /** Whether the original identity was restored (false ⇒ the run stopped: `stop: "identity-changed"`). */
  readonly restored: boolean;
}

/** The typed result of an adversarial run — returned for every ending, including engine failure. */
export interface AdversarialOutcome {
  readonly outcome: MissionOutcome;
  /** #303 (`actionDeltas`): verdict counts over the settled actions (`noChange`: actions with no visible effect). */
  readonly actionDeltas?: ActionDeltaStats;
  readonly stop: AdversarialStop;
  /** Distinct defects (deduped by fingerprint), in first-seen order. */
  readonly defects: AdversarialDefect[];
  /** 4xx-correlated console errors (#88): reported, deduped by fingerprint, never counted as defects. */
  readonly advisories: AdvisorySignal[];
  /** Hangs found (the run stops at a hang), each with its fresh-context reproduction k/N. */
  readonly hangs: HangFinding[];
  /** The run's Recording (partial when the run crashed) — every defect's repro path. */
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  /** Why the run ended `crashed`/`inconclusive`. */
  readonly failure?: MissionFailure;
  /** The page's JS heap per step (resource evidence for crash attribution). */
  readonly heap: HeapSample[];
  /** For a `crashed` run: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Per-run timing summary: slowest pages/transitions and endpoints (p50/max), keyed by route. */
  readonly timing: TimingSummary;
  /** The target scope and every departure from it. */
  readonly scope: AdversarialScope;
  /** What the run exercised on its target, and whether that was enough for silence to mean clean. */
  readonly coverage: AdversarialCoverage;
  /** Per declared invariant (#86): how often it applied, held, was violated, or could not be read. */
  readonly invariants?: InvariantReport[];
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects?: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
  /** #300: every action that switched the signed-in identity (present when one did). */
  readonly identityChanges?: IdentityChange[];
}

export interface AdversarialMissionParams {
  readonly page: Page;
  readonly actor: Actor;
  readonly judgment: JudgmentPort;
  readonly generation: GenerationPort;
  readonly seedUrl: string;
  /**
   * #293 journey-anchored exploration: the page is ALREADY at `seedUrl`'s state (a Journey prefix was
   * replayed into this session), so the first navigation is skipped and the mission starts on the
   * live page. A later reset (after a hang or an identity change) still re-navigates to `seedUrl`.
   */
  readonly startInPlace?: boolean;
  /**
   * #293: how the mission gets back to its start state on a reset (after a hang, an identity change),
   * instead of re-navigating to `seedUrl` — a journey-anchored run re-replays its Journey prefix, so
   * in-page state (a half-filled form) is restored too. Resolves `false` when it could not (a stale
   * prefix): the run then cannot go on (`scope-unreachable`). Each call costs `restartCost` actions
   * from `maxActions`.
   */
  readonly restartAtStart?: (actor: Actor) => Promise<boolean>;
  /** #293: the actions one `restartAtStart` costs against `maxActions` (the prefix's step count). Default 0. */
  readonly restartCost?: number;
  readonly allowlist: readonly string[];
  /** The strategies, cycled in order until a budget runs out. */
  readonly strategies: readonly MisuseStrategy[];
  /** `maxDecisions` caps strategy steps, `maxActions` caps executed actions. */
  readonly bounds?: Partial<Bounds>;
  /** Wall-clock budget for the hunt (ms). Default 10 minutes. */
  readonly timeBudgetMs?: number;
  /** An independent, user-declared (code-level) invariant. `ok:false` is a HARD defect. */
  readonly userInvariant?: (page: Page) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * App-declared invariants (#86): the closed, declarative spec, snapshotted before each action and
   * evaluated after it (with every `never`). A violation is a HARD defect keyed by id + route —
   * the same oracle path as `userInvariant`, generalised to before/after, network and probes.
   */
  readonly invariants?: InvariantSpec;
  /** Recording.site label. Defaults to the seed origin. */
  readonly site?: string;
  /** Bound (ms) on waiting for a rendered page before each strategy step. Default `RENDER_WAIT_MS`. */
  readonly renderWaitMs?: number;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
  /** Incremental-flush seam: the partial Recording after every recorded step. */
  readonly onRecording?: (recording: Recording) => void;
  /** Clock seam (ms). Default `Date.now`. */
  readonly now?: () => number;
  /** Registered secret values: redacted out of the transcript and the Recording. */
  readonly secrets?: readonly string[];
  /**
   * #303 `--action-deltas` (opt-in): record what each settled action changed on the page (code
   * verdict), on its transcript step and as evidence on the defects it found. Never changes what the
   * strategies plan: a misuse with no visible effect is often the app behaving correctly. Off: no capture.
   */
  readonly actionDeltas?: boolean;
  /** #245: show the on-page demo overlay (display only; invisible to the run). Default off: nothing injected. */
  readonly demoOverlay?: boolean;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * Opens a FRESH browser session — used to reproduce a hang by replaying its steps. Without it a
   * hang cannot be confirmed and is reported `intermittent` (0 replays), never dropped.
   */
  readonly openFreshSession?: () => Promise<VerifySession>;
  /** How many fresh-context replays confirm a hang. Default 2. */
  readonly hangReplays?: number;
  /** Bound on the main-thread probe (ms). Default `HANG_PROBE_MS`. */
  readonly hangProbeMs?: number;
  /** A request pending longer than this (ms) is a hang. Default: half the render ceiling. */
  readonly requestBoundMs?: number;
  /** Samples the HOST's resource pressure for hang/crash evidence. Default: this platform's signals. */
  readonly hostProbe?: HostProbe;
  /** The run's host-health sampler (#203): a hang met while the host was starved is `environment-degraded`, never a finding. */
  readonly hostHealth?: HostHealthSampler;
  /** The target's timing configuration (API path prefixes). */
  readonly timingConfig?: TimingConfig;
  /** The target's settle configuration (background requests, long-poll threshold). */
  readonly settle?: SettleConfig;
  /** The target's hang configuration (`ui-no-progress` ignores). */
  readonly hangs?: HangConfig;
  /**
   * The shared safety policy (#116). Misuse never targets a session-ending or destructive control
   * (form-misuse's own rule, whatever this says); the policy adds paid and --deny'd controls.
   */
  readonly safety?: SafetyConfig;
  /**
   * Extra in-scope route globs (CLI `--route`, the feature mission's glob syntax). The scope is
   * always the start URL's route and everything under it; these add to it.
   */
  readonly routeGlobs?: readonly string[];
  /**
   * How much of the target a run must exercise before "found nothing" may be reported `clean`.
   * Default `DEFAULT_COVERAGE_THRESHOLDS` (25% of the target's controls, and a submitted form when
   * there is one). Below them a silent run is `inconclusive`, with its coverage attached.
   */
  readonly coverageThresholds?: Partial<CoverageThresholds>;
  /**
   * Horizontal-overflow hard signal (#149): checked once per adjudicated step and, when it fires,
   * folded into that step's hard signals as a `DefectSignal` — a hard defect (guardrail #4), never a
   * Jev judgment. Runs by default only when the emulated viewport is narrower than 1024px, or always
   * when `checkOverflow` is set (CLI `--check-overflow`). Mirrors `induction.ts`'s `overflow` param.
   */
  readonly overflow?: {
    readonly checkOverflow?: boolean;
    readonly toleranceCss?: number;
    /** `--ignore-overflow <selector>` (repeatable): intentional overflow, never a defect. */
    readonly ignoreSelectors?: readonly string[];
    /** The device name (`--device`), recorded on a finding for context. */
    readonly device?: string;
    readonly secrets?: readonly string[];
  };
}

/** One time the run left its target scope (and was reset to the start URL). */
export interface ScopeDeparture {
  /** The transcript step whose action left the scope. */
  readonly step: number;
  /** The (redacted) URL it landed on. */
  readonly url: string;
  /** What was acted on (control name or op). */
  readonly action: string;
}

/** Where the run was allowed to hunt, and how often it left. Out-of-scope steps never count as coverage. */
export interface AdversarialScope {
  readonly routeGlobs: string[];
  /** Steps whose result landed outside the scope (each was followed by a reset). */
  readonly outOfScopeSteps: number;
  /** The first departures (up to 50), in order. */
  readonly departures: ScopeDeparture[];
  /** Times the run moved to a fresh page (after a departure or a hang). */
  readonly resets: number;
}

export const DEFAULT_ADVERSARIAL_TIME_BUDGET_MS = DEFAULT_TIME_BUDGET_MS;

export async function runAdversarialMission(params: AdversarialMissionParams): Promise<AdversarialOutcome> {
  const overlay = demoOverlayFor(params.demoOverlay, params.secrets ?? []);
  const out = await runAdversarialHunt(params, overlay);
  await overlay?.finish(
    `jevitate · adversarial — ${out.stop}: ${out.defects.length} defect${out.defects.length === 1 ? "" : "s"}`,
    out.defects.length === 0 && out.stop !== "crashed",
  );
  return out;
}

async function runAdversarialHunt(params: AdversarialMissionParams, overlay: DemoOverlay | null): Promise<AdversarialOutcome> {
  const ctx: HuntState = createHuntContext(params);

  try {
    // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
    await monitorFor(ctx.sessions.page).instrument();
    ctx.safety.attach(monitorFor(ctx.sessions.page));
    // #128: real network evidence for the FIRST navigation — a refused connection can still
    // surface as a bare navigation timeout.
    let firstNavNetError: string | null = null;
    const onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
      const text = req.failure()?.errorText;
      if (text !== undefined) firstNavNetError = text;
    };
    ctx.sessions.page.on("requestfailed", onFirstNavRequestFailed);
    try {
      if (params.startInPlace !== true) {
        await assertSeedReachable(ctx.sessions.actor, params.seedUrl);
        await Navigate.to(params.seedUrl).performAs(ctx.sessions.actor);
      }
    } catch (e) {
      const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
      return ctx.finish("inconclusive", "scope-unreachable", {
        kind: "target-unreachable",
        message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
      });
    } finally {
      ctx.sessions.page.off("requestfailed", onFirstNavRequestFailed);
    }
    ctx.recorder.navigate(params.seedUrl, ctx.now());
    ctx.started = ctx.now();

    const seed = await ctx.perceiveNow();
    if (seed.hang !== null) {
      await ctx.recordHang(seed.hang, seed.snapshot, seed.timing);
      return ctx.finish(ctx.verdict(), "hang");
    }
    if (!seed.rendered) {
      // Nothing to misuse. #208: the page's own load is still adjudicated — a start page that
      // answered 5xx (or threw) IS a defect, found by the hard-signal oracle before any misuse, and
      // wins over "inconclusive". With no signal, the run proves nothing (never `clean`).
      const seedVerdict = await ctx.adjudicate();
      const step = ctx.transcript.nextStep;
      const why = seed.reason ?? "page did not render";
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: seedVerdict === null ? `${why} (inconclusive)` : `${why}; ${seedVerdict.reason}`,
        snapshot: seed.snapshot,
        timing: seed.timing,
      });
      if (seedVerdict !== null) {
        await ctx.fold(step, seedVerdict.findings);
        ctx.foldAdvisories(step, seedVerdict.advisories);
      }
      // `failure` explains a broken run only: a found defect is the run's result, not its failure.
      if (ctx.defects.size > 0) return ctx.finish("defects-found", "not-rendered");
      return ctx.finish("inconclusive", "not-rendered", {
        kind: "exception",
        message: `${why}${seedVerdict === null ? "" : `: ${seedVerdict.reason}`}`,
      });
    }
    // The seed redirected to a login-like page — most often a lost/expired `--storage-state`
    // session (#82). Checked BEFORE the general scope check below (which already catches ANY
    // out-of-scope landing) so THIS specific, actionable cause gets its own reason; every other
    // departure keeps the existing generic "left the target scope" message unchanged.
    const redirect = seedRedirectReason(params.seedUrl, seed.snapshot.url);
    if (redirect !== null && redirect.loginLike) {
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: `${redirect.reason} (inconclusive)`,
        snapshot: seed.snapshot,
        timing: seed.timing,
      });
      return ctx.finish("inconclusive", "scope-unreachable", { kind: "target-unreachable", message: redirect.reason });
    }
    if (!ctx.inScope(seed.snapshot.url)) {
      // The start URL did not stay on the target (another route, off-allowlist): the run cannot
      // test what it was asked to — it proves nothing, so it is never `clean`.
      const message = `the start URL left the target scope (landed on ${redactUrl(seed.snapshot.url)})`;
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: `${message} (inconclusive)`,
        snapshot: seed.snapshot,
        timing: seed.timing,
      });
      return ctx.finish("inconclusive", "scope-unreachable", { kind: "target-unreachable", message });
    }
    // #300: who the run is signed in as (or that it is signed out), before any action.
    ctx.baseline = await readIdentity(ctx.sessions.page);
    ctx.snap = seed.snapshot;
    // A perception's timing is reported ONCE — on the first step decided on it — so a run whose
    // strategies found nothing to do on a page does not count that page's load several times.
    ctx.snapTiming = seed.timing;
    ctx.recorder.observed(ctx.snap.url, ctx.now(), seed.timing);

    // Step 1 is the seed load itself: an AMBIENT defect (a 5xx fired while the page loads, before
    // any misuse) is attributed to loading the page, and its repro is just the navigation.
    {
      const verdict = await ctx.adjudicate();
      const step = ctx.transcript.nextStep;
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: true,
        reason: verdict === null ? "seed page loaded" : verdict.reason,
        snapshot: ctx.snap,
        timing: seed.timing,
      });
      ctx.snapTiming = undefined;
      if (verdict !== null) {
        await ctx.fold(step, verdict.findings);
        ctx.foldAdvisories(step, verdict.advisories);
      }
    }

    // #150 — a budget's baseline is read once, on the seed's settled snapshot, before any action.
    // An unreadable baseline fails closed by default (`onUnreadable: "stop"`). A defect found on the
    // seed load itself (just above) still wins over the budget stop.
    if (ctx.budget !== null) {
      const b = await ctx.budget.baseline(ctx.sessions.page);
      if (b.crossed) {
        ctx.transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "budget",
          actOk: false,
          reason: b.reason ?? "budget observable unreadable at run start",
          snapshot: ctx.snap,
        });
        return ctx.finish(ctx.budgetVerdict(), "budget");
      }
    }

    startHunt(ctx, params);

    while (ctx.stop === null) {
      if (ctx.strategySteps >= ctx.bounds.maxDecisions) {
        ctx.stop = "step-budget";
        break;
      }
      if (ctx.actions + ctx.restartSpend >= ctx.bounds.maxActions) {
        ctx.stop = "action-budget";
        break;
      }
      if (ctx.now() - ctx.started >= ctx.timeBudgetMs) {
        ctx.stop = "time-budget";
        break;
      }
      const strategy = params.strategies[ctx.strategySteps % params.strategies.length];
      if (strategy === undefined) throw new Error("adversarial: strategy index out of range");
      ctx.strategySteps += 1;
      const round = ctx.rounds.get(strategy) ?? 0;
      // A snapshot armed by an episode that ended without an adjudication (budget, disabled target)
      // is stale: the next action gets a fresh one, so no effect is attributed to the wrong action.
      ctx.armed = false;
      ctx.chainStart = null;

      // A perception's timing is reported once — on the first step decided on it.
      let stepSnap = ctx.snap;
      let stepTiming = ctx.snapTiming;
      ctx.snapTiming = undefined;
      ctx.observeTarget(ctx.snap);
      // #209: when EVERY target control on the page is one the safety policy refuses (three "Buy"
      // buttons, refused as paid), no strategy can exercise anything — stop now, naming the refusal,
      // instead of scrolling and re-planning until the budget runs out.
      if (ctx.inScope(ctx.snap.url)) for (const c of ctx.snap.controls) if (isExercisable(c, ctx.inScope)) ctx.refuses(c);
      if (ctx.cov.everyTargetRefused()) {
        ctx.stop = "targets-refused";
        break;
      }
      const planning = (on: Snapshot, as: MisuseStrategy, extra: Partial<EpisodeContext> = {}): EpisodeContext => ({
        snapshot: on,
        strategy: as,
        round: ctx.rounds.get(as) ?? 0,
        last: ctx.last,
        visitedLinks: ctx.visitedLinks,
        exercised: ctx.cov.exercisedKeys,
        blacklisted: ctx.refusedIds.size === 0 ? ctx.unactionable : new Set([...ctx.unactionable, ...ctx.refusedIds]),
        inScope: ctx.inScope,
        refuses: ctx.refuses,
        isChrome: ctx.isChrome,
        disclosures: { revealed: ctx.revealed, barren: ctx.barren },
        rng: Math.random,
        canary: () => ctx.canaries.next(),
        ...extra,
      });
      let episode = planMisuseEpisode(planning(ctx.snap, strategy));
      /** The strategy the episode actually runs (a fallback to `exercise-controls`, #193). */
      let ran: MisuseStrategy = strategy;

      ctx.cov.strategy(strategy, episode !== null);
      // #193: a strategy with nothing to do here never idles while target controls are still
      // unexercised — when the run hunts with `exercise-controls`, the turn exercises one instead.
      if (episode === null && ctx.exercises && strategy !== "exercise-controls") {
        const fallback = planMisuseEpisode(planning(ctx.snap, "exercise-controls"));
        if (fallback !== null) {
          ran = "exercise-controls";
          ctx.cov.strategy(ran, true);
          const note = (st: MisuseStep): string => joinReasons([`no ${strategy} action applies`, st.note]) ?? st.note;
          episode = { steps: fallback.steps.map((st, i) => (i === 0 ? { ...st, note: note(st) } : st)) };
        }
      }
      if (episode === null) {
        ctx.idleStreak += 1;
        // Independent oracle — runs EVERY step, even when a strategy chose no action: the user
        // invariant is an independent probe of live page state, and hard signals may have accrued.
        const step = ctx.transcript.nextStep;
        const verdict = await ctx.adjudicate();
        const soft = verdict === null ? await ctx.softJudgment(stepSnap) : {};
        ctx.transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy,
          actOk: false,
          reason: verdict?.reason ?? joinReasons(["strategy found no applicable action", soft.note]),
          snapshot: stepSnap,
          ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          ...(soft.judgments === undefined ? {} : { judgments: soft.judgments }),
        });
        if (verdict !== null) {
          await ctx.fold(step, verdict.findings);
          ctx.foldAdvisories(step, verdict.advisories);
        }
        // A whole cycle of strategies found nothing to do on this page: there is nothing left.
        if (ctx.idleStreak >= params.strategies.length) ctx.stop = "strategies-exhausted";
        continue;
      }
      ctx.idleStreak = 0;
      ctx.rounds.set(ran, (ran === strategy ? round : (ctx.rounds.get(ran) ?? 0)) + 1);

      // A queue, not a fixed list: a disclosure that reveals a form is followed, in the same turn,
      // by this strategy's own episode on the revealed form (#193).
      const queue: MisuseStep[] = [...episode.steps];
      /** Whether `stepSnap` was re-perceived after an earlier step of this episode. */
      let refreshed = false;
      /** Whether an earlier step of this episode acted without settling (the page may have moved on). */
      let pendingEarlier = false;
      while (queue.length > 0) {
        const s = queue.shift() as MisuseStep;
        if (ctx.actions + ctx.restartSpend >= ctx.bounds.maxActions) break;
        // An earlier step of this episode removed this step's control (a Cancel closed the dialog
        // the Save lived in): the rest of the episode was planned for a state that is gone. It ends
        // here, without spending an action — never a failed act that reads as a broken control.
        const gone = s.control;
        if (refreshed && gone !== null && !stepSnap.controls.some((c) => controlKey(c) === controlKey(gone))) {
          ctx.transcript.record({
            op: null,
            control: gone,
            confidence: null,
            chosenBy: "strategy",
            strategy: ran,
            actOk: false,
            reason: joinReasons([s.note, "no longer on the page after the previous step — episode ends"]),
            snapshot: stepSnap,
            ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          });
          stepTiming = undefined;
          break;
        }
        // A click on a control that is disabled RIGHT NOW is never attempted: it can never mutate
        // anything, so it is a no-op, not an action — counted against no budget, and the episode
        // moves on rather than spending its remaining steps (and the next loop turn's strategy pick)
        // on a target that cannot be clicked. Checked live (not from the planning snapshot), because
        // an earlier step in THIS episode may just have made it enabled (e.g. filling the last
        // required field) — the same live truth `act()`'s own gate re-checks right before clicking.
        if (s.op === "click" && s.control !== null && (await isDisabledNow(ctx.sessions.page, s.control))) {
          const id = controlIdentity(s.control);
          const again = ctx.disabledNow.has(id);
          ctx.disabledNow.add(id);
          if (again) {
            stepTiming = undefined;
            break;
          }
          // #155/#193: a submit that could not be attempted is recorded with WHY — never silently.
          if (s.submitsForm !== undefined) ctx.cov.blocked(stepSnap.url, s.submitsForm, "the submit control is disabled", "disabled");
          ctx.transcript.record({
            op: null,
            control: s.control,
            confidence: null,
            chosenBy: "strategy",
            strategy: ran,
            actOk: false,
            reason: joinReasons([s.note, "target disabled — no-op, choosing another action"]),
            snapshot: stepSnap,
            ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          });
          stepTiming = undefined;
          break;
        }
        if (s.op === "click" && s.control !== null) ctx.disabledNow.delete(controlIdentity(s.control));
        // #300: a control that switched the signed-in identity is never acted on again (a strategy
        // that re-plans it from the live snapshot gets a no-op, counted against no budget).
        if (s.control !== null && ctx.identitySwitchers.has(controlIdentity(s.control))) {
          ctx.transcript.record({
            op: null,
            control: s.control,
            confidence: null,
            chosenBy: "strategy",
            strategy: ran,
            actOk: false,
            reason: joinReasons([s.note, "this control switched the signed-in identity earlier in the run — not acted on again"]),
            snapshot: stepSnap,
            ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          });
          stepTiming = undefined;
          break;
        }
        // The shared safety policy (#116): a paid / session-ending / destructive / --deny'd control is
        // never clicked — a no-op like a disabled target, counted against no budget.
        const unsafe = ctx.safety.gate(s.op, s.control);
        if (unsafe !== null) {
          if (s.control !== null) {
            ctx.refusedIds.add(controlIdentity(s.control));
            ctx.cov.refused(stepSnap.url, s.control, unsafe.risk);
          }
          if (s.submitsForm !== undefined) ctx.cov.blocked(stepSnap.url, s.submitsForm, unsafe.reason, "denied");
          ctx.transcript.record({
            op: null,
            control: s.control,
            confidence: null,
            chosenBy: "strategy",
            strategy: ran,
            actOk: false,
            reason: joinReasons([s.note, unsafe.reason]),
            snapshot: stepSnap,
            ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          });
          stepTiming = undefined;
          break;
        }
        // #150 — mission spend budget, pre-action: a paid control (#116) whose declared cost estimate
        // would cross what remains of the budget is refused BEFORE it fires — code decides, never a
        // model routing around it. The run stops cleanly, with `stop: "budget"`.
        if (ctx.budget !== null) {
          const risk = s.control === null ? null : ctx.safety.policy.riskOf(s.control);
          const g = await ctx.budget.guard(ctx.sessions.page, { op: s.op, control: s.control?.name ?? s.op, paid: risk === "paid" });
          if (g.refuse) {
            ctx.transcript.record({
              op: null,
              control: s.control,
              confidence: null,
              chosenBy: "strategy",
              strategy: ran,
              actOk: false,
              reason: joinReasons([s.note, g.reason]),
              snapshot: stepSnap,
              ...(stepTiming === undefined ? {} : { timing: stepTiming }),
            });
            stepTiming = undefined;
            ctx.stop = "budget";
            break;
          }
        }
        // #245: the demo overlay says what is about to happen and highlights the target (display only).
        // A step racing an unsettled earlier one (a double submit) gets the panel only — no highlight
        // pause, so the overlay never lets the earlier action settle and change what the misuse tests.
        if (overlay !== null) {
          await overlay.announce(
            ctx.sessions.page,
            { step: ctx.transcript.nextStep, strategy: `adversarial · ${ran}`, op: s.op, target: s.control === null ? null : s.control.name || s.control.summary, why: s.note },
            pendingEarlier ? null : s.control,
          );
        }
        // Declared invariants (#86): snapshot BEFORE the action(s) the next adjudication judges.
        const actedOn = ctx.sessions.page.url();
        if (ctx.declared !== null && !ctx.armed) {
          await ctx.declared.before(ctx.sessions.actor);
          ctx.armed = true;
        }
        // #303 (opt-in): the page right before a settled action (a racing, unsettled one gets none).
        ctx.deltaArmed = null;
        if (ctx.pageDeltas !== null && s.settle && !pendingEarlier) {
          const dl = await ctx.pageDeltas.on(ctx.sessions.page);
          const route = normalizeRoute(redactUrl(ctx.sessions.page.url()));
          await dl.perceived(route).catch(() => null);
          try {
            await dl.beforeAction(route, s.op, s.control);
            ctx.deltaArmed = dl;
          } catch {
            dl.discard();
          }
        }
        const at = ctx.now();
        const firedAt = Date.now();
        if (ctx.chainStart === null) ctx.chainStart = firedAt;
        const firedStep = ctx.transcript.nextStep;
        ctx.safety.mark(ctx.transcript.nextStep, s.op, s.control);
        const { result, value } = await ctx.execute(s, stepSnap.controls);
        ctx.actions += 1;
        if (ctx.deltaArmed !== null) {
          if (result.ok) ctx.deltaArmed.acted({ label: `${s.op} ${s.control?.name ?? ""}`.trim(), recordIndex: 0, step: ctx.transcript.nextStep, ...(value === undefined ? {} : { value }) });
          else {
            ctx.deltaArmed.discard();
            ctx.deltaArmed = null;
          }
        }
        // #301: an inert canary typed into a field is registered (token → field, page, payload).
        const token = result.ok ? canaryTokenOf(value) : null;
        if (token !== null && value !== undefined && s.control !== null) {
          ctx.submittedCanaries.set(token, { field: s.control.name || s.control.summary, submittedOn: redactUrl(actedOn), payload: canaryPayloadOf(value) });
          ctx.chainCanaries.add(token);
        }
        if (result.ok) {
          ctx.recordAction(s, value, at, result.submittedVia);
          ctx.markFired(firedAt, firedStep);
        }
        if (result.ok) ctx.cov.acted(stepSnap.url, s.control);
        // #155 — a submit click counts as submitted only when it actually sent a request (a write
        // or a navigation); one the browser blocked with native validation never reached the
        // server, so it is recorded `blocked` instead (with the browser's own message, when known).
        if (result.ok && s.submitsForm !== undefined) {
          if (submitRequestSent(monitorFor(ctx.sessions.page), at)) {
            ctx.cov.submitted(stepSnap.url, s.submitsForm);
          } else {
            ctx.cov.blocked(stepSnap.url, s.submitsForm, await nativeValidationMessage(ctx.sessions.page));
          }
        }
        if (ran === "visit-route" && s.control !== null) ctx.visitedLinks.add(s.control.name);
        // #161 (a regression of #75): a control refused as not-actionable (occluded, detached, a
        // clipped/offscreen anchor the static `isExercisable` check missed) is never re-chosen by
        // any strategy for the rest of the run — and never blindly repeated by `repeat-rapid`.
        // Only when the step acted on the state it was planned on (#193): a control an earlier,
        // unsettled step of THIS episode just removed (a second Save after the first one closed
        // its dialog) is not unactionable — it is simply gone, and the form stays plannable.
        if (!result.ok && s.control !== null && !pendingEarlier && isUnactionableFailure(result.reason)) {
          ctx.unactionable.add(controlIdentity(s.control));
        }
        ctx.last =
          !result.ok && s.control !== null && ctx.unactionable.has(controlIdentity(s.control))
            ? null
            : { op: s.op, control: s.control, ...(value === undefined ? {} : { fillText: value }) };
        // Evidence for "act while the submit is pending": how many requests the action left in flight.
        const inFlight = !s.settle && result.ok ? monitorFor(ctx.sessions.page).pending().length : 0;
        const reason = joinReasons([
          s.note,
          result.ok ? result.note : result.reason,
          inFlight > 0 ? `${inFlight} request(s) in flight` : undefined,
        ]);
        const entry = {
          op: s.op,
          control: s.control,
          confidence: null,
          chosenBy: "strategy" as const,
          strategy: ran,
          actOk: result.ok,
          snapshot: stepSnap,
          ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          ...(s.redacted === true ? { redacted: true } : {}),
        };
        stepTiming = undefined;
        const step = ctx.transcript.nextStep;
        if (!s.settle) {
          // The next step fires at once, without waiting for this one to settle (that is the misuse).
          ctx.transcript.record({ ...entry, ...(reason === undefined ? {} : { reason }) });
          pendingEarlier = pendingEarlier || result.ok;
          continue;
        }
        // #303 (opt-in): what this settled action changed — on its transcript step, and kept as
        // evidence for a defect first seen at this step.
        if (ctx.deltaArmed !== null) {
          const dl = ctx.deltaArmed;
          ctx.deltaArmed = null;
          await monitorFor(ctx.sessions.page).waitSettled({ ceilingMs: 5_000 }).catch(() => undefined);
          const d = await dl.perceived(normalizeRoute(redactUrl(ctx.sessions.page.url()))).catch(() => null);
          if (d !== null) {
            ctx.stepDeltas.set(step, d.delta);
            ctx.transcript.attachDelta(step, d.delta);
          }
        }
        // #300: did this action switch the signed-in identity? Then its invariants are not judged,
        // the control is never picked again, and the run goes back to the original identity.
        const since = ctx.chainStart ?? firedAt;
        ctx.chainStart = null;
        const switched =
          ctx.baseline === null
            ? null
            : identityChange(ctx.baseline, await readIdentity(ctx.sessions.page), { authRequest: ctx.authRequests.since(since) });
        if (switched !== null) {
          ctx.chainCanaries.clear();
          const switchVerdict = await ctx.adjudicate(null, { identitySwitched: true });
          const landed = redactUrl(ctx.sessions.page.url());
          const actionName = s.control?.name ?? s.op;
          ctx.transcript.record({
            ...entry,
            reason:
              joinReasons([
                reason,
                `identity changed (${switched}): invariants not judged; "${actionName}" is not picked again`,
                switchVerdict?.reason,
              ]) ?? "identity changed",
          });
          if (switchVerdict !== null) {
            await ctx.fold(step, switchVerdict.findings);
            ctx.foldAdvisories(step, switchVerdict.advisories);
          }
          if (s.control !== null) {
            ctx.refusedIds.add(controlIdentity(s.control));
            ctx.identitySwitchers.add(controlIdentity(s.control));
          }
          ctx.last = null;
          const back = await ctx.restoreIdentity();
          ctx.identityChanges.push({ step, action: actionName, url: landed, route: normalizeRoute(landed), reason: switched, restored: back.ok });
          ctx.transcript.record({
            op: null,
            control: null,
            confidence: null,
            chosenBy: "strategy",
            strategy: "identity-reset",
            actOk: back.ok,
            reason: back.ok
              ? "restored the original identity: reset to the start URL in a fresh session from the original storage state"
              : back.why,
            snapshot: back.ok ? back.snapshot : ctx.snap,
            ...(back.ok ? { timing: back.timing } : {}),
          });
          if (!back.ok) {
            ctx.stop = back.stop;
            if (back.stop === "identity-changed") ctx.stopFailure = { kind: "identity-changed", message: back.why };
            break;
          }
          ctx.snap = back.snapshot;
          ctx.snapTiming = undefined;
          break;
        }
        const verdict = await ctx.adjudicate({ op: s.op, control: s.control?.name ?? null, url: actedOn, step });
        const soft = verdict === null ? await ctx.softJudgment(stepSnap) : {};
        const full = verdict === null ? joinReasons([reason, soft.note]) : joinReasons([reason, verdict.reason]);
        ctx.transcript.record({
          ...entry,
          ...(full === undefined ? {} : { reason: full }),
          ...(soft.judgments === undefined ? {} : { judgments: soft.judgments }),
        });
        if (verdict !== null) {
          await ctx.fold(step, verdict.findings);
          ctx.foldAdvisories(step, verdict.advisories);
        }
        // #301: was a submitted canary rendered as markup (after submit, after reload)?
        const canaryCheck = await ctx.checkCanaries();
        const after = await ctx.observeAfter(step, s.control?.name ?? s.op);
        if (after.kind === "stop") {
          ctx.stop = after.stop;
          break;
        }
        // The rest of the episode was planned for a page that is gone.
        if (after.kind === "reset") break;
        if (canaryCheck === "reloaded") {
          // The canary check loaded the page again: the rest of the episode's plan is stale.
          ctx.observeTarget(ctx.snap);
          break;
        }
        ctx.observeTarget(ctx.snap);
        // #193: what did this click reveal? A form that was not there before → remember the control
        // as the way back to it (and, for a disclosure, run this strategy's episode on it now); a
        // disclosure that showed no form is never re-opened "to look for a form".
        if (result.ok && s.op === "click" && s.control !== null) {
          const id = controlIdentity(s.control);
          const before = new Set(detectForms(stepSnap.controls, ctx.inScope).map((f) => f.key));
          const appeared = detectForms(ctx.snap.controls, ctx.inScope)
            .map((f) => f.key)
            .filter((k) => !before.has(k));
          if (appeared.length > 0) {
            ctx.revealed.set(id, appeared);
            ctx.barren.delete(id);
            if (s.discloses === true && ran !== "exercise-controls" && FORM_STRATEGY.has(ran)) {
              // Same round as the disclosure's own turn (its counter was already advanced).
              const follow = planMisuseEpisode(planning(ctx.snap, ran, { disclose: false, round: (ctx.rounds.get(ran) ?? 1) - 1 }));
              if (follow !== null) queue.push(...follow.steps);
            }
          } else if (s.discloses === true && !ctx.revealed.has(id)) {
            ctx.barren.add(id);
          }
        }
        refreshed = true;
        pendingEarlier = false;
        // #150 — post-settle: a crossed budget stops the mission cleanly, before its next action.
        if (ctx.budget !== null) {
          const b = await ctx.budget.afterSettle(ctx.sessions.page, step);
          if (b.crossed) {
            ctx.transcript.record({
              op: null,
              control: null,
              confidence: null,
              chosenBy: "strategy",
              strategy: "budget",
              actOk: true,
              reason: b.reason ?? "mission budget crossed",
              snapshot: ctx.snap,
            });
            ctx.stop = "budget";
            break;
          }
        }
        stepSnap = ctx.snap;
        stepTiming = ctx.snapTiming;
        ctx.snapTiming = undefined;
      }
    }

    // Anything that arrived after the last adjudication still counts.
    await ctx.drainLate(Math.max(1, ctx.transcript.nextStep - 1));
    // #195: the monitor's end-of-run flush — a never.response hit to the LAST step is never lost.
    if (ctx.declared !== null) {
      const late = await ctx.declared.flushResponses().catch(() => null);
      if (late !== null && late.violations.length > 0) await ctx.fold(Math.max(1, ctx.transcript.nextStep - 1), late.violations.map(ctx.declaredFinding));
    }
    if (ctx.stop === "identity-changed") return ctx.finish(ctx.budgetVerdict(), ctx.stop, ctx.defects.size > 0 ? undefined : ctx.stopFailure);
    return ctx.finish(ctx.stop === "budget" ? ctx.budgetVerdict() : ctx.verdict(), ctx.stop);
  } catch (e) {
    const failure = describeFailure(e, ctx.crashWatch.signals());
    // #226: the app stopped answering (a frozen backend) — the run proves nothing past that point,
    // but nothing in the engine broke: `inconclusive` with the typed reason, never `crashed`.
    if (isTargetUnresponsive(failure)) return ctx.finish("inconclusive", "target-unresponsive", failure);
    // #296: the page's renderer stopped answering and the liveness watchdog closed it — the run ends
    // `inconclusive` with that typed reason, never `crashed` with an issue attributed to jevitate.
    // #205: likewise a session the resource governor ended over the memory ceiling.
    if (isPageUnresponsive(failure)) return ctx.finish("inconclusive", failure.kind === "resource-limit" ? "resource-limit" : "stalled", failure);
    ctx.crashHost = await ctx.probeHost();
    return ctx.finish("crashed", "crashed", failure);
  } finally {
    await ctx.sessions.closeOwned();
  }
}

