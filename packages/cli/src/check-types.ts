import type { ApprovalChannel } from "@jevitate/journey";
// check-types.ts — `jevitate check` option, result and error types (#231).
import { type GenerationPort, type JudgmentPort, type UsageAggregate, type UsageTracker } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import type { BrowserRunOptions } from "./browser-run-options.js";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { JourneyHealRequest } from "./journey-heal.js";
import type { GitExec } from "./change-context.js";
import { type ConsolidatedDefect, type DiffEntry, type FindingIdentity, type FindingsDiff } from "@jevitate/findings";
import { runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { runUsabilityMission } from "./ux-api.js";
import { runVerifyFix } from "./verify-fix-api.js";
import { type TargetConfig } from "./target-config.js";
import { type EngineInfo } from "./engine.js";
import type { CheckSuite, SuiteBudget } from "./check-suite.js";
import { type RunSummary } from "./report-api.js";
import type { PrReviewCheckDeps } from "./approval-provenance.js";

/**
 * `jevitate check --suite <file>` (#137): jevitate as a CI regression gate. Runs every suite item
 * — promoted Journeys, goals, missions, verify-fix replays — SEQUENTIALLY through the existing
 * runners, inside one total action / wall-clock / USD budget, then decides pass/fail from the
 * shared finding identity (`@jevitate/findings`):
 *
 *  - HARD findings fail the gate: a Journey assertion failed, an invariant was violated, a goal
 *    success check failed, a verify-fix still reproduces (or is intermittent), a hard-signal
 *    defect or a hang. Advisory findings (UX, 4xx-correlated console errors, Jev flags) never do,
 *    unless the suite sets `gateAdvisory`.
 *  - With `--baseline`, only findings NOT seen in the baseline gate ("new", including a new flaky
 *    one); findings already in the baseline are tracked, not gated.
 *  - Fail closed: an item that could not prove anything (crashed, inconclusive, refused) and any
 *    budget overrun fail the gate; nothing that did not run is ever reported as passing.
 *
 * Everything is validated before the first browser opens (suite, invariant files and their probe
 * origins, success specs, Journeys and their origins, verify-fix inputs, the model gateway). Every
 * result is stamped with the engine identity and the caller's `--target-build`.
 */

export class CheckPreflightError extends Error {
  readonly code = "E_CHECK_SUITE" as const;
  constructor(message: string) {
    super(message);
    this.name = "CheckPreflightError";
  }
}

/** `check --self-heal` arguments that are unusable (exit 64): a heal without a change context, a change/budget flag without a heal. */
export class CheckArgsError extends Error {
  readonly code = "E_CHECK_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "CheckArgsError";
  }
}

/** The suite needs a model gateway and none was selected (fail closed, before anything runs). */
export class CheckAiSetupError extends Error {
  readonly code = "E_AI_SETUP_REQUIRED" as const;
  constructor(message: string) {
    super(message);
    this.name = "CheckAiSetupError";
  }
}

export interface CheckGateways {
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly usage: UsageTracker;
}

/** The runners (real by default; tests inject fakes). */
export interface CheckRunners {
  readonly journey: (o: RunJourneyProgrammaticallyOptions) => Promise<JourneyRunResult>;
  readonly goal: typeof runExploration;
  readonly coverage: typeof runCoverageMission;
  readonly adversarial: typeof runAdversarialCliMission;
  readonly feature: typeof runFeatureCliMission;
  readonly usability: typeof runUsabilityMission;
  readonly verifyFix: typeof runVerifyFix;
}

export interface RunCheckOptions {
  readonly suite: CheckSuite;
  /** Where results, JUnit, SARIF, the report and the check record go. */
  readonly outDir: string;
  /** The caller's target build/commit id, stamped on every result. */
  readonly targetBuild?: string;
  /** `--baseline <run|tag|last>`: only findings not in it gate. */
  readonly baseline?: string;
  /** Dirs searched for run ids and `last` (default: this check's results dir). */
  readonly baselineDirs?: readonly string[];
  readonly baselinesDir?: string;
  /** `--changed-routes`: only Journeys and goals touching these route globs run. */
  readonly changedRoutes?: readonly string[];
  readonly junitPath?: string;
  readonly sarifPath?: string;
  readonly jsonPath?: string;
  /** Default Journeys dir (`~/.jevitate/journeys`) for targets that name none. */
  readonly journeysDir: string;
  /** The site-policy database (`jevitate site policy set`): Journey items are paced, throttled and budgeted per origin. */
  readonly sitePolicyDbPath?: string;
  /**
   * Builds the model gateways — called only when an item needs one. Throws when no gateway is
   * selected (fail closed, before anything runs).
   */
  readonly gateways?: () => Promise<CheckGateways>;
  /** The selected gateway kind: `fake` gateways cost nothing (USD 0), so `maxUsd` is measurable. */
  readonly aiMode?: "real" | "fake";
  /** Per-origin settle/hang configuration (`~/.jevitate/targets.json`). */
  readonly targetsConfig?: Readonly<Record<string, TargetConfig>>;
  /** #247: the environments file a Journey item's `env` names (default: the repo's `.jevitate/environments.json`). */
  readonly environmentsFile?: string;
  /** Where a target's `secretFields` read their values (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly browserPortFactory?: () => BrowserPort;
  readonly browser?: BrowserRunOptions;
  readonly runners?: Partial<CheckRunners>;
  /**
   * #453 `--self-heal hybrid|full`: a Journey item that quarantines is re-run ONCE with a change-aware
   * self-heal (the change scope is read once at preflight; the re-run is charged to the check budget).
   * Needs `--changes` and/or `--change-note`, and a gateway (`--real`/`--fake-ai`). Absent: fail closed.
   */
  readonly selfHeal?: JourneyHealRequest;
  /** Test seam: the read-only git the change scope is read through. */
  readonly changeGitExec?: GitExec;
  /** Clock seams. */
  readonly now?: () => number;
  readonly nowIso?: () => string;
  /** The suite file as the caller named it (SARIF's physical location). Default: its absolute path. */
  readonly suiteUri?: string;
  /**
   * #437 `--require-approvals`: every promoted Journey (in the default and each target's journeys
   * dir) and every approved persona/job (in `catalogDir`) needs a current approval made over one of
   * `allowedChannels` — else a gating `approval` finding (exit 1, JUnit + SARIF like any other).
   */
  readonly requireApprovals?: { readonly allowedChannels: readonly ApprovalChannel[]; readonly catalogDir: string | null };
  /**
   * #469 seam: how `--require-approvals` re-verifies a recorded `pr-review` approval — the forge
   * (default: the real GitHub ForgePort), the CI environment (default `process.env`) and the git
   * tracking probe for the positive-verification cache. Tests pass a fake forge.
   */
  readonly approvalVerification?: Pick<PrReviewCheckDeps, "env" | "forge" | "gitTracked">;
  /**
   * #470 `--max-brittle-steps <n>`: the opt-in locator gate — a Journey item with more than n brittle
   * steps is a gating `locator-health` finding (exit 1). Absent: locator health is advisory only.
   */
  readonly maxBrittleSteps?: number;
  /**
   * #470: the project data dir whose config holds `testIdAttributes` (default: the project found from
   * the cwd; null: none, the defaults apply).
   */
  readonly projectDir?: string | null;
}

export type ItemKind = "journey" | "goal" | "mission" | "verify-fix";

export interface CheckItemReport {
  readonly target: string;
  /** #437: `approvals` — the `--require-approvals` item (target `approvals`, one per check). */
  readonly kind: ItemKind | "approvals";
  readonly name: string;
  readonly strategy?: string;
  /** `ran`: a result exists; `error`: the item could not prove anything; `skipped`: not affected by `--changed-routes`. */
  readonly status: "ran" | "error" | "skipped";
  readonly error?: { readonly type: string; readonly message: string };
  readonly resultPath?: string;
  readonly runId?: string;
  readonly outcome?: string;
  /** #217: a goal item's own ending (succeeded/failed/exhausted/blocked/…); `outcome` is its canonical verdict. */
  readonly goalOutcome?: string;
  readonly actions: number;
  readonly durationMs: number;
  /** JUnit verdict after gating. `pending-review` (#453): a self-heal proposed a Journey revision a person must review. */
  readonly verdict: "passed" | "failed" | "error" | "skipped" | "pending-review";
  /** #453: the proposed revision a `pending-review` Journey item produced (absent fields: the run did not name them). */
  readonly proposal?: { readonly journeyId: string; readonly proposalId?: string; readonly path?: string };
  /** #453: heal attempts made on a Journey item that was re-run with self-heal. */
  readonly healAttempts?: number;
  /** Keys of the gating findings this item's run observed. */
  readonly gating: readonly string[];
  /** #469: the Journey review hash (`journeyReviewHash`) a Journey item replayed — what its `baseline` is about. */
  readonly journeyHash?: string;
  /** #469: the machine baseline of a Journey item — present only when its run was clean. */
  readonly baseline?: CheckBaseline;
  /** #470: how stable a Journey item's locators are (advisory; gates only past `maxBrittleSteps`). */
  readonly locatorHealth?: LocatorHealth;
}

/**
 * #469 (contract §4.3): the machine baseline from ONE clean Journey run — the steps it took, the
 * total time, and when each anchor was reached. `atMs` is milliseconds from the first step's start
 * to the anchor's step completing. Keyed by anchor name (the bundle's `baseline.anchors[].anchor`).
 */
export interface CheckBaseline {
  /** Steps the replay took. */
  readonly steps: number;
  /** Milliseconds from the first step's start to the last step's completion. */
  readonly totalMs: number;
  readonly anchors: readonly CheckBaselineAnchor[];
}

/** #469: one anchor of a `CheckBaseline`. */
export interface CheckBaselineAnchor {
  /** The anchor's name (or the reserved `job_start` / `job_end`). */
  readonly name: string;
  /** The 1-based step the anchor follows, when known. */
  readonly step?: number;
  /** The anchor step's stable id (`RecordedStep.stepId`), when it has one. */
  readonly stepId?: string;
  /** Milliseconds from the first step's start to the anchor's step completing. */
  readonly atMs: number;
}

/**
 * #470: the selector-ladder rung a recorded step's target resolves by. `anchor` is a recorded
 * stable `id`/`name` attribute; `role+name` a role with an accessible name. A `data-tflow-id` is
 * never a rung (#468).
 */
export type LocatorRung = "testId" | "anchor" | "role+name" | "role" | "label" | "text" | "css";

/** #470: `stable` meets the team's locator convention; `brittle` does not. */
export type LocatorStability = "stable" | "brittle";

/** #470: one step's locator verdict. */
export interface LocatorHealthStep {
  readonly stepId?: string;
  /** The flat 0-based step index in the Journey. */
  readonly index: number;
  readonly rung: LocatorRung;
  readonly stability: LocatorStability;
  /** Why it is brittle (`no test id`, `css selector`, `ordinal among 3`, …); empty when stable. */
  readonly reasons: readonly string[];
}

/** #470: a Journey's locator health — counts and the per-step verdicts (steps with a target only). */
export interface LocatorHealth {
  readonly stable: number;
  readonly brittle: number;
  readonly steps: readonly LocatorHealthStep[];
}

/** #470: locator health over every Journey item of a check, and the opt-in gate's verdict. */
export interface LocatorHealthSummary {
  /** Journey items that reported locator health. */
  readonly journeys: number;
  readonly stable: number;
  readonly brittle: number;
  /** The test-id attributes counted as the convention (default `data-testid`, `data-test`). */
  readonly testIdAttributes?: readonly string[];
  /** The opt-in threshold (`--max-brittle-steps N`); absent = advisory only. */
  readonly maxBrittleSteps?: number;
  /** True when `maxBrittleSteps` was set and a Journey item exceeded it. */
  readonly exceeded?: boolean;
  /** e.g. `7/9 steps on stable locators; 2 brittle (high 7 · medium 1 · low 1)`. */
  readonly line?: string;
  /** With `--baseline`: the steps improved / regressed against the baseline's Journey runs. */
  readonly trend?: {
    readonly improved: number;
    readonly regressed: number;
    readonly unchanged: number;
    readonly added: number;
    readonly removed: number;
    readonly brittleDelta: number;
    /** `trend vs baseline: 2 improved, 1 regressed (brittle -1)`. */
    readonly line: string;
  };
}

export interface BudgetReport {
  readonly limits: SuiteBudget;
  readonly used: { readonly actions: number; readonly minutes: number; readonly usd?: number };
  /** Why the budget was exceeded (fail closed), or absent. */
  readonly exceeded?: string;
}

export interface CheckFinding {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly severity: string;
  readonly identity: FindingIdentity;
  readonly gating: boolean;
  readonly status?: DiffEntry["status"];
  readonly modes: ConsolidatedDefect["modes"];
  readonly reproduce?: string;
}

export interface CheckResult {
  readonly kind: "jevitate-check";
  readonly suite: string;
  readonly suitePath: string;
  readonly verdict: "pass" | "fail" | "pending-review";
  /**
   * 0 pass · 1 a gating finding · 2 no gating finding, but an item errored or the budget was exceeded ·
   * 5 (#453) nothing failed but a self-heal proposed a Journey revision awaiting review. Precedence 1 > 2 > 5 > 0.
   */
  readonly exitCode: 0 | 1 | 2 | 5;
  readonly engine: EngineInfo;
  readonly targetBuild?: string;
  readonly startedAt: string;
  readonly budget: BudgetReport;
  /**
   * Model usage summed over every item that ran (#163): calls, tokens, `jevUsd` + `generationUsd` =
   * `totalUsd`, and `priced` (a `partial` total fails a `maxUsd` budget closed). Absent when no item
   * needed a model gateway.
   */
  readonly usage?: UsageAggregate;
  readonly items: readonly CheckItemReport[];
  readonly findings: readonly CheckFinding[];
  readonly summary: {
    readonly items: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly skipped: number;
    readonly gatingFindings: number;
    /** #453: Journey items whose self-heal proposed a revision awaiting review. */
    readonly pendingReview: number;
  };
  /** #470: locator health over the check's Journey items (advisory unless `maxBrittleSteps` is set). */
  readonly locatorHealth?: LocatorHealthSummary;
  /** #453: the proposed Journey revisions awaiting review (`jevitate journey review <journeyId>`). */
  readonly proposals: ReadonlyArray<{ readonly journeyId: string; readonly proposalId?: string; readonly path?: string }>;
  readonly diff?: { readonly baseline: readonly RunSummary[]; readonly summary: FindingsDiff["summary"] };
  /** Every result file this check wrote (what `report`/`diff`/`baseline tag` read back). */
  readonly results: readonly string[];
  readonly junitPath: string;
  readonly sarifPath: string;
  readonly jsonPath: string;
  readonly reportPath: string;
}
