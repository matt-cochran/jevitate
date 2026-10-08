import type { ApprovalChannel } from "@jevitate/journey";
// check-types.ts — `jevitate check` option, result and error types (#231).
import { type GenerationPort, type JudgmentPort, type UsageAggregate, type UsageTracker } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import type { BrowserRunOptions } from "./browser-run-options.js";
import type { JourneyRunResult } from "@jevitate/runtime";
import { type ConsolidatedDefect, type DiffEntry, type FindingIdentity, type FindingsDiff } from "@jevitate/findings";
import { runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { runUsabilityMission } from "./ux-api.js";
import { runVerifyFix } from "./verify-fix-api.js";
import { type TargetConfig } from "./target-config.js";
import { type EngineInfo } from "./engine.js";
import type { CheckSuite, SuiteBudget } from "./check-suite.js";
import { type RunSummary } from "./report-api.js";

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
  /** JUnit verdict after gating. */
  readonly verdict: "passed" | "failed" | "error" | "skipped";
  /** Keys of the gating findings this item's run observed. */
  readonly gating: readonly string[];
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
  readonly verdict: "pass" | "fail";
  /** 0 pass · 1 a gating finding · 2 no gating finding, but an item errored or the budget was exceeded. */
  readonly exitCode: 0 | 1 | 2;
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
  };
  readonly diff?: { readonly baseline: readonly RunSummary[]; readonly summary: FindingsDiff["summary"] };
  /** Every result file this check wrote (what `report`/`diff`/`baseline tag` read back). */
  readonly results: readonly string[];
  readonly junitPath: string;
  readonly sarifPath: string;
  readonly jsonPath: string;
  readonly reportPath: string;
}
