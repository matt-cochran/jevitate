import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { type Bounds } from "../bounds.js";
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
import { describeFailure, isPageUnresponsive, isTargetUnresponsive, type Triage } from "../mission-failure.js";
import { type CrashReport } from "../crash-report.js";
import type { HeapSample } from "@jevitate/domain";
import { type DefectSignal } from "../adversarial/defect-oracle.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import {
  type AdversarialCoverage,
  type CoverageThresholds,
} from "../adversarial/run-coverage.js";
import type { SafetyConfig } from "../safety.js";
import { type SideEffect } from "../side-effects.js";
import type { InvariantSpec } from "@jevitate/recording";
import {
  type InvariantReport,
  type InvariantViolation,
} from "../declared-invariants.js";
import { type BudgetTrajectory } from "../budget.js";
import { demoOverlayFor, type DemoOverlay } from "../demo-overlay.js";
import { startHunt } from "./adversarial-hunt/start.js";
import { createHuntContext, type HuntState } from "./adversarial-hunt/context.js";
import { loadSeed } from "./adversarial-hunt/seed.js";
import { runEpisode } from "./adversarial-hunt/episode.js";
import { planTurn } from "./adversarial-hunt/turn.js";
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
    const early = await loadSeed(ctx, params);
    if (early !== null) return early;

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
      const turn = await planTurn(ctx, params);
      if (turn === "stop") break;
      if (turn === "continue") continue;

      await runEpisode(ctx, overlay, turn);
    }

    // Anything that arrived after the last adjudication still counts.
    await ctx.drainLate(Math.max(1, ctx.transcript.nextStep - 1));
    // #195: the monitor's end-of-run flush — a never.response hit to the LAST step is never lost.
    if (ctx.declared !== null) {
      const late = await ctx.declared.flushResponses().catch(() => null);
      if (late !== null && late.violations.length > 0) await ctx.fold(Math.max(1, ctx.transcript.nextStep - 1), late.violations.map(ctx.declaredFinding));
    }
    if (ctx.stop === "identity-changed") return ctx.finish(ctx.budgetVerdict(), ctx.stop, ctx.defects.size > 0 ? undefined : ctx.stopFailure);
    // Non-null here: every way out of the loop above set it (a turn that returns "stop" set it too).
    return ctx.finish(ctx.stop === "budget" ? ctx.budgetVerdict() : ctx.verdict(), ctx.stop!);
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

