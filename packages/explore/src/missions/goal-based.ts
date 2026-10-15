import type { Assertion, Recording } from "@jevitate/recording";
import { installFlashRecorder } from "@jevitate/interpreter";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import type { Page } from "playwright";
import type { MissionFailure } from "@jevitate/domain";
import { DEFAULT_ORACLE_SETTLE_MS } from "../outcome-checks.js";
import type { HttpCheckRefResolver, HttpProbe } from "../http-check.js";
import { monitorFor, type RequestCapture } from "../page-monitor.js";
import {
  type SuccessCheck,
  type SuccessCheckResult,
} from "../success-checks.js";
import { type ExploreConfig, type ExploreRun, type TranscriptEntry } from "../explore.js";
import { type HangFinding } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";
import type { InvariantSpec } from "@jevitate/recording";
import {
  InvariantDefectLog,
  finishDeclaredRun,
  InvariantMonitor,
  type ObserverSessions,
  recordingStepCount,
  type InvariantAction,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";
import { BudgetMonitor, type BudgetTrajectory } from "../budget.js";
import { type MinEffortRequest } from "../run-depth.js";

import { demoOverlayFor } from "../demo-overlay.js";
import { secretFieldSecrets } from "../secret-fields.js";
import { act } from "./goal-based/act.js";
import { adjudicate } from "./goal-based/adjudicate.js";
import type { DeclaredHooks } from "./goal-based/declared-hooks.js";
import { earlyVerdict } from "./goal-based/early-verdicts.js";
import { evaluateOracle } from "./goal-based/oracle.js";
import { report } from "./goal-based/report.js";
import { setupAdjudication } from "./goal-based/setup.js";

export * from "./goal-based/vacuous-message.js";

/**
 * The goal-based exploratory mission (P1's first mission).
 *
 * Runs the bounded exploration loop toward `goal`, then adjudicates success
 * with an INDEPENDENT oracle: user-supplied checks that must ALL hold (see
 * `success-checks.ts`) — a recording `Assertion` on the final page, evaluated
 * by the SAME assertion engine replay uses (`@jevitate/interpreter`'s
 * `checkAssertion`); the same after a reload (`reloadThen`, persistence); and
 * network checks over the requests the run made (`requestMade`,
 * `responseStatus`), which catch a save that shows "Saved" but sends nothing.
 * Jev's `done` is advisory only — it can propose the goal is met, but it never
 * certifies it (guardrail #4).
 *
 * When the page checks are judged (`successWhen`, #80): `final` (the default) — on the final page
 * only; `held` — on the final page OR together at any settled step of the run (a one-time secret, a
 * toast, a "saved" banner the run then dismissed). Under `held` the page checks are evaluated after
 * every settled step and the step they held at is reported. Network checks are capture-based over
 * the whole run either way; `reloadThen` is always judged on the final page (a mid-run reload would
 * throw away the state the run is building). Under `held` (#174) a page check counts only once it
 * went from NOT holding to holding — one that already held on the start page and never changed is
 * vacuous (failed, with a warning) — and once every check held (no `reloadThen` declared) the run
 * stops before its next action, verified by the success condition, never acting past a met goal.
 * `each` (#337) is `held` per check: every page check went from not holding to holding at SOME
 * settled step, each at its own and in any order (checks that live on different pages); the run
 * stops once all have.
 *
 * #202 generalises #174's rule to every check, under either `successWhen`: a check satisfied BEFORE
 * the run's first action cannot verify the goal. A page/reloadThen check that already held on the
 * seed page and was never seen not holding at a later settled step (an empty result container
 * rendered at once), and a network check matched only by requests sent before the run's first
 * action (page load, polling; a control op or a chosen reload is an action), are vacuous: they FAIL by default — named in `warnings` as
 * "check '<spec>' held at step 0, before any action — it cannot verify the goal" — and
 * `allowVacuousChecks` (`--allow-vacuous-checks`) downgrades them to that warning. Network checks
 * count only requests sent after the first action (no `since:` qualifier).
 *
 * Outcome:
 *  - `succeeded`  — the success assertion holds against the live final page.
 *  - `exhausted`  — the assertion did not hold and the loop hit a budget cap.
 *  - `failed`     — (#209) the model said `done` (or kept proposing it until code gave up on it),
 *                   but an independent success check did not hold: `failure.kind:
 *                   "success-check-failed"`, the failing check named in `reason`/`failure.message`.
 *  - `blocked`    — the assertion did not hold and the loop stopped otherwise
 *                   (the model gave up, no valid target, no-progress, …).
 *  - `inconclusive` (`failure.kind: "vacuous-check"`) — (#209) every failing check was vacuous
 *                   (#202): satisfied before the run's first action, it proves nothing either way.
 *  - `inconclusive` — the model decision stayed unavailable; the run proves nothing.
 *  - `crashed`    — the engine failed (browser/page crash, unexpected exception).
 *                   Never a pass: the assertion is not trusted on a broken run.
 *  - `hang` / `intermittent` — the app under test hung; its steps were replayed in fresh
 *                   browser contexts and it reproduced every time (`hang`) or not (`intermittent`).
 *  - `defects-found` — an app-declared invariant (#86) was violated around an action. A hard
 *                   defect: it overrides `succeeded`/`exhausted`/`blocked` (the goal may well have
 *                   been reached — the app still broke a rule getting there).
 *  - `inconclusive` (with `run.stop === "budget"`) — a declared mission spend budget (#150) was
 *                   crossed (or a paid action was refused before crossing it): the run stopped
 *                   cleanly, before its next action. Never `succeeded`, never `crashed` — a budget
 *                   stop is deliberate, not the engine breaking, but the run's own work is unproven
 *                   past that point. Reported with the observed trajectory (`budget`).
 *
 * Declared invariants are observed through the loop's existing hooks (no change to the loop): each
 * settled snapshot evaluates the action taken since the previous one and re-arms the next "before".
 *
 * The durable product is always the emitted `Recording`, whatever the outcome.
 */

export interface GoalBasedMissionConfig extends Omit<ExploreConfig, "missionContext" | "minEffort"> {
  /**
   * #424: the minimum exploration effort asked for (`--min-actions` / `--min-distinct-states`). Each
   * explicit value wins; without one, an open-ended find-out (no success check, `goalIsOpenEnded`) gets
   * the default. Capped by the budget (a warning names the cap). See `resolveMinEffort`.
   */
  readonly minEffort?: MinEffortRequest;
  /**
   * #293: how a retried run (#126) gets back to its start state instead of loading `startUrl` — a
   * journey-anchored run re-replays its Journey prefix. `false`: it could not (the retry then loads
   * `startUrl`, as without it).
   */
  readonly restartAtStart?: (actor: ExploreConfig["actor"]) => Promise<boolean>;
  /** The independent success oracle (user-supplied): an assertion on the final page. */
  readonly successAssertion?: Assertion;
  /**
   * More independent checks, ALL of which must hold with `successAssertion` (page, reloadThen,
   * requestMade, responseStatus). At least one of the two must be given.
   */
  readonly successChecks?: readonly SuccessCheck[];
  /** Overall bound for the oracle's bounded polling check (ms). Default 3000. */
  readonly oracleTimeoutMs?: number;
  /** Bound (ms) on waiting for the page to settle before network / reload checks. Default 10000. */
  readonly oracleSettleMs?: number;
  /**
   * #543: makes an `http` success check's request (the CLI's probe: allowlist re-checked, no
   * redirect, capped body). Absent: an `http` check fails closed as unevaluable.
   */
  readonly httpProbe?: HttpProbe;
  /** #543: resolves an `http` check's `${name}` placeholders (`setup.x`); a secret one is refused. */
  readonly httpRefs?: HttpCheckRefResolver;
  /**
   * Opens a FRESH browser session — used to reproduce a hang by replaying its steps. Without it a
   * hang cannot be confirmed and is reported `intermittent` (0 replays), never dropped.
   */
  readonly openFreshSession?: () => Promise<VerifySession>;
  /** How many fresh-context replays confirm a hang. Default 2. */
  readonly hangReplays?: number;
  /**
   * When the page checks must hold (#80): `final` (default) — on the final page; `held` — on the
   * final page, or all together at some settled step of the run. `reloadThen` is final-only.
   */
  readonly successWhen?: SuccessWhen;
  /**
   * #202: a check that was already satisfied BEFORE the run's first action — a page/reloadThen check
   * that held on the seed page and never stopped holding, a network check matched only by a request
   * sent before the first action (page load, polling) — cannot verify the goal. By default it FAILS
   * (a run that proved nothing is never clean); `true` (`--allow-vacuous-checks`) downgrades it to
   * a warning and network checks then count every captured request again.
   */
  readonly allowVacuousChecks?: boolean;
  /** App-declared invariants (#86), evaluated around every action. A violation is `defects-found`. */
  readonly invariants?: InvariantSpec;
  /**
   * Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value, resolved
   * by the CLI dispatch from the environment (this package never reads `process.env`).
   */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * #147: the observer actors' own sessions (fresh contexts, never driven by the model) that the
   * spec's cross-actor invariants check from. A cross-actor invariant left undecided (nothing
   * captured, the observer's session lost) keeps a passing run from being `succeeded`.
   */
  readonly observers?: ObserverSessions;
  /** #147: the primary actor's name (the owner in a cross-actor finding). */
  readonly primaryActor?: string;
  /**
   * #225: the calling mission's own brief (a usability review's "pursue the job as a first-time
   * user…"), put before this mission's own context — never replacing it.
   */
  readonly missionBrief?: string;
}

/**
 * When the goal mission's page checks must hold. `each` (#337): every page check went from not
 * holding to holding at SOME settled step, each at its own (a goal whose checks live on different
 * pages: "Connected" on Connections, then "Payments ready" on Pricing); the run stops once all have.
 */
export type SuccessWhen = "held" | "final" | "each";


export type GoalBasedOutcome =
  | "succeeded"
  | "exhausted"
  | "blocked"
  | "failed"
  | "defects-found"
  | "hang"
  | "intermittent"
  | "inconclusive"
  | "crashed"
  /** #448: reported by the CLI when the run executed zero actions (the mission itself never ends so). */
  | "not-started";

export interface GoalBasedResult {
  readonly outcome: GoalBasedOutcome;
  /** Whether EVERY independent check held (the ONLY success signal). */
  readonly assertionPassed: boolean;
  /** Each check's verdict and what the oracle saw — the failing one names what caught the run. */
  readonly checks: SuccessCheckResult[];
  readonly run: ExploreRun;
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  readonly finalUrl: string;
  /** The hang finding (with its reproduction k/N), for a `hang`/`intermittent` outcome. */
  readonly hang?: HangFinding;
  /**
   * #126: a hang met on the SEED load (before any action) that did NOT reproduce (0/N). It never
   * ends the mission — it is kept here as evidence and the run retried the goal once more, whatever
   * that retry's own `outcome` turned out to be.
   */
  readonly intermittentHangs?: HangFinding[];
  /**
   * Why the mission did not succeed, in one line — set for EVERY outcome but `succeeded`
   * (`blocked`/`exhausted` included, which carry no engine `failure`): how the loop ended and
   * which success check did not hold.
   */
  readonly reason?: string;
  /**
   * #209: the typed cause of a goal-specific miss — `success-check-failed` (outcome `failed`) or
   * `vacuous-check` (outcome `inconclusive`). An engine failure stays on `run.failure`.
   */
  readonly failure?: MissionFailure;
  /** Declared-invariant violations (#86), deduped by fingerprint, each with its repro step. */
  readonly invariantDefects?: InvariantDefect[];
  /**
   * #423: the goal's own ending a violated invariant overrode with `defects-found` (`succeeded`,
   * `exhausted`, `blocked`, `failed`, or an `inconclusive` budget/vacuous stop) — so a caller can
   * keep "did the goal get reached" apart from "did the app break a rule". Absent otherwise.
   */
  readonly goalEnding?: GoalBasedOutcome;
  /** Per declared invariant: how often it applied, held, was violated, or could not be read. */
  readonly invariants?: InvariantReport[];
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
  /**
   * Operator-facing warnings about the verdict (#174: a `--success-when held` check vacuous on the
   * start page; #202: every check satisfied before the run's first action, failed or allowed).
   */
  readonly warnings?: string[];
}


/**
 * Every check the oracle must pass, in the order given — possibly none (#130d): a find-out goal has
 * no page state to assert on, and is verified instead by a grounded `report` answer (#101). Without
 * a check AND without the goal ending via `report`, the run is simply incomplete (never a vacuous
 * pass) — see `adjudicatedRun`.
 */
function successChecksOf(cfg: GoalBasedMissionConfig): SuccessCheck[] {
  return [
    ...(cfg.successAssertion === undefined ? [] : [{ kind: "page" as const, assertion: cfg.successAssertion }]),
    ...(cfg.successChecks ?? []),
  ];
}

export async function runGoalBasedMission(
  cfg: GoalBasedMissionConfig,
): Promise<GoalBasedResult> {
  const checks = successChecksOf(cfg);
  const page = cfg.actor.ability(BrowseTheWebToken).session.page;
  // Network checks look at every request the run makes, from before the first navigation.
  const needsNetwork = checks.some((c) => c.kind === "requestMade" || c.kind === "responseStatus");
  if (cfg.successWhen !== undefined && cfg.successWhen !== "held" && cfg.successWhen !== "final" && cfg.successWhen !== "each") {
    throw new Error(`runGoalBasedMission: successWhen must be "held", "final" or "each", got ${JSON.stringify(cfg.successWhen)}`);
  }
  const capture = needsNetwork ? monitorFor(page).startCapture() : null;
  // A transient-state check (#148 `flashed`) needs the flash recorder BEFORE the triggering action:
  // installed now, for every document the run loads.
  if (checks.some((c) => (c.kind === "page" || c.kind === "reloadThen") && c.assertion.kind === "flashed")) {
    await installFlashRecorder(page);
  }
  try {
    return await adjudicated(cfg, checks, page, capture);
  } finally {
    if (capture !== null) monitorFor(page).stopCapture(capture);
  }
}

async function adjudicated(
  cfg: GoalBasedMissionConfig,
  checks: readonly SuccessCheck[],
  page: Page,
  capture: RequestCapture | null,
): Promise<GoalBasedResult> {
  const declared = declaredInvariants(cfg, page);
  const run = await adjudicatedRun(cfg, checks, page, capture, declared);
  const result = declared === null ? run : declared.fold(run);
  // #245: the mission's own verdict (success checks included) is the demo's final banner.
  await demoOverlayFor(cfg.demoOverlay, [...(cfg.secrets ?? []), ...secretFieldSecrets(cfg.secretFields)])?.finish(
    `jevitate · goal — ${result.outcome}${result.reason === undefined ? "" : `: ${result.reason}`}`,
    result.outcome === "succeeded",
    page,
  );
  return result;
}


/** Ops that change nothing in the app: no invariant is judged around them. */
const NON_ACTIONS: ReadonlySet<string> = new Set(["wait", "done", "blocked", "scroll_up", "scroll_down"]);

function declaredInvariants(cfg: GoalBasedMissionConfig, page: Page): DeclaredHooks | null {
  if (cfg.invariants === undefined) return null;
  const monitor = new InvariantMonitor(cfg.invariants, {
    allowlist: cfg.allowlist,
    baseUrl: cfg.startUrl,
    ...(cfg.secrets === undefined ? {} : { secrets: cfg.secrets }),
    ...(cfg.invariantAuthTokens === undefined ? {} : { authTokens: cfg.invariantAuthTokens }),
    ...(cfg.observers === undefined ? {} : { observers: cfg.observers }),
    ...(cfg.primaryActor === undefined ? {} : { primaryActor: cfg.primaryActor }),
  });
  monitor.attach(page);
  const log = new InvariantDefectLog();
  let steps = 0;
  let budgetSettledSteps = 0;
  let pending: InvariantAction | null = null;
  const settled = async (): Promise<void> => {
    const action = pending;
    pending = null;
    const r = await monitor.after(cfg.actor, action, { rearm: true });
    for (const v of r.violations) log.add(v, { recordingStepIndex: Math.max(0, steps - 1) });
  };
  // #150 — the SAME monitor reads a budget's declared observables: same #86/#135 read/auth/redaction
  // machinery, one probe schedule (never a duplicate read of the same observable per step).
  const budgetDecls = cfg.invariants.budget ?? [];
  const budget = budgetDecls.length === 0 ? null : new BudgetMonitor(budgetDecls, monitor);
  return {
    onTranscriptEntry: (entry, all) => {
      cfg.onTranscriptEntry?.(entry, all);
      if (entry.op === null || !entry.actOk || NON_ACTIONS.has(entry.op)) return;
      const d = entry.descriptor;
      pending = {
        op: entry.op,
        control: d?.name ?? d?.label ?? d?.text ?? entry.target,
        // Several actions before one settled snapshot (type, then send): judged together, from the first.
        url: pending?.url ?? entry.url,
        step: pending?.step ?? entry.step,
      };
    },
    onRecording: (recording) => {
      cfg.onRecording?.(recording);
      steps = recordingStepCount(recording);
    },
    onBeforeAction:
      budget === null
        ? undefined
        : async (info) => {
            const g = await budget.guard(page, info);
            return g.refuse ? { refuse: true, reason: g.reason ?? "budget guard refused the action" } : { refuse: false };
          },
    onSettled:
      budget === null
        ? undefined
        : async () => {
            budgetSettledSteps += 1;
            // The FIRST settled snapshot (before any action) is the budget's baseline (mirrors how
            // `settled()` above re-arms the invariants' own "before" on its first, action-less call).
            if (budgetSettledSteps === 1) {
              const b = await budget.baseline(page);
              return b.crossed ? { stop: true, reason: b.reason ?? "budget observable unreadable at run start" } : { stop: false };
            }
            const r = await budget.afterSettle(page, budgetSettledSteps);
            return r.crossed ? { stop: true, reason: r.reason ?? "mission budget crossed" } : { stop: false };
          },
    settled,
    finish: async (run) => {
      // Never on a broken or hung page: an unresponsive page proves nothing either way.
      if (run.stop === "crashed" || run.stop === "hang") return;
      if (pending !== null) {
        await monitorFor(page).waitSettled({ ceilingMs: cfg.oracleSettleMs ?? DEFAULT_ORACLE_SETTLE_MS }).catch(() => undefined);
        await settled().catch(() => undefined);
      }
      // #195: a response to the LAST action that landed after its check is still a never.response hit.
      await finishDeclaredRun({ monitor, log, lastRepro: { recordingStepIndex: Math.max(0, steps - 1) } });
      // #147: a resource the LAST action created is still checked from the observers.
      const cross = await monitor.settleCrossActor(cfg.actor).catch(() => null);
      for (const v of cross?.violations ?? []) log.add(v, { recordingStepIndex: Math.max(0, steps - 1) });
    },
    fold: (result) => {
      const invariantDefects = log.defects();
      const invariants = monitor.report();
      const withBudget: GoalBasedResult = budget === null ? result : { ...result, budget: budget.trajectory() };
      // #147 fail closed: a cross-actor invariant that never decided cannot let the run read as clean.
      const undecided = monitor.undecidedCrossActor();
      if (invariantDefects.length === 0 && undecided.length > 0 && withBudget.outcome === "succeeded") {
        const why = `cross-actor invariant(s) undecided: ${undecided.map((u) => `${u.id} (${u.reason})`).join("; ")}`;
        return { ...withBudget, outcome: "inconclusive", reason: why, invariantDefects, invariants };
      }
      if (invariantDefects.length === 0) return { ...withBudget, invariantDefects, invariants };
      // A violated invariant is a hard defect: it overrides a pass or a plain miss — never a broken
      // run or a hang, whose own verdict is more severe (the defects are still reported). A budget
      // stop is a clean, deliberate stop (not the run breaking): #150 — defects found before it still
      // win, reported with `stop: "budget"`.
      const hard =
        withBudget.outcome === "succeeded" ||
        withBudget.outcome === "exhausted" ||
        withBudget.outcome === "blocked" ||
        withBudget.outcome === "failed" ||
        // #209: a vacuous check proved nothing, but a violated invariant was observed — it still wins.
        withBudget.failure?.kind === "vacuous-check" ||
        withBudget.run.stop === "budget";
      const why = invariantDefects.map((d) => d.invariant.reason).join("; ");
      const { failure: _goalFailure, ...rest } = withBudget;
      return {
        ...(hard ? rest : withBudget),
        outcome: hard ? "defects-found" : withBudget.outcome,
        ...(hard ? { goalEnding: withBudget.outcome } : {}),
        reason: withBudget.reason === undefined ? why : `${why}; ${withBudget.reason}`,
        invariantDefects,
        invariants,
      };
    },
  };
}

/**
 * The goal mission's run and verdict (#500: an orchestrator over its phases, in order) — setup, act
 * (with the #126 seed-hang retry), the declared invariants' finish, the early verdicts, the
 * independent oracle, the adjudication, and the report.
 */
async function adjudicatedRun(
  cfg: GoalBasedMissionConfig,
  checks: readonly SuccessCheck[],
  page: Page,
  capture: RequestCapture | null,
  declared: DeclaredHooks | null,
): Promise<GoalBasedResult> {
  const ctx = setupAdjudication(cfg, checks, page, capture, declared);
  const acted = await act(ctx);
  if (acted.kind === "ended") return acted.result;
  const { run, intermittentHangs } = acted;

  await declared?.finish(run);

  const early = await earlyVerdict(ctx, run, intermittentHangs);
  if (early !== null) return early;

  const oracle = await evaluateOracle(ctx, run, intermittentHangs);
  if (oracle.kind === "ended") return oracle.result;

  return report(run, adjudicate(ctx, run, oracle.results, oracle.vacuousNetwork), intermittentHangs);
}
