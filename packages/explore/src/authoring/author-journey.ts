import type { Actor } from "@jevitate/screenplay";
import type { Assertion, AuthoringRecording, Recording } from "@jevitate/recording";
import { diffTakes, applyPostdoc } from "@jevitate/recording";
import type { GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import { deriveParamSchema } from "@jevitate/journey";
import type { Journey, JourneyMetadata, JourneyNetworkCheck } from "@jevitate/journey";
import { runGoalBasedMission } from "../missions/goal-based.js";
import type { Bounds } from "../bounds.js";
import type { SafetyConfig } from "../safety.js";
import { describeCheck, type SuccessCheck } from "../success-checks.js";
import { ValueCapturingGenerationPort } from "./value-capturing-generation-port.js";
import { autoDecidePostdoc } from "./auto-decide.js";
import { clock } from "@jevitate/domain";

export interface AuthorJourneyRequest {
  goal: string;
  /** A page assertion the discovery must reach (and the Journey's last step asserts). */
  successAssertion?: Assertion;
  /**
   * #322: more independent checks, ALL of which must hold with `successAssertion` — the goal
   * mission's own kinds. A `page` check becomes an `assert` step at the Journey's end, as
   * `successAssertion` does; a `requestMade`/`responseStatus` check becomes one of the Journey's
   * `networkChecks`, evaluated over its replay's own requests. `reloadThen` is refused (a Journey
   * cannot re-check after a reload yet). At least one check is required, from either field.
   */
  successChecks?: readonly SuccessCheck[];
  allowlist: readonly string[];
  /** Authorized start URL (must be on `allowlist`). */
  startUrl: string;
  bounds?: Partial<Bounds>;
  actor: Actor;
  judgment: JudgmentPort;
  generation: GenerationPort;
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

export type AuthorJourneyResult =
  | { outcome: "authored"; journey: Journey }
  | { outcome: "not-reached"; reason: string };

/**
 * Authors a Journey by Jev-driving. Runs the goal-based exploration mission
 * to discover a path (adjudicated by the caller-supplied `successAssertion` / `successChecks`
 * — Jev's own "done" judgment is never trusted, matching ticket #1's
 * independent-oracle guardrail), then feeds the resulting take(s) through
 * RxD's existing diff/postdoc pipeline to produce a fully-materialized,
 * replayable, parameterized `Recording`. Never auto-promotes: the returned
 * Journey's `metadata.promoted` is always `false`.
 */
export async function authorJourney(req: AuthorJourneyRequest): Promise<AuthorJourneyResult> {
  const takes = req.takes ?? 1;
  if (takes < 1) throw new Error("authorJourney: takes must be >= 1");
  const checks: SuccessCheck[] = [
    ...(req.successAssertion === undefined ? [] : [{ kind: "page" as const, assertion: req.successAssertion }]),
    ...(req.successChecks ?? []),
  ];
  if (checks.length === 0) throw new Error("authorJourney: a success check is required (successAssertion or successChecks)");
  const reload = checks.find((c) => c.kind === "reloadThen");
  if (reload !== undefined) {
    throw new Error(`authorJourney: ${describeCheck(reload)} can't be authored into a Journey yet — use a page check or a requestMade/responseStatus check`);
  }
  const mission = { successChecks: checks };

  const discoveryGeneration = new ValueCapturingGenerationPort(req.generation);
  const discovery = await runGoalBasedMission({
    goal: req.goal,
    ...mission,
    allowlist: req.allowlist,
    startUrl: req.startUrl,
    bounds: req.bounds,
    actor: req.actor,
    judge: req.judgment,
    gen: discoveryGeneration,
    ...(req.safety === undefined ? {} : { safety: req.safety }),
  });
  if (discovery.outcome !== "succeeded") {
    return { outcome: "not-reached", reason: `discovery mission ${discovery.outcome}` };
  }

  const authoringTakes: AuthoringRecording[] = [
    { recording: discovery.recording, values: discoveryGeneration.capturedValues(discovery.recording) },
  ];

  // Corroborating takes: replay toward the same goal `takes - 1` more times so
  // fields that vary across runs surface as confident variables (vs a single
  // take, which can only ever materialize constants). NOTE: ticket #1 has not
  // yet added the planned `seedRecording` param that would make each replay a
  // deterministic re-drive of the discovered path, so each additional take is
  // an independent re-exploration and structural alignment across takes is
  // best-effort. The CLI defaults to `takes: 1` (the fully-supported MVP); a
  // corroborating take that does not succeed is dropped, never fatal.
  for (let i = 1; i < takes; i++) {
    const replayGeneration = new ValueCapturingGenerationPort(req.generation);
    const replay = await runGoalBasedMission({
      goal: req.goal,
      ...mission,
      allowlist: req.allowlist,
      startUrl: req.startUrl,
      bounds: req.bounds,
      actor: req.actor,
      judge: req.judgment,
      gen: replayGeneration,
      ...(req.safety === undefined ? {} : { safety: req.safety }),
    });
    if (replay.outcome !== "succeeded") continue;
    authoringTakes.push({ recording: replay.recording, values: replayGeneration.capturedValues(replay.recording) });
  }

  const diff = diffTakes(authoringTakes);
  const decisions = autoDecidePostdoc(authoringTakes[0].recording, diff);
  const materializedRecording = applyPostdoc(authoringTakes[0], diff, decisions);

  // #118: the authored Journey's LAST step is always an `assert` on the independent success
  // condition that gated authoring — so a replay proves the outcome the goal was driving toward,
  // not just that navigation reached the final page. Jev's own "done" judgment is never trusted
  // (ticket #1); this bakes that same independent oracle into the artifact itself.
  // #322: every page check is asserted, in order; network checks go to `networkChecks`.
  const parameterizedRecording = checks.reduce(
    (r, c) => (c.kind === "page" ? appendSuccessAssertion(r, c.assertion) : r),
    materializedRecording,
  );
  const networkChecks: JourneyNetworkCheck[] = checks.flatMap((c): JourneyNetworkCheck[] =>
    c.kind === "requestMade"
      ? [{ kind: "requestMade", method: c.method, pathGlob: c.pathGlob }]
      : c.kind === "responseStatus"
        ? [{ kind: "responseStatus", method: c.method, pathGlob: c.pathGlob, status: { ...c.status } }]
        : [],
  );

  const metadata: JourneyMetadata = {
    id: req.journeyId,
    name: req.journeyName,
    promoted: false,
    params: deriveParamSchema(parameterizedRecording).required,
    authoredBy: "jev-driven",
    createdAtIso: clock.nowIso(),
    ...(networkChecks.length === 0 ? {} : { networkChecks }),
  };

  return { outcome: "authored", journey: { metadata, recording: parameterizedRecording } };
}

/**
 * Appends an `{ kind: "assert", check }` step to the LAST page's step list — the authored
 * Journey's final step (#118). A no-op-safe fallback when the recording somehow has no pages
 * (never expected past a successful discovery mission, which always emits at least one page).
 */
function appendSuccessAssertion(recording: Recording, check: Assertion): Recording {
  if (recording.pages.length === 0) return recording;
  const lastIndex = recording.pages.length - 1;
  return {
    ...recording,
    pages: recording.pages.map((page, i) =>
      i === lastIndex ? { ...page, steps: [...page.steps, { step: { kind: "assert", check } }] } : page,
    ),
  };
}
