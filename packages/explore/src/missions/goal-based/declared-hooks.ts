/** The declared-invariant hooks' shape (#500: moved verbatim out of `goal-based.ts`). */
import type { ExploreConfig, ExploreRun } from "../../explore.js";
import type { GoalBasedResult } from "../goal-based.js";

/**
 * Declared invariants (#86) through the loop's own hooks: the transcript names each action, the
 * Recording its step index, and every settled snapshot evaluates the action(s) since the previous
 * one (then re-arms the "before" for the next). An action the loop took but never re-observed (the
 * run ended right after it) is evaluated on the final page once it settles.
 */
export interface DeclaredHooks {
  readonly onTranscriptEntry: NonNullable<ExploreConfig["onTranscriptEntry"]>;
  readonly onRecording: NonNullable<ExploreConfig["onRecording"]>;
  readonly onBeforeAction: ExploreConfig["onBeforeAction"];
  readonly onSettled: ExploreConfig["onSettled"];
  readonly settled: () => Promise<void>;
  readonly finish: (run: ExploreRun) => Promise<void>;
  readonly fold: (result: GoalBasedResult) => GoalBasedResult;
}
