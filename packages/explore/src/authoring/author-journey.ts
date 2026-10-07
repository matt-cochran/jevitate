import type { Actor } from "@jevitate/screenplay";
import type { Assertion, AuthoringRecording, OutcomeCheck, PostdocDecision, Recording } from "@jevitate/recording";
import { diffTakes, applyPostdoc, flattenBaseFillSteps } from "@jevitate/recording";
import type { GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import { deriveParamSchema } from "@jevitate/journey";
import type { Journey, JourneyMetadata, JourneyParameter } from "@jevitate/journey";
import { runGoalBasedMission, type GoalBasedResult } from "../missions/goal-based.js";
import type { Bounds, StopReason } from "../bounds.js";
import type { SafetyConfig } from "../safety.js";
import type { RunOutcome } from "../conversation.js";
import type { SuccessCheck, SuccessCheckResult } from "../success-checks.js";
import { deriveStepExpectations } from "./step-expectations.js";
import { autoDecidePostdoc } from "./auto-decide.js";
import { clock, type MissionFailure } from "@jevitate/domain";

/**
 * #369: what one authoring take (the discovery run, or a corroborating one) left behind — enough to
 * see WHY a take did not reach the goal without re-running it: the concrete reason (which check,
 * guard or control stopped it), how the loop ended, each check's verdict, and — when the take ran as a
 * full goal run (`runTake`, the CLI) — where its result, transcript, Recording(s) and screenshots are.
 */
export interface AuthorTakeDiagnostics {
  /** The take's goal outcome (succeeded / failed / blocked / exhausted / inconclusive / …). */
  readonly outcome: string;
  /** Why it did not succeed, in one line (the goal run's own `reason`, else its failure's message). */
  readonly reason?: string;
  /** How the loop ended (done / blocked / exhausted / no-progress / hang / budget / …). */
  readonly stop?: StopReason;
  /** The loop's own account: completed (verified by …) or incomplete + why. */
  readonly runOutcome?: RunOutcome;
  /** The typed cause (kind + message; never a stack). */
  readonly failure?: { readonly kind: string; readonly message: string };
  /** Each success check's verdict and what the oracle saw. */
  readonly checks?: readonly SuccessCheckResult[];
  readonly decisions?: number;
  readonly actions?: number;
  readonly finalUrl?: string;
  /** The take's persisted typed result (`<recording>.result.json`). */
  readonly resultPath?: string;
  /** The per-decision trail (`<recording>.transcript.json`). */
  readonly transcriptPath?: string;
  /** Every Recording the take wrote. */
  readonly recordingPaths?: readonly string[];
  /** The take's `--screenshots` folder, when it took screenshots. */
  readonly screenshotsDir?: string;
}

/** One take, as `authorJourney` consumes it. */
export interface AuthorTake {
  readonly outcome: string;
  readonly recording: Recording;
  readonly diagnostics: AuthorTakeDiagnostics;
}

/**
 * #369: runs ONE take toward the goal (`index` 0 is the discovery). The CLI supplies a full goal run
 * (the same runner, flags and artifacts as `jevitate explore --strategy goal`); absent, the take is
 * the in-process goal mission on `actor`.
 */
export type AuthorTakeRunner = (take: { readonly index: number; readonly goal: string; readonly successChecks: readonly SuccessCheck[] }) => Promise<AuthorTake>;

export interface AuthorJourneyRequest {
  goal: string;
  /** A page assertion the discovery must reach (kept as the Journey's first end-state assertion). */
  successAssertion?: Assertion;
  /**
   * #322/#400: more independent checks, ALL of which must hold with `successAssertion` — the goal
   * mission's own kinds (`page`, `reloadThen`, `requestMade`, `responseStatus`). Every one is kept,
   * in order, as the Journey's `metadata.endState`, judged after its last step on each replay. At
   * least one check is required, from either field.
   */
  successChecks?: readonly SuccessCheck[];
  allowlist: readonly string[];
  /** Authorized start URL (must be on `allowlist`). */
  startUrl: string;
  bounds?: Partial<Bounds>;
  /** The in-process take's actor, judgment and generation — required unless `runTake` is given. */
  actor?: Actor;
  judgment?: JudgmentPort;
  generation?: GenerationPort;
  /** #369: runs each take (see `AuthorTakeRunner`); replaces the in-process goal mission. */
  runTake?: AuthorTakeRunner;
  /**
   * Total takes, including the discovery take. Default 1 (single-take,
   * fully-constant authoring). Values > 1 replay the discovered path to
   * corroborate which fields vary — see the corroboration loop below.
   */
  takes?: number;
  journeyId: string;
  journeyName: string;
  /**
   * The shared safety policy (#116) for the exploration (#249: the target's `safety` from
   * targets.json). Absent: the built-in policy — paid, destructive and session-ending controls refused.
   */
  safety?: SafetyConfig;
}

/** #369: how many takes were asked for, run, and reached the goal. */
export interface AuthorTakeCounts {
  readonly requested: number;
  readonly run: number;
  readonly succeeded: number;
}

export type AuthorJourneyResult =
  | {
      outcome: "authored";
      journey: Journey;
      /** #369: the discovery take's diagnostics (where its artifacts are). */
      discovery?: AuthorTakeDiagnostics;
      takes?: AuthorTakeCounts;
      /** #369: every corroborating take's diagnostics, in order (only with takes > 1). */
      corroboratingTakes?: AuthorTakeDiagnostics[];
    }
  | {
      outcome: "not-reached";
      /** `discovery mission <outcome>: <the concrete reason>`. */
      reason: string;
      /** #369: the discovery take's diagnostics — its stop reason and artifact paths. */
      discovery?: AuthorTakeDiagnostics;
      takes?: AuthorTakeCounts;
    };

/** The in-process take's diagnostics (no artifacts: nothing is written). */
export function goalResultDiagnostics(r: GoalBasedResult): AuthorTakeDiagnostics {
  const failure: MissionFailure | undefined = r.run.failure ?? r.failure;
  const reason = r.reason ?? failure?.message;
  return {
    outcome: r.outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(r.run.stop === undefined ? {} : { stop: r.run.stop }),
    ...(r.run.outcome === undefined ? {} : { runOutcome: r.run.outcome }),
    ...(failure === undefined ? {} : { failure: { kind: failure.kind, message: failure.message } }),
    ...(r.checks === undefined ? {} : { checks: r.checks }),
    ...(r.run.decisions === undefined ? {} : { decisions: r.run.decisions }),
    ...(r.run.actions === undefined ? {} : { actions: r.run.actions }),
    ...(r.finalUrl === undefined ? {} : { finalUrl: r.finalUrl }),
  };
}

/**
 * Authors a Journey by Jev-driving. Runs the goal-based exploration mission
 * to discover a path (adjudicated by the caller-supplied `successAssertion` / `successChecks`
 * — Jev's own "done" judgment is never trusted, matching ticket #1's
 * independent-oracle guardrail), then feeds the resulting take(s) through
 * RxD's existing diff/postdoc pipeline to produce a fully-materialized,
 * replayable, parameterized `Recording`. Never auto-promotes: the returned
 * Journey's `metadata.promoted` is always `false`.
 *
 * #369: a field code typed itself (a `--secret-field`/`--totp` binding, or a value holding a run
 * secret — recorded `{ redacted: true }`) has no value the Journey may keep: it becomes a SECRET
 * parameter (`secret1`, `secret2`, …, declared `secret: true`) supplied with `--param` at replay.
 */
export async function authorJourney(req: AuthorJourneyRequest): Promise<AuthorJourneyResult> {
  const takes = req.takes ?? 1;
  if (takes < 1) throw new Error("authorJourney: takes must be >= 1");
  const checks: SuccessCheck[] = [
    ...(req.successAssertion === undefined ? [] : [{ kind: "page" as const, assertion: req.successAssertion }]),
    ...(req.successChecks ?? []),
  ];
  if (checks.length === 0) throw new Error("authorJourney: a success check is required (successAssertion or successChecks)");
  const runTake: AuthorTakeRunner = req.runTake ?? inProcessTake(req);

  const discovery = await runTake({ index: 0, goal: req.goal, successChecks: checks });
  if (discovery.outcome !== "succeeded") {
    const why = discovery.diagnostics.reason;
    return {
      outcome: "not-reached",
      reason: `discovery mission ${discovery.outcome}${why === undefined ? "" : `: ${why}`}`,
      discovery: discovery.diagnostics,
      takes: { requested: takes, run: 1, succeeded: 0 },
    };
  }

  const authoringTakes: AuthoringRecording[] = [authoringTake(discovery.recording)];
  const corroborating: AuthorTakeDiagnostics[] = [];

  // Corroborating takes: replay toward the same goal `takes - 1` more times so
  // fields that vary across runs surface as confident variables (vs a single
  // take, which can only ever materialize constants). NOTE: ticket #1 has not
  // yet added the planned `seedRecording` param that would make each replay a
  // deterministic re-drive of the discovered path, so each additional take is
  // an independent re-exploration and structural alignment across takes is
  // best-effort. The CLI defaults to `takes: 1` (the fully-supported MVP); a
  // corroborating take that does not succeed is dropped, never fatal.
  for (let i = 1; i < takes; i++) {
    const replay = await runTake({ index: i, goal: req.goal, successChecks: checks });
    corroborating.push(replay.diagnostics);
    if (replay.outcome !== "succeeded") continue;
    authoringTakes.push(authoringTake(replay.recording));
  }

  const diff = diffTakes(authoringTakes);
  const base = authoringTakes[0];
  const secretSteps = secretFillSteps(base.recording);
  const secretParams: JourneyParameter[] = [];
  const decisions: PostdocDecision[] = autoDecidePostdoc(base.recording, diff).map((d) => {
    const key = `${d.step.page}:${d.step.step}`;
    if (!secretSteps.has(key)) return d;
    const name = `secret${secretParams.length + 1}`;
    secretParams.push({
      name,
      secret: true,
      description: "a value code typed during authoring (a --secret-field/--totp binding, or one holding a --secret) — never kept in the Journey; pass it with --param at replay",
    });
    return { step: d.step, classify: "variable", name };
  });
  const materializedRecording = applyPostdoc(base, diff, decisions);

  // #118/#400: the authored Journey proves the outcome the goal was driving toward, not just that
  // navigation reached the final page. Every success check that gated authoring (all of them held:
  // the discovery succeeded) is kept, as given, as an END-STATE assertion — every kind a goal run
  // takes, `reloadThen` included — and `journey run` judges them with the goal run's own evaluator.
  // Jev's own "done" judgment is never trusted (ticket #1); this bakes the independent oracle into
  // the artifact itself.
  // #400: each step's `expect` comes from what it changed (its write's status, the text it added),
  // never from its own target.
  const parameterizedRecording = deriveStepExpectations(materializedRecording, {
    ...(req.safety?.readRequests === undefined ? {} : { readRequests: req.safety.readRequests }),
  });
  const endState: OutcomeCheck[] = checks.map((c) => structuredClone(c));

  const metadata: JourneyMetadata = {
    id: req.journeyId,
    name: req.journeyName,
    promoted: false,
    params: deriveParamSchema(parameterizedRecording).required,
    authoredBy: "jev-driven",
    createdAtIso: clock.nowIso(),
    endState,
    ...(secretParams.length === 0 ? {} : { parameters: secretParams }),
  };

  return {
    outcome: "authored",
    journey: { metadata, recording: parameterizedRecording },
    discovery: discovery.diagnostics,
    takes: { requested: takes, run: takes, succeeded: authoringTakes.length },
    ...(corroborating.length === 0 ? {} : { corroboratingTakes: corroborating }),
  };
}

/** The default take: the goal mission in process, on the request's own actor. */
function inProcessTake(req: AuthorJourneyRequest): AuthorTakeRunner {
  const { actor, judgment, generation } = req;
  if (actor === undefined || judgment === undefined || generation === undefined) {
    throw new Error("authorJourney: actor, judgment and generation are required without runTake");
  }
  return async ({ goal, successChecks }) => {
    const r = await runGoalBasedMission({
      goal,
      successChecks,
      allowlist: req.allowlist,
      startUrl: req.startUrl,
      bounds: req.bounds,
      actor,
      judge: judgment,
      gen: generation,
      ...(req.safety === undefined ? {} : { safety: req.safety }),
    });
    return { outcome: r.outcome, recording: r.recording, diagnostics: goalResultDiagnostics(r) };
  };
}

/** A placeholder authoring value for a code-typed (redacted) step — never materialized: such a step always becomes a secret parameter. */
const SECRET_PLACEHOLDER = "\u0000jevitate:code-typed-secret";

/**
 * One take's authoring values, read from its Recording: a model-typed fill/select is recorded in the
 * clear (`{ redacted: false, value }`) and IS its value. A code-typed one (`{ redacted: true }`) has
 * no value to keep: it gets a placeholder so the diff stays aligned, and becomes a secret parameter.
 */
function authoringTake(recording: Recording): AuthoringRecording {
  const values = new Map<string, string>();
  recording.pages.forEach((page, p) =>
    page.steps.forEach(({ step }, i) => {
      if (step.kind !== "fill" && step.kind !== "select") return;
      const v = step.value;
      if ("var" in v) return;
      values.set(`${p}:${i}`, v.redacted ? SECRET_PLACEHOLDER : v.value);
    }),
  );
  return { recording, values };
}

/** The `page:step` keys of the fill/select steps whose value is redacted (code typed it). */
function secretFillSteps(recording: Recording): Set<string> {
  const keys = new Set<string>();
  for (const { ref } of flattenBaseFillSteps(recording)) {
    const { step } = recording.pages[ref.page].steps[ref.step];
    if ((step.kind === "fill" || step.kind === "select") && "redacted" in step.value && step.value.redacted) keys.add(`${ref.page}:${ref.step}`);
  }
  return keys;
}
