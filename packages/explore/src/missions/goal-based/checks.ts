/** The goal mission's check helpers (#500: moved verbatim out of `goal-based.ts`). */
import { checkAssertion } from "@jevitate/interpreter";
import type { Actor } from "@jevitate/screenplay";
import type { Page } from "playwright";
import { DEFAULT_ORACLE_SETTLE_MS, evaluateOutcomeChecks } from "../../outcome-checks.js";
import { monitorFor, type CapturedRequest, type DeclaredFields, type RequestCapture } from "../../page-monitor.js";
import {
  describeCheck,
  evaluateNetworkCheck,
  type SuccessCheck,
  type SuccessCheckResult,
} from "../../success-checks.js";
import type { ExploreRun } from "../../explore.js";
import { evaluateHttpCheck } from "../../http-check.js";
import type { GoalBasedMissionConfig } from "../goal-based.js";

/** #286: the pseudo-check a goal that asks for a report adds to its `--success` checks. */
export const REPORT_CHECK = "report (the goal asks for a grounded answer)";

/** Bound (ms) on each per-step page-check evaluation under `successWhen: "held"` (a quick look). */
export const HELD_CHECK_TIMEOUT_MS = 250;

/** Does this result belong to a page check (the kind `held` can remember)? Matched by description. */
export function isPageCheck(r: SuccessCheckResult, pageChecks: readonly SuccessCheck[]): boolean {
  return pageChecks.some((c) => describeCheck(c) === r.check);
}

/** A quick, bounded look: do ALL the page checks hold right now? */
export async function everyPageCheckHolds(actor: Actor, pageChecks: readonly SuccessCheck[]): Promise<boolean> {
  for (const c of pageChecks) {
    if (c.kind !== "page") continue;
    if (!(await checkAssertion(actor, c.assertion, { timeoutMs: HELD_CHECK_TIMEOUT_MS }))) return false;
  }
  return true;
}

/** The one-line account of an unsuccessful run: how the loop ended, then the checks that failed. */
export function whyNot(run: ExploreRun, results: readonly SuccessCheckResult[]): string {
  const ended = run.outcome.status === "incomplete" ? run.outcome.reason : `the run stopped (${run.stop})`;
  const failed = results.filter((r) => !r.passed).map((r) => `${r.check} ${r.detail}`);
  return failed.length === 0 ? ended : `${ended}; success check failed: ${failed.join("; ")}`;
}

/**
 * #202: when network checks start counting. `firstActionAt` is the run's first action (explore's
 * `onAction`: a control op or a chosen reload, at the same point and on the same wall clock as its
 * request→step attribution mark `SideEffectLog.mark` and each captured request's `startedAt`); null
 * while no action has happened.
 */
export interface NetworkScope {
  readonly firstActionAt: number | null;
  readonly allowVacuous: boolean;
}

/** #202: the requests the run's own actions could have caused — sent at or after its first action. */
function sentSinceFirstAction(requests: readonly CapturedRequest[], firstActionAt: number | null): CapturedRequest[] {
  // A request without a start time cannot be attributed to an action: never counted (fail closed).
  return firstActionAt === null ? [] : requests.filter((r) => r.startedAt !== undefined && r.startedAt >= firstActionAt);
}

/** #743: how many declared-field records one page keeps (the oldest are dropped). */
const MAX_DECLARED_FIELDS = 500;
/** #743: per page, each write request's declared field names/types (never values), captured live. */
const declaredFieldsByPage = new WeakMap<Page, DeclaredFields[]>();

/**
 * #743: starts keeping each write request's declared field names and JSON types for `page` —
 * captured at request time (the body is gone by the oracle), never values. Idempotent, so the
 * goal mission may install it before the run and the oracle may call it again.
 */
export function captureDeclaredBodyFields(page: Page): void {
  if (declaredFieldsByPage.has(page)) return;
  const fields: DeclaredFields[] = [];
  declaredFieldsByPage.set(page, fields);
  monitorFor(page).onDeclaredFields((declared) => {
    fields.push(declared);
    if (fields.length > MAX_DECLARED_FIELDS) fields.shift();
  });
}

/** The declared fields captured for `page` so far (empty when the capture was never installed). */
function declaredFieldsFor(page: Page): readonly DeclaredFields[] {
  return declaredFieldsByPage.get(page) ?? [];
}

/** #743: the declared-field records whose method and path match a request in `requests`. */
function declaredWithin(declared: readonly DeclaredFields[], requests: readonly CapturedRequest[]): DeclaredFields[] {
  return declared.filter((d) => requests.some((r) => r.method === d.method && r.path === d.path));
}

/**
 * #202: a network check counts only requests sent after the run's first action — a page-load or
 * polling request that matched before anything was done proves nothing. A check matched ONLY by such
 * a request is vacuous: failed by default, or (`allowVacuous`) judged over every request with a
 * warning (`onVacuous`).
 */
export function judgeNetworkCheck(
  c: Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }>,
  requests: readonly CapturedRequest[],
  truncated: boolean,
  scope: NetworkScope,
  onVacuous?: (spec: string) => void,
  declared: readonly DeclaredFields[] = [],
): SuccessCheckResult {
  const scoped = sentSinceFirstAction(requests, scope.firstActionAt);
  const after = evaluateNetworkCheck(c, scoped, truncated, declaredWithin(declared, scoped));
  const all = evaluateNetworkCheck(c, requests, truncated, declaredWithin(declared, requests));
  const vacuous = !after.passed && all.passed;
  if (vacuous) onVacuous?.(after.check);
  if (scope.allowVacuous) return all;
  return vacuous
    ? {
        ...after,
        detail: `vacuous: matched only by request(s) sent before the run's first action (page load, polling) — held at step 0, before any action, it cannot verify the goal (only requests sent after the first action count; --allow-vacuous-checks downgrades this to a warning); ${after.detail}`,
      }
    : after;
}

/**
 * The oracle, in order: let the page settle (a save still in flight lands first), read the captured
 * requests, check the final page, then reload and check what persisted. The network checks use the
 * requests from BEFORE the oracle's own reload, and (#202) only those sent after the run's first
 * action — only what the run did counts. Results keep the order the checks were given in.
 */
export async function evaluateChecks(
  cfg: GoalBasedMissionConfig,
  checks: readonly SuccessCheck[],
  page: Page,
  capture: RequestCapture | null,
  scope: NetworkScope,
  onVacuous?: (spec: string) => void,
): Promise<SuccessCheckResult[]> {
  captureDeclaredBodyFields(page);
  const declared = declaredFieldsFor(page);
  return evaluateOutcomeChecks(checks, {
    actor: cfg.actor,
    page,
    capture,
    ...(cfg.secrets === undefined ? {} : { secrets: cfg.secrets }),
    timeoutMs: cfg.oracleTimeoutMs ?? 3000,
    settleMs: cfg.oracleSettleMs ?? DEFAULT_ORACLE_SETTLE_MS,
    judgeNetwork: (c, requests, truncated) => judgeNetworkCheck(c, requests, truncated, scope, onVacuous, declared),
    ...(cfg.httpProbe === undefined ? {} : { httpProbe: cfg.httpProbe }),
    ...(cfg.httpRefs === undefined ? {} : { resolveRef: cfg.httpRefs }),
  });
}

/**
 * #543: a check judged only by the final oracle — `reloadThen` (a mid-run reload would throw away
 * the state the run is building) and `http` (a request per step would hammer the outbox).
 */
export function isDeferredCheck(c: SuccessCheck): boolean {
  return c.kind === "reloadThen" || c.kind === "http";
}

/**
 * #543: the goal mission's pre-action vacuity probe — ONE attempt (no poll) of an `http` check
 * before the run acts. Holding already, it cannot verify the goal (#202's rule).
 */
export async function httpCheckHoldsNow(cfg: GoalBasedMissionConfig, c: Extract<SuccessCheck, { kind: "http" }>): Promise<boolean> {
  const v = await evaluateHttpCheck(c, {
    ...(cfg.httpProbe === undefined ? {} : { probe: cfg.httpProbe }),
    ...(cfg.httpRefs === undefined ? {} : { resolveRef: cfg.httpRefs }),
    ...(cfg.secrets === undefined ? {} : { secrets: cfg.secrets }),
    once: true,
  }).catch(() => ({ passed: false }));
  return v.passed;
}
