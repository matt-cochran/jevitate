import type { Assertion, Recording } from "@jevitate/recording";
import { checkAssertion } from "@jevitate/interpreter";
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
import { explore, type ExploreConfig, type ExploreRun, type TranscriptEntry } from "../explore.js";
import { NOT_REPLAYED, hangFinding, reproduceHang, type HangFinding, type HangReproduction } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";

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
}

export type GoalBasedOutcome = "succeeded" | "exhausted" | "blocked" | "hang" | "intermittent" | "inconclusive" | "crashed";

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
   * Why the mission did not succeed, in one line — set for EVERY outcome but `succeeded`
   * (`blocked`/`exhausted` included, which carry no engine `failure`): how the loop ended and
   * which success check did not hold.
   */
  readonly reason?: string;
}

/** The one-line account of an unsuccessful run: how the loop ended, then the checks that failed. */
function whyNot(run: ExploreRun, results: readonly SuccessCheckResult[]): string {
  const ended = run.outcome.status === "incomplete" ? run.outcome.reason : `the run stopped (${run.stop})`;
  const failed = results.filter((r) => !r.passed).map((r) => `${r.check} ${r.detail}`);
  return failed.length === 0 ? ended : `${ended}; success check failed: ${failed.join("; ")}`;
}

const DEFAULT_ORACLE_SETTLE_MS = 10_000;

/** Every check the oracle must pass, in the order given. Throws (a setup error) when there is none. */
function successChecksOf(cfg: GoalBasedMissionConfig): SuccessCheck[] {
  const checks: SuccessCheck[] = [
    ...(cfg.successAssertion === undefined ? [] : [{ kind: "page" as const, assertion: cfg.successAssertion }]),
    ...(cfg.successChecks ?? []),
  ];
  if (checks.length === 0) throw new Error("runGoalBasedMission: a success assertion or at least one success check is required");
  return checks;
}

export async function runGoalBasedMission(
  cfg: GoalBasedMissionConfig,
): Promise<GoalBasedResult> {
  const checks = successChecksOf(cfg);
  const page = cfg.actor.ability(BrowseTheWebToken).session.page;
  // Network checks look at every request the run makes, from before the first navigation.
  const needsNetwork = checks.some((c) => c.kind === "requestMade" || c.kind === "responseStatus");
  const capture = needsNetwork ? monitorFor(page).startCapture() : null;
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
  const run = await explore({
    ...cfg,
    missionContext:
      "success is judged independently by user-supplied checks — your `done` is only a proposal, not the verdict",
    // The same independent oracle grounds a proposed `done` mid-run: `done` is accepted only when
    // the checks hold, so an early `done` never ends the run silently. `reloadThen` is left to the
    // final verdict — reloading mid-run would throw away the state the run is still building.
    successCheck: () =>
      evaluateChecks(cfg, checks.filter((c) => c.kind !== "reloadThen"), page, capture).then(
        (rs) => rs.every((r) => r.passed),
        () => false,
      ),
  });

  // A hang is a first-class finding: reproduce it in fresh contexts, then report k/N.
  if (run.stop === "hang" && run.hang !== undefined) {
    const h = run.hang;
    const reproduction: HangReproduction =
      cfg.openFreshSession === undefined
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
          });
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
      reason: `${finding.title} (reproduced ${reproduction.reproduced}/${reproduction.attempts})`,
    };
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
    };
  }

  const assertionPassed = results.every((r) => r.passed);
  const outcome: GoalBasedOutcome = assertionPassed
    ? "succeeded"
    : run.stop === "exhausted"
      ? "exhausted"
      : "blocked";

  return {
    outcome,
    assertionPassed,
    checks: results,
    run,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
    ...(outcome === "succeeded" ? {} : { reason: whyNot(run, results) }),
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
    return { check: describeCheck(check), passed, detail: passed ? `held ${when}` : `did not hold ${when}` };
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
