// ux-usability.ts — the live usability mission runner (`explore --strategy usability`) (#231).
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import type { BrowserPort, EmulationSpec } from "@jevitate/playwright";
import type { BrowserRunOptions } from "./browser-run-options.js";
import type { ScreenshotsSpec } from "./run-screenshots.js";
import type { InvariantSpec } from "@jevitate/recording";
import type { SuccessCheck, SuccessCheckResult, SuccessWhen, Bounds, TimingSummary, RunAnswer, RunOutcome, SecretField, SecretCommandRunner, HangFinding, SideEffect, SafetyOverride, BudgetTrajectory, CrashReport } from "@jevitate/explore";
import type { AppContext, SignalOptions, UxReport } from "@jevitate/ux";
import type { ConversationOptions } from "./conversation-options.js";
import type { GoalOutcome, MissionFailure, MissionOutcome } from "@jevitate/domain";
import { MISSION_RESULT_SCHEMA_VERSION, type AdvisoryServerLogDefect } from "./result-schema.js";
import type { JourneyPrefix } from "./journey-prefix.js";
import type { JourneyBranchPoint } from "@jevitate/journey";
import type { ActionDeltaStats, HostHealthSampler, Http5xxDefect, RunDepth } from "@jevitate/explore";
import type { DefectOutcome, EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import type { EngineInfo } from "./engine.js";
import type { ServerLogsSummary } from "./log-correlation.js";
import type { MissionTarget, ServerLogOptions } from "./explore-api.js";
import type { TargetConfig } from "./target-config.js";
import { UsabilityInvariantsUnsupportedError, setUpUsabilityMission } from "./ux-usability/setup.js";
import { runUsabilityLoop } from "./ux-usability/loop.js";
import { analyzeUsabilityRun } from "./ux-usability/analysis.js";
import { reproduceUsabilityHang } from "./ux-usability/hang.js";
import { adjudicateUsabilityJob } from "./ux-usability/done-adjudication.js";
import { writeUsabilityResult } from "./ux-usability/result.js";
import { tearDownUsabilityMission } from "./ux-usability/teardown.js";

export { UsabilityInvariantsUnsupportedError };

// ---------- Live: `explore --strategy usability` ----------

export interface RunUsabilityMissionOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly url: string;
  readonly job: string;
  readonly allowlist: readonly string[];
  readonly appContext: AppContext;
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  /** Usage accounting (#100): see `RunUxReviewOptions.usage`. */
  readonly usage?: UsageTracker;
  /** Report cutoff (see `RunUxReviewOptions.minConfidence`). */
  readonly minConfidence?: number | string;
  /**
   * Quality grades to show, e.g. "actionable,relevant-minor". Precedence: this (CLI `--show`) >
   * `JEVITATE_UX_SHOW` > config `ux.show` > every grade (#133: the uncalibrated grader labels, it does not filter).
   */
  readonly show?: string;
  /** Cap on findings per route (see `RunUxReviewOptions.maxFindingsPerRoute`). */
  readonly maxFindingsPerRoute?: number | string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Path of the config file holding `ux.minConfidence`. Default `~/.jevitate/config.json`. */
  readonly configPath?: string;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /**
   * Secret field bindings (`--secret-field` / `--totp`, #72): typed by code, never by the model;
   * masked in every screenshot and redacted from the transcript, Recording and report.
   */
  readonly secretFields?: readonly SecretField[];
  /** #324: runs a `cmd:` secret field's command at type time (CLI `--allow-secret-cmd`). */
  readonly secretCommand?: SecretCommandRunner;
  /** #359: `--secret-cmd-attempts`: runs of one `cmd:` binding's command per run (default 3). */
  readonly secretCommandAttempts?: number;
  /** Tuning of the run-signal oracles (#96), e.g. the hung-request floor. Defaults suit real apps. */
  readonly signals?: SignalOptions;
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  /** Conversational pages: the reply wait (ms) and the cap (chars) on each generated message. */
  readonly conversation?: ConversationOptions;
  readonly outDir?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args) and shown (#245 demo mode). Default: pinned Chromium, headless. */
  readonly browser?: BrowserRunOptions;
  /** #251 `--screenshots`: masked screenshots (one per distinct screen, or per step) + `index.md`. */
  readonly screenshots?: ScreenshotsSpec;
  /**
   * #250 `--evidence-video`: after the result is written, each defect's minimal repro is replayed
   * with captions (the failing step marked) into a masked clip + before/at screenshots, attached as
   * `defects[].evidence` (and to its issue draft).
   */
  readonly evidenceVideo?: boolean;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  readonly emulation?: EmulationSpec;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) — the
   * deterministic authenticated pre-step. Holds live session cookies: handed only to the
   * browser, never to a model or a finding.
   */
  readonly storageState?: string;
  /**
   * Writes the browser context's storageState here when the run ends (CLI `--save-storage-state`) —
   * see `RunExplorationOptions.saveStorageState`'s doc for the full behaviour (written on every exit
   * path including a crash/kill signal, never over a lost/logged-out session, mode 0600).
   */
  readonly saveStorageState?: string;
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /** Test seam: extract a page's visible text. Default reads the live page. */
  readonly extractText?: (session: { page: { evaluate: (fn: () => string) => Promise<string> } }) => Promise<string>;
  /**
   * Backend log sources (`--log-source`/`--log-defect`, #142), already validated. Lines attach to
   * usability steps the same way as every other strategy; a `server-log` defect is reported in the
   * result but — like every UX finding — never gates `missionOutcome`/`exitCode` (advisory-only).
   */
  readonly serverLog?: ServerLogOptions;
  /**
   * Horizontal-overflow hard signal (#149, CLI `--check-overflow` / `--ignore-overflow`): checked
   * on every observed screen and, when it fires, reported as a `tier: "signal"` UxFinding — pure
   * DOM geometry (`detectOverflow`), never a model judgment. Runs by default only when the emulated
   * viewport is narrower than 1024px, or always when `checkOverflow` is set.
   */
  readonly overflow?: {
    readonly checkOverflow?: boolean;
    readonly toleranceCss?: number;
    /** `--ignore-overflow <selector>` (repeatable): intentional overflow, never a finding. */
    readonly ignoreSelectors?: readonly string[];
  };
  /**
   * `--invariants` (#150 only): usability does not check app-declared invariants (#86) or captures
   * (#147) today — a spec carrying either is refused. Only its `budget` (over its `observe` map) is
   * read: a pre-action guard and a post-settle check, the same as every other mission.
   */
  readonly invariants?: InvariantSpec;
  /** Resolved `authFrom.secret` refs (#135) a declared budget's probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * #225: independent completion checks on the job (CLI `--success`, a suite mission's `success`) —
   * the SAME semantics as a goal run's: every one must hold (grounding the model's `done` mid-run and
   * judged again on the final page), a vacuous one (#202) fails unless `allowVacuousChecks`, and the
   * verdict folds exactly like a goal run's (`goalOutcome` → `missionOutcome`). Never ignored: with
   * checks, the job's completion is theirs to decide, not the advisory goal judgment's.
   */
  readonly successChecks?: readonly SuccessCheck[];
  /** When the page checks must hold (`--success-when`): `final` (default) | `held`. */
  readonly successWhen?: SuccessWhen;
  /** #202 `--allow-vacuous-checks`: a check satisfied before the first action warns instead of failing. */
  readonly allowVacuousChecks?: boolean;
  /**
   * #198 `--product <file>`: the product facts (plans/prices, key journeys, each page's intended next
   * step). Default: `.jevitate/product.json` in the project, when present. Validated before a browser
   * opens (`ProductFactsError`, E_UX_PRODUCT_INPUT).
   */
  readonly product?: string;
  /** #198 `--polish`: polish each verified finding's recommendation with one generation call (opt-in). */
  readonly polish?: boolean;
  /**
   * #198 `--probe-guards` (opt-in): click each destructive control once, fail-safe (every write and
   * destructive-looking request aborted; refused on a page with an open WebSocket/EventSource or a
   * controlling service worker), to verify whether a confirmation guards it. Off: nothing is clicked,
   * and those guard claims are reported unverifiable.
   */
  readonly probeGuards?: boolean;
  /**
   * #293 `--from-journey`/`--at-step`: replayed into the session before the review, which then starts
   * on the live page it left — never a fresh navigation. `url` is only the expected landing.
   */
  readonly journeyPrefix?: JourneyPrefix;
  /**
   * #303 `--action-deltas` (opt-in, off by default): record what each action changed on the page
   * (code's verdict per action) — attached to every transcript and Recording step, summarised in the
   * result (`actionDeltas`), told to the model and used by the no-progress check. Off: no capture.
   */
  readonly actionDeltas?: boolean;
}


export interface RunUsabilityMissionResult {
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
  /** #293: the Journey step a journey-anchored review branched from (absent on a bare-URL run). */
  readonly branch?: JourneyBranchPoint;
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "usability";
  /** Where the review ran (#195: every strategy states its scope the same way) — a session PATH at most. */
  readonly target: MissionTarget;
  /**
   * EVERY defect the review found (#195) — HTTP 5xx hard-signal defects (#208) and `server-log`
   * defects (#142), each marked `advisory: true`: reported like every other strategy's, never gating
   * a UX review's outcome.
   */
  readonly defects: Array<AdvisoryServerLogDefect | (Http5xxDefect & { readonly advisory: true })>;
  /** #421/#423: the gating defects counted per kind (`defectOutcomeOf(defects)`). */
  readonly defectOutcome: DefectOutcome;
  /** Hang findings (0 or 1: the review stops at a hang), as every strategy lists them (#195). */
  readonly hangs: HangFinding[];
  /** Every Recording the review wrote (#195: one list on every strategy) — a review writes one. */
  readonly recordingPaths: string[];
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
  /** The UX report; `null` when the analysis was unavailable (see `analysisUnavailable`). */
  readonly report: UxReport | null;
  readonly reportPath: string | null;
  readonly stop: string;
  /**
   * Did the review's journey complete (`completed`: the job's success condition was observably met),
   * or why not (`incomplete` + reason)? Never a silent early stop.
   */
  readonly outcome: RunOutcome;
  /** A find-out job's answer (#101), present only when code grounded it on the observed pages. */
  readonly answer?: RunAnswer;
  readonly screensObserved: number;
  /** The explore loop's decision transcript, written next to the report (each step: its screenshot). */
  readonly transcriptPath: string;
  /** Where the per-step screenshots are written (secret fields masked). */
  readonly screenshotDir: string;
  /**
   * #134: the evidence sidecar (`usability-<stamp>.evidence.json`) — every screen as the analyzer
   * saw it after redaction, plus the run-signal capture — so `jevitate ux <recording>` reproduces
   * this run's findings offline. `null` when it could not be written (redaction unavailable).
   */
  readonly evidencePath: string | null;
  /** Every per-step screenshot written, in order. */
  readonly screenshots: readonly string[];
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: readonly SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** #428: every --allow-control exemption the run used. */
  readonly safetyOverrides?: readonly SafetyOverride[];
  /** #303: the run's action deltas (verdict counts, per-action overhead) — only with `--action-deltas`. */
  readonly actionDeltas?: ActionDeltaStats;
  /**
   * The typed verdict. UX findings are advisory, so a completed review is `clean`; a run whose
   * loop broke is `crashed`/`inconclusive`, and so is one whose analysis could not be produced — or
   * (#209) one whose job was never completed (`failure.kind: "job-incomplete"`).
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly failure?: MissionFailure;
  /** For a `crashed` review: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Where the review ended (redacted), and how many decisions/actions it spent — as a goal run reports them. */
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  /** Why the analysis could not be produced (the run's evidence is still kept). */
  readonly analysisUnavailable?: string;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** The hang finding (with its reproduction k/N), present when the run stopped on a hang (#126); also in `hangs`. */
  readonly hang?: HangFinding;
  /** The persisted typed result (`usability-<stamp>.recording.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
  /**
   * #225 — present only when `successChecks` were given: the job's own ending as a goal run names it
   * (`succeeded` / `failed` / `exhausted` / `blocked` / …), folded onto `missionOutcome` the same way.
   */
  readonly goalOutcome?: GoalOutcome;
  /** #225: each success check's result, when `successChecks` were given. */
  readonly checks?: readonly SuccessCheckResult[];
  /** #225/#202: the success checks' warnings (a vacuous check, `held` notes), when there were any. */
  readonly checkWarnings?: readonly string[];
  /** #424: how deep the run went — distinct states and pages, actions, decisions, forms submitted. */
  readonly depth: RunDepth;
}

/**
 * Live usability mission. Guardrail #1 authorizes BEFORE opening a browser.
 * Reuses explore()'s loop (goal = the job) and, via the additive onSnapshot
 * hook, collects one screen's evidence per observation — then analyzes ONCE
 * after the run. A UX finding NEVER gates the loop (the hook's result is
 * ignored by explore). The temp profile dir is always removed.
 */
export async function runUsabilityMission(opts: RunUsabilityMissionOptions): Promise<RunUsabilityMissionResult> {
  const ctx = await setUpUsabilityMission(opts);
  try {
    const loop = await runUsabilityLoop(ctx);
    const analysis = await analyzeUsabilityRun(ctx, loop);
    const hang = await reproduceUsabilityHang(ctx, loop.run);
    const verdict = await adjudicateUsabilityJob(ctx, loop, hang);
    return await writeUsabilityResult(ctx, loop, analysis, hang, verdict);
  } finally {
    await tearDownUsabilityMission(ctx);
  }
}
