/**
 * `adjudicatedRun`'s setup phase (#500: moved verbatim out of `goal-based.ts`): what the run will
 * track and how it is configured, before the first attempt. The mutable tracking state lives in one
 * `AdjudicationState` object every later phase reads and writes (never a copy).
 */
import type { Assertion } from "@jevitate/recording";
import { checkAssertion } from "@jevitate/interpreter";
import type { Page } from "playwright";
import type { RequestCapture } from "../../page-monitor.js";
import { describeCheck, type SuccessCheck, type SuccessCheckResult } from "../../success-checks.js";
import { goalAsksForChange } from "../../read-only.js";
import { goalAsksForReport } from "../../answer.js";
import { resolveMinEffort } from "../../run-depth.js";
import { resolveBounds } from "../../bounds.js";
import type { GoalBasedMissionConfig } from "../goal-based.js";
import { HELD_CHECK_TIMEOUT_MS, type NetworkScope } from "./checks.js";
import type { DeclaredHooks } from "./declared-hooks.js";

/** The run's mutable tracking state: reset at the start of every attempt (#126), read by the verdict. */
export interface AdjudicationState {
  /** Under `held`: the first settled step at which every page check held together (1-based), or null. */
  heldAtStep: number | null;
  settledSteps: number;
  /**
   * #174: a held page check counts only once it CHANGED from not holding to holding — never because
   * it already held on the start page (a placeholder that is there before anything was done).
   */
  sawNotHolding: boolean;
  /** #174: the page checks all held on the start state, before any action (vacuous there). */
  heldAtStart: boolean;
  /** #202: when the run first acted (a control op or a chosen reload) — network checks count requests from here on. */
  firstActionAt: number | null;
  attempts: number;
}

/** Everything the phases share: the mission's inputs, what setup derived, and the mutable state. */
export interface Adjudication {
  readonly cfg: GoalBasedMissionConfig;
  readonly checks: readonly SuccessCheck[];
  readonly page: Page;
  readonly capture: RequestCapture | null;
  readonly declared: DeclaredHooks | null;
  readonly state: AdjudicationState;
  readonly pageChecks: SuccessCheck[];
  readonly held: boolean;
  readonly each: boolean;
  readonly eachSawNot: boolean[];
  readonly eachHeldAt: Array<number | null>;
  readonly eachHeldAtStart: boolean[];
  readonly pageIndexOf: (r: SuccessCheckResult) => number;
  readonly allowVacuous: boolean;
  readonly seedHeld: Set<number>;
  readonly changedSinceSeed: Set<number>;
  readonly scope: () => NetworkScope;
  readonly stateChecks: Array<[number, Extract<SuccessCheck, { kind: "page" | "reloadThen" }>]>;
  readonly holdsNow: (a: Assertion) => Promise<boolean>;
  readonly networkChecks: Array<Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }>>;
  readonly answerRequired: boolean;
  readonly stopWhenHeld: boolean;
  readonly hasChecks: boolean;
  readonly readOnly: boolean;
  readonly noDestructiveWrites: boolean;
  readonly effort: ReturnType<typeof resolveMinEffort>;
  readonly exploreBase: Omit<GoalBasedMissionConfig, "minEffort">;
}

export function setupAdjudication(
  cfg: GoalBasedMissionConfig,
  checks: readonly SuccessCheck[],
  page: Page,
  capture: RequestCapture | null,
  declared: DeclaredHooks | null,
): Adjudication {
  const pageChecks = checks.filter((c) => c.kind === "page");
  const state: AdjudicationState = { heldAtStep: null, settledSteps: 0, sawNotHolding: false, heldAtStart: false, firstActionAt: null, attempts: 0 };
  const held = cfg.successWhen === "held" && pageChecks.length > 0;
  /**
   * #337 `each`: per page check (by its index in `pageChecks`) — seen NOT holding at a settled step,
   * the first settled step it held at AFTER that (the transition), and whether it held on the start.
   */
  const each = cfg.successWhen === "each" && pageChecks.length > 0;
  const eachSawNot = pageChecks.map(() => false);
  const eachHeldAt: Array<number | null> = pageChecks.map(() => null);
  const eachHeldAtStart = pageChecks.map(() => false);
  const pageIndexOf = (r: SuccessCheckResult): number => pageChecks.findIndex((c) => describeCheck(c) === r.check);
  /**
   * #202 — the general rule behind #174, per check and under either `successWhen`: a page/reloadThen
   * check that held on the seed page (before any action) and was never seen NOT holding at a later
   * settled step cannot verify the goal. `seedHeld` — the checks (by index) that held on the seed
   * page; `changedSinceSeed` — those later seen not holding (no longer vacuous).
   */
  const allowVacuous = cfg.allowVacuousChecks === true;
  const seedHeld = new Set<number>();
  const changedSinceSeed = new Set<number>();
  const scope = (): NetworkScope => ({ firstActionAt: state.firstActionAt, allowVacuous });
  const stateChecks = [...checks.entries()].filter(
    (e): e is [number, Extract<SuccessCheck, { kind: "page" | "reloadThen" }>] => e[1].kind === "page" || e[1].kind === "reloadThen",
  );
  const holdsNow = (a: Assertion): Promise<boolean> =>
    checkAssertion(cfg.actor, a, { timeoutMs: HELD_CHECK_TIMEOUT_MS }).catch(() => false);
  const networkChecks = checks.filter(
    (c): c is Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }> => c.kind === "requestMade" || c.kind === "responseStatus",
  );
  // #174: under `held`, once every check has held the run stops — it never keeps acting (or writing)
  // past a met goal. `reloadThen` is final-only, so a run that declares one keeps the model's `done`.
  // #286: a goal that also asks for a report needs its grounded answer — checks holding never stop it.
  const answerRequired = checks.length > 0 && goalAsksForReport(cfg.goal);
  const stopWhenHeld = (cfg.successWhen === "held" || cfg.successWhen === "each") && checks.length > 0 && !checks.some((c) => c.kind === "reloadThen") && !answerRequired;
  // A find-out goal (#130d) has no page/network check to independently ground `done` with: it is
  // verified instead by a grounded `report` (#101), which `explore()` grounds on its own regardless
  // of `successCheck`. Leaving `successCheck` unset here (rather than wiring one that vacuously
  // "passes" over zero checks) sends `done` through the advisory goal-judgment path instead of a
  // false independent pass.
  const hasChecks = checks.length > 0;
  // #158 — a find-out goal is READ-ONLY unless its text asks for a change or `--allow-writes`:
  // independent code refuses write flows and aborts write requests; the model is told.
  const writesLifted = cfg.safety?.allowWrites === true;
  const readOnly = !hasChecks && !writesLifted && !goalAsksForChange(cfg.goal);
  // #270 — the goal's own words never lift the guard on a DESTRUCTIVE write ("Remove a product…"
  // clicked a member row's "Remove" → RemoveMember 200): only the operator can.
  const noDestructiveWrites = !hasChecks && !readOnly && !writesLifted && cfg.safety?.allowDestructive !== true;
  // #424: the minimum exploration effort before the model may conclude (never past the budget).
  const bounds = resolveBounds(cfg.bounds);
  const effort = resolveMinEffort({
    goal: cfg.goal,
    answerIsVerdict: !hasChecks || answerRequired,
    ...(cfg.minEffort === undefined ? {} : { request: cfg.minEffort }),
    maxActions: bounds.maxActions,
    maxDecisions: bounds.maxDecisions,
  });
  // The loop takes the RESOLVED minimum, never the request.
  const exploreBase: Omit<GoalBasedMissionConfig, "minEffort"> = { ...cfg };
  delete (exploreBase as { minEffort?: unknown }).minEffort;
  return {
    cfg,
    checks,
    page,
    capture,
    declared,
    state,
    pageChecks,
    held,
    each,
    eachSawNot,
    eachHeldAt,
    eachHeldAtStart,
    pageIndexOf,
    allowVacuous,
    seedHeld,
    changedSinceSeed,
    scope,
    stateChecks,
    holdsNow,
    networkChecks,
    answerRequired,
    stopWhenHeld,
    hasChecks,
    readOnly,
    noDestructiveWrites,
    effort,
    exploreBase,
  };
}
