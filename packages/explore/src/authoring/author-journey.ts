import type { Actor } from "@jevitate/screenplay";
import type { Assertion, AuthoringRecording } from "@jevitate/recording";
import { diffTakes, applyPostdoc } from "@jevitate/recording";
import type { GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import { deriveParamSchema } from "@jevitate/journey";
import type { Journey, JourneyMetadata } from "@jevitate/journey";
import { runGoalBasedMission } from "../missions/goal-based.js";
import type { Bounds } from "../bounds.js";
import { ValueCapturingGenerationPort } from "./value-capturing-generation-port.js";
import { autoDecidePostdoc } from "./auto-decide.js";

export interface AuthorJourneyRequest {
  goal: string;
  successAssertion: Assertion;
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
}

export type AuthorJourneyResult =
  | { outcome: "authored"; journey: Journey }
  | { outcome: "not-reached"; reason: string };

/**
 * Authors a Journey by Jev-driving. Runs the goal-based exploration mission
 * to discover a path (adjudicated by the caller-supplied `successAssertion`
 * — Jev's own "done" judgment is never trusted, matching ticket #1's
 * independent-oracle guardrail), then feeds the resulting take(s) through
 * RxD's existing diff/postdoc pipeline to produce a fully-materialized,
 * replayable, parameterized `Recording`. Never auto-promotes: the returned
 * Journey's `metadata.promoted` is always `false`.
 */
export async function authorJourney(req: AuthorJourneyRequest): Promise<AuthorJourneyResult> {
  const takes = req.takes ?? 1;
  if (takes < 1) throw new Error("authorJourney: takes must be >= 1");

  const discoveryGeneration = new ValueCapturingGenerationPort(req.generation);
  const discovery = await runGoalBasedMission({
    goal: req.goal,
    successAssertion: req.successAssertion,
    allowlist: req.allowlist,
    startUrl: req.startUrl,
    bounds: req.bounds,
    actor: req.actor,
    judge: req.judgment,
    gen: discoveryGeneration,
  });
  if (discovery.outcome !== "succeeded") {
    return { outcome: "not-reached", reason: `discovery mission ${discovery.outcome}` };
  }

  const authoringTakes: AuthoringRecording[] = [
    { recording: discovery.recording, values: discoveryGeneration.capturedValues(discovery.recording) },
  ];

  const diff = diffTakes(authoringTakes);
  const decisions = autoDecidePostdoc(authoringTakes[0].recording, diff);
  const parameterizedRecording = applyPostdoc(authoringTakes[0], diff, decisions);

  const metadata: JourneyMetadata = {
    id: req.journeyId,
    name: req.journeyName,
    promoted: false,
    params: deriveParamSchema(parameterizedRecording).required,
    authoredBy: "jev-driven",
    createdAtIso: new Date().toISOString(),
  };

  return { outcome: "authored", journey: { metadata, recording: parameterizedRecording } };
}
