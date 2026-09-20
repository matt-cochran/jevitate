import type { Actor } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Snapshot } from "../snapshot.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

/**
 * Reset-and-replay: put the browser back into a frontier item's source state
 * by replaying its `pathPrefix` Recording, then confirm we actually landed
 * there by re-fingerprinting the live page. A mismatch means the app is
 * non-deterministic or the path went stale — the item is skipped, never
 * expanded on a wrong assumption (fail-closed).
 *
 * DEVIATION from the plan's Task 2: the plan's `reachFrontierState` took a
 * separate `seedUrl` + `page` and did an explicit `Navigate.to(seedUrl)`
 * before replaying a *seed-relative* prefix. Here the `pathPrefix` is a
 * SELF-CONTAINED Recording (it begins with its own `navigate` step), so
 * replaying it via the real `RecordingInterpreter` both navigates and drives
 * to the source state — the same Recording that is also emitted as a leaf, so
 * "reach" and "the artifact" can never diverge.
 */

export type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" };

export async function reachFrontierState(params: {
  actor: Actor;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
}): Promise<ReachResult> {
  await new RecordingInterpreter().run(params.actor, params.item.pathPrefix);
  const snapshot = await params.snapshotNow();
  if (stateFingerprint(snapshot) !== params.item.fromFingerprint) return { ok: false, reason: "stale" };
  return { ok: true, snapshot };
}
