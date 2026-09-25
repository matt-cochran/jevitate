import type { Assertion, Recording } from "@jevitate/recording";
import { checkAssertion, installFlashRecorder, readAssertionEvidence, readAssertionText } from "@jevitate/interpreter";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import type { Page } from "playwright";
import { reloadPage } from "../act.js";
import { monitorFor, type RequestCapture } from "../page-monitor.js";
import {
  describeCheck,
  evaluateNetworkCheck,
  type SuccessCheck,
  type SuccessCheckResult,
} from "../success-checks.js";
import { redactText } from "../redact.js";
import { explore, type ExploreConfig, type ExploreRun, type RunOutcome, type TranscriptEntry } from "../explore.js";
import { NOT_REPLAYED, hangFinding, reproduceHang, withheldReason, type HangFinding, type HangReproduction } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";
import type { InvariantSpec } from "@jevitate/recording";
import {
  InvariantDefectLog,
  InvariantMonitor,
  type ObserverSessions,
  recordingStepCount,
  type InvariantAction,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";
import { BudgetMonitor, type BudgetTrajectory } from "../budget.js";
import { goalAsksForChange } from "../read-only.js";

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
 *
 * Outcome:
 *  - `succeeded`  — the success assertion holds against the live final page.
 *  - `exhausted`  — the assertion did not hold and the loop hit a budget cap.
 *  - `blocked`    — the assertion did not hold and the loop stopped otherwise
 *                   (model done/blocked, no valid target, no-progress, …).
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

export interface GoalBasedMissionConfig extends Omit<ExploreConfig, "missionContext"> {
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
}

/** When the goal mission's page checks must hold. */
export type SuccessWhen = "held" | "final";

/** Bound (ms) on each per-step page-check evaluation under `successWhen: "held"` (a quick look). */
const HELD_CHECK_TIMEOUT_MS = 250;

export type GoalBasedOutcome =
  | "succeeded"
  | "exhausted"
  | "blocked"
  | "defects-found"
  | "hang"
  | "intermittent"
  | "inconclusive"
  | "crashed";

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
  /** Declared-invariant violations (#86), deduped by fingerprint, each with its repro step. */
  readonly invariantDefects?: InvariantDefect[];
  /** Per declared invariant: how often it applied, held, was violated, or could not be read. */
  readonly invariants?: InvariantReport[];
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
  /** Operator-facing warnings about the verdict (#174: a `--success-when held` check vacuous on the start page). */
  readonly warnings?: string[];
}

/** Does this result belong to a page check (the kind `held` can remember)? Matched by description. */
function isPageCheck(r: SuccessCheckResult, pageChecks: readonly SuccessCheck[]): boolean {
  return pageChecks.some((c) => describeCheck(c) === r.check);
}

/** A quick, bounded look: do ALL the page checks hold right now? */
async function everyPageCheckHolds(actor: Actor, pageChecks: readonly SuccessCheck[]): Promise<boolean> {
  for (const c of pageChecks) {
    if (c.kind !== "page") continue;
    if (!(await checkAssertion(actor, c.assertion, { timeoutMs: HELD_CHECK_TIMEOUT_MS }))) return false;
  }
  return true;
}

/** The one-line account of an unsuccessful run: how the loop ended, then the checks that failed. */
function whyNot(run: ExploreRun, results: readonly SuccessCheckResult[]): string {
  const ended = run.outcome.status === "incomplete" ? run.outcome.reason : `the run stopped (${run.stop})`;
  const failed = results.filter((r) => !r.passed).map((r) => `${r.check} ${r.detail}`);
  return failed.length === 0 ? ended : `${ended}; success check failed: ${failed.join("; ")}`;
}

const DEFAULT_ORACLE_SETTLE_MS = 10_000;

/** Bound on the text quoted into a failed check's detail (#113): enough to see the mismatch, never a page dump. */
const READ_TEXT_MAX_CHARS = 200;

function quoteRead(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return `"${flat.length > READ_TEXT_MAX_CHARS ? `${flat.slice(0, READ_TEXT_MAX_CHARS)}…` : flat}"`;
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
  if (cfg.successWhen !== undefined && cfg.successWhen !== "held" && cfg.successWhen !== "final") {
    throw new Error(`runGoalBasedMission: successWhen must be "held" or "final", got ${JSON.stringify(cfg.successWhen)}`);
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
  const result = await adjudicatedRun(cfg, checks, page, capture, declared);
  return declared === null ? result : declared.fold(result);
}

/**
 * Declared invariants (#86) through the loop's own hooks: the transcript names each action, the
 * Recording its step index, and every settled snapshot evaluates the action(s) since the previous
 * one (then re-arms the "before" for the next). An action the loop took but never re-observed (the
 * run ended right after it) is evaluated on the final page once it settles.
 */
interface DeclaredHooks {
  readonly onTranscriptEntry: NonNullable<ExploreConfig["onTranscriptEntry"]>;
  readonly onRecording: NonNullable<ExploreConfig["onRecording"]>;
  readonly onBeforeAction: ExploreConfig["onBeforeAction"];
  readonly onSettled: ExploreConfig["onSettled"];
  readonly settled: () => Promise<void>;
  readonly finish: (run: ExploreRun) => Promise<void>;
  readonly fold: (result: GoalBasedResult) => GoalBasedResult;
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
        withBudget.run.stop === "budget";
      const why = invariantDefects.map((d) => d.invariant.reason).join("; ");
      return {
        ...withBudget,
        outcome: hard ? "defects-found" : withBudget.outcome,
        reason: withBudget.reason === undefined ? why : `${why}; ${withBudget.reason}`,
        invariantDefects,
        invariants,
      };
    },
  };
}

async function adjudicatedRun(
  cfg: GoalBasedMissionConfig,
  checks: readonly SuccessCheck[],
  page: Page,
  capture: RequestCapture | null,
  declared: DeclaredHooks | null,
): Promise<GoalBasedResult> {
  const pageChecks = checks.filter((c) => c.kind === "page");
  /** Under `held`: the first settled step at which every page check held together (1-based), or null. */
  let heldAtStep: number | null = null;
  let settledSteps = 0;
  const held = cfg.successWhen === "held" && pageChecks.length > 0;
  /**
   * #174: a held page check counts only once it CHANGED from not holding to holding — never because
   * it already held on the start page (a placeholder that is there before anything was done).
   */
  let sawNotHolding = false;
  /** #174: the page checks all held on the start state, before any action (vacuous there). */
  let heldAtStart = false;
  const networkChecks = checks.filter(
    (c): c is Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }> => c.kind === "requestMade" || c.kind === "responseStatus",
  );
  // #174: under `held`, once every check has held the run stops — it never keeps acting (or writing)
  // past a met goal. `reloadThen` is final-only, so a run that declares one keeps the model's `done`.
  const stopWhenHeld = cfg.successWhen === "held" && checks.length > 0 && !checks.some((c) => c.kind === "reloadThen");
  // A find-out goal (#130d) has no page/network check to independently ground `done` with: it is
  // verified instead by a grounded `report` (#101), which `explore()` grounds on its own regardless
  // of `successCheck`. Leaving `successCheck` unset here (rather than wiring one that vacuously
  // "passes" over zero checks) sends `done` through the advisory goal-judgment path instead of a
  // false independent pass.
  const hasChecks = checks.length > 0;
  // #158 — a find-out goal is READ-ONLY unless its text asks for a change or `--allow-writes`:
  // independent code refuses write flows and aborts write requests; the model is told.
  const readOnly = !hasChecks && cfg.safety?.allowWrites !== true && !goalAsksForChange(cfg.goal);
  const runOnce = (): Promise<ExploreRun> =>
    explore({
      ...cfg,
      readOnly,
      missionContext: hasChecks
        ? "success is judged independently by user-supplied checks — your `done` is only a proposal, not the verdict"
        : "no --success check was given: end with `report` once you can answer the goal from what you observed — a grounded answer is the verdict",
      // `held`: after every settled step, a quick look at the page checks — remembered once they all
      // held together. Advisory to the loop (it never changes its control flow); the verdict below uses it.
      ...(declared === null
        ? {}
        : {
            onTranscriptEntry: declared.onTranscriptEntry,
            onRecording: declared.onRecording,
            ...(declared.onBeforeAction === undefined ? {} : { onBeforeAction: declared.onBeforeAction }),
            ...(declared.onSettled === undefined ? {} : { onSettled: declared.onSettled }),
          }),
      onSnapshot: async (snap) => {
        await cfg.onSnapshot?.(snap);
        await declared?.settled().catch(() => undefined);
        settledSteps += 1;
        if (!held || heldAtStep !== null) return;
        const ok = await everyPageCheckHolds(cfg.actor, pageChecks).catch(() => false);
        if (!ok) sawNotHolding = true;
        else if (sawNotHolding) heldAtStep = settledSteps;
        else if (settledSteps === 1) heldAtStart = true;
      },
      ...(stopWhenHeld
        ? {
            successMetNow: async (): Promise<string | null> => {
              // Never before an action: the start state proves nothing was done.
              if (settledSteps < 2) return null;
              if (pageChecks.length > 0 && heldAtStep === null) return null;
              const requests = capture?.requests() ?? [];
              if (!networkChecks.every((c) => evaluateNetworkCheck(c, requests, capture?.truncated ?? false).passed)) return null;
              return pageChecks.length > 0
                ? `every --success check held (the page checks at settled step ${heldAtStep}; --success-when held)`
                : "every --success check held (--success-when held)";
            },
          }
        : {}),
      // The same independent oracle grounds a proposed `done` mid-run: `done` is accepted only when
      // the checks hold, so an early `done` never ends the run silently. `reloadThen` is left to the
      // final verdict — reloading mid-run would throw away the state the run is still building.
      // Under `held`, a page check that already held (together, at a settled step) counts.
      ...(hasChecks
        ? {
            successCheck: () =>
              evaluateChecks(cfg, checks.filter((c) => c.kind !== "reloadThen"), page, capture).then(
                (rs) =>
                  rs.every((r) =>
                    held && isPageCheck(r, pageChecks)
                      ? // #174: under `held` a page check counts once it went from not holding to holding.
                        heldAtStep !== null || (r.passed && sawNotHolding)
                      : r.passed,
                  ),
                () => false,
              ),
          }
        : {}),
    });

  let run = await runOnce();
  /**
   * #126: a hang met on the SEED load (before any action — `recordingStepIndex === 0`) that does
   * NOT reproduce is not proof the app is stuck; it can be a single slow request on a loaded host.
   * It must not end the mission. It is recorded as an intermittent finding and the goal is tried
   * once more from a fresh navigate of the seed. A hang that DOES reproduce (or that could not be
   * replayed at all) ends the run exactly as before.
   */
  const intermittentHangs: HangFinding[] = [];
  if (run.stop === "hang" && run.hang !== undefined && run.hang.recordingStepIndex === 0 && cfg.openFreshSession !== undefined) {
    const h = run.hang;
    const reproduction = await reproduceSeedHang(cfg, run, h);
    if (reproduction.status === "intermittent") {
      intermittentHangs.push(hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction));
      run = await runOnce();
    } else {
      return { ...hangResult(run, h, reproduction), ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }) };
    }
  }

  await declared?.finish(run);

  // A hang is a first-class finding: reproduce it in fresh contexts, then report k/N.
  if (run.stop === "hang" && run.hang !== undefined) {
    const h = run.hang;
    const reproduction = await reproduceSeedHang(cfg, run, h);
    return { ...hangResult(run, h, reproduction), ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }) };
  }

  // A broken run proves nothing: its assertion is never evaluated into a pass.
  if (run.stop === "crashed" || run.stop === "inconclusive") {
    return {
      outcome: run.stop,
      assertionPassed: false,
      checks: [],
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      reason: whyNot(run, []),
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    };
  }

  // #150 — a declared mission spend budget was crossed (or a paid action refused before crossing
  // it): the run stopped cleanly, before its next action. Never `succeeded`, never `crashed` — maps
  // to `inconclusive` (its own work past the stop is unproven), kept apart from `run.stop`.
  if (run.stop === "budget") {
    return {
      outcome: "inconclusive",
      assertionPassed: false,
      checks: [],
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      reason: whyNot(run, []),
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    };
  }

  // A find-out goal (#130d): no --success check was given, so there is nothing to evaluate against
  // the live page. The verdict is the run's own grounded outcome instead — `report` grounding an
  // answer (#101), or the advisory goal judgment grounding a `done`. Never a vacuous pass: a run that
  // exhausted its budget or got blocked without either is simply not succeeded.
  if (!hasChecks) {
    const succeeded = run.outcome.status === "completed";
    return {
      outcome: succeeded ? "succeeded" : run.stop === "exhausted" ? "exhausted" : "blocked",
      assertionPassed: succeeded,
      checks: [],
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      ...(succeeded ? {} : { reason: whyNot(run, []) }),
    };
  }

  // Independent oracle: never Jev's self-report. Evaluated against the live page. An oracle that
  // cannot even be evaluated (the page died after the loop ended) is a crash, never a pass.
  let results: SuccessCheckResult[];
  try {
    results = await evaluateChecks(cfg, checks, page, capture);
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
    const crashedRun: ExploreRun = {
      ...run,
      stop: "crashed",
      failure: { kind: "exception", message: `success oracle failed: ${message}` },
    };
    return {
      outcome: "crashed",
      assertionPassed: false,
      checks: [],
      run: crashedRun,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      reason: `success oracle failed: ${message}`,
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    };
  }

  // `held`: a page check that failed on the final page passes when every page check held together
  // at a settled step of the run — and says so. Never on a run that could not be evaluated (above).
  if (heldAtStep !== null) {
    const step = heldAtStep;
    results = results.map((r) =>
      !r.passed && isPageCheck(r, pageChecks)
        ? { ...r, passed: true, detail: `held at settled step ${step} (--success-when held); ${r.detail}` }
        : r,
    );
  }
  // #174: under `held`, page checks that already held on the start page and never stopped holding
  // prove nothing was done — vacuous, never a pass (not even on the final page).
  const vacuous = held && heldAtStart && !sawNotHolding;
  if (vacuous) {
    results = results.map((r) =>
      r.passed && isPageCheck(r, pageChecks)
        ? {
            ...r,
            passed: false,
            detail: `vacuous: already held on the start page before any action and never changed (--success-when held needs it to go from not holding to holding); ${r.detail}`,
          }
        : r,
    );
  }
  const warnings: string[] = held && heldAtStart
    ? [
        vacuous
          ? "--success-when held: the page checks already held on the start page, before any action, and never changed — vacuous, not counted"
          : "--success-when held: the page checks already held on the start page, before any action (vacuous there); they counted only once they went from not holding to holding",
      ]
    : [];
  const assertionPassed = results.every((r) => r.passed);
  const outcome: GoalBasedOutcome = assertionPassed
    ? "succeeded"
    : run.stop === "exhausted"
      ? "exhausted"
      : "blocked";

  // `runOutcome` and `outcome` must never disagree (#113): the in-run `done` grounding (the
  // `successCheck` given to `explore` above) evaluates every check EXCEPT `reloadThen` — a mid-run
  // reload would throw away state the run is still building — so a run can end `completed` there and
  // this, the final, full evaluation (including `reloadThen`) can still fail. The final verdict
  // overrides: a mission that did not succeed never carries a `completed` runOutcome.
  const runOutcome: RunOutcome =
    !assertionPassed && run.outcome.status === "completed"
      ? { status: "incomplete", reason: whyNot(run, results) }
      : run.outcome;
  const finalRun: ExploreRun = runOutcome === run.outcome ? run : { ...run, outcome: runOutcome };

  return {
    outcome,
    assertionPassed,
    checks: results,
    run: finalRun,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
    ...(outcome === "succeeded" ? {} : { reason: whyNot(run, results) }),
    ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/** Reproduce a hang the loop stopped on, in fresh contexts (owner ruling 7). */
async function reproduceSeedHang(
  cfg: GoalBasedMissionConfig,
  run: ExploreRun,
  h: NonNullable<ExploreRun["hang"]>,
): Promise<HangReproduction> {
  return cfg.openFreshSession === undefined
    ? NOT_REPLAYED
    : await reproduceHang({
        recording: run.recording,
        recordingStepIndex: h.recordingStepIndex,
        hang: h.signal,
        openSession: cfg.openFreshSession,
        ...(cfg.hangReplays === undefined ? {} : { attempts: cfg.hangReplays }),
        perceive: {
          ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
          ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
          ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
          ...(cfg.settle === undefined ? {} : { settleConfig: cfg.settle }),
          ...(cfg.hangs === undefined ? {} : { hangConfig: cfg.hangs }),
        },
        ...(cfg.stallMs === undefined ? {} : { stallMs: cfg.stallMs }),
        ...(cfg.safety === undefined ? {} : { safety: cfg.safety }),
      });
}

/** The mission-ending result for a hang whose reproduction is already known. */
function hangResult(run: ExploreRun, h: NonNullable<ExploreRun["hang"]>, reproduction: HangReproduction): GoalBasedResult {
  const finding = hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction);
  return {
    // A hang whose replays could not run at all is `inconclusive`, never a non-reproduction.
    outcome: reproduction.status === "reproduced" ? "hang" : reproduction.status,
    assertionPassed: false,
    checks: [],
    run,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
    hang: finding,
    reason:
      reproduction.withheld !== undefined
        ? `${finding.title} (${withheldReason(reproduction.withheld)})`
        : reproduction.attempts === 0
        ? `${finding.title} (unconfirmed: not replayed)`
        : `${finding.title} (reproduced ${reproduction.reproduced}/${reproduction.attempts})`,
  };
}

/**
 * The oracle, in order: let the page settle (a save still in flight lands first), read the captured
 * requests, check the final page, then reload and check what persisted. The network checks use the
 * requests from BEFORE the oracle's own reload — only what the run did counts. Results keep the
 * order the checks were given in.
 */
async function evaluateChecks(
  cfg: GoalBasedMissionConfig,
  checks: readonly SuccessCheck[],
  page: Page,
  capture: RequestCapture | null,
): Promise<SuccessCheckResult[]> {
  const timeoutMs = cfg.oracleTimeoutMs ?? 3000;
  const ceilingMs = cfg.oracleSettleMs ?? DEFAULT_ORACLE_SETTLE_MS;
  const results = new Map<number, SuccessCheckResult>();
  const needsSettle = checks.some((c) => c.kind !== "page");
  if (needsSettle) await monitorFor(page).waitSettled({ ceilingMs });
  const requests = capture?.requests() ?? [];

  const assertOn = async (actor: Actor, assertion: Assertion, when: string, check: SuccessCheck): Promise<SuccessCheckResult> => {
    const passed = await checkAssertion(actor, assertion, { timeoutMs });
    // A visual-state check (#148) always says what it observed — the ratio, the computed values, the
    // flash timing — pass or fail (bounded, redacted: it is page-derived).
    const evidence = await readAssertionEvidence(actor, assertion).catch(() => null);
    if (evidence !== null) {
      const seen = redactText(evidence, cfg.secrets ?? []).slice(0, READ_TEXT_MAX_CHARS);
      return { check: describeCheck(check), passed, detail: `${passed ? "held" : "did not hold"} ${when} (${seen})` };
    }
    if (passed) return { check: describeCheck(check), passed, detail: `held ${when}` };
    // #113 — a `textIncludes` mismatch is otherwise invisible ("did not hold" alone doesn't say
    // whether the text is wrong or just differently cased). What was actually read, bounded and
    // redacted (page text is untrusted, and may carry a secret) — never a full-page dump.
    const read = await readAssertionText(actor, assertion);
    const detail =
      read === null ? `did not hold ${when}` : `did not hold ${when} (read: ${quoteRead(redactText(read, cfg.secrets ?? []))})`;
    return { check: describeCheck(check), passed, detail };
  };

  for (const [i, c] of checks.entries()) {
    if (c.kind === "page") results.set(i, await assertOn(cfg.actor, c.assertion, "on the final page", c));
  }
  const reloads = [...checks.entries()].filter(([, c]) => c.kind === "reloadThen");
  if (reloads.length > 0) {
    // Persistence: what the page shows after a reload came from the server, not local UI state.
    const reloaded = await reloadPage(page);
    if (reloaded.ok) {
      await page.waitForLoadState("domcontentloaded", { timeout: ceilingMs }).catch(() => undefined);
      await monitorFor(page).waitSettled({ ceilingMs });
    }
    for (const [i, c] of reloads) {
      if (c.kind !== "reloadThen") continue;
      results.set(
        i,
        reloaded.ok
          ? await assertOn(cfg.actor, c.assertion, "after a reload", c)
          : { check: describeCheck(c), passed: false, detail: `the page could not be reloaded: ${reloaded.reason ?? "unknown"}` },
      );
    }
  }
  for (const [i, c] of checks.entries()) {
    if (c.kind === "requestMade" || c.kind === "responseStatus") {
      results.set(i, evaluateNetworkCheck(c, requests, capture?.truncated ?? false));
    }
  }
  return checks.map((c, i) => results.get(i) ?? { check: describeCheck(c), passed: false, detail: "not evaluated" });
}
