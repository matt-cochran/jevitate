import type { Actor } from "@jevitate/screenplay";
import type { Snapshot } from "../snapshot.js";
import { reachFrontierState as coverageReach, type ReachResult } from "../coverage/reach.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

export type { ReachResult };

/**
 * Feature-mission reach — a THIN adapter over the shared coverage reset-and-
 * replay body (ticket #28 de-dup). It binds the two feature-specific policies:
 *
 *  - NO `seedUrl`: the `pathPrefix` is a SELF-CONTAINED Recording (it begins
 *    with its own navigate step), so replaying it both navigates and drives to
 *    the source state — the same Recording that is also emitted as a leaf, so
 *    "reach" and "the artifact" can never diverge.
 *  - the CONCRETE-url `fingerprintOf` (see `feature/fingerprint.ts`), so the
 *    landed-there check matches how the feature mission built
 *    `item.fromFingerprint`.
 */
export function reachFrontierState(params: {
  actor: Actor;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
  homeUrl?: string;
  currentUrl?: () => string;
  timeoutMs?: number;
}): Promise<ReachResult> {
  return coverageReach({ ...params, fingerprintOf: stateFingerprint });
}
