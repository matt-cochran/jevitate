import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Snapshot } from "../snapshot.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

export type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" };

/**
 * Reset-and-replay: put a live Playwright session back into a frontier item's
 * source state, then verify (by fingerprint equality) that the replay actually
 * landed there — a mismatch is dropped as "stale" rather than guessed at
 * (guardrail #2, bounded + fail-closed). A live session can't teleport to an
 * earlier state; deterministic interpreter replay is the only way back.
 *
 * This is the ONE shared reset-and-replay body for BOTH exploration missions
 * (ticket #28). The two missions differ only in two injected policies:
 *
 *  - `seedUrl` — the induction / state-coverage mission re-navigates to the
 *    seed and then replays a seed-RELATIVE prefix (an empty prefix means the
 *    re-navigation IS the whole path, so the interpreter is skipped). The
 *    feature mission OMITS `seedUrl`: its `pathPrefix` is a SELF-CONTAINED
 *    Recording that begins with its own navigate step, so replaying it both
 *    navigates and drives to the source state.
 *  - `fingerprintOf` — must fingerprint the page the SAME way the mission built
 *    `item.fromFingerprint` (induction templates id-like url segments; the
 *    feature mission keys on the concrete url). Defaults to the coverage
 *    (templated) fingerprint.
 */
export async function reachFrontierState(params: {
  actor: Actor;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
  seedUrl?: string;
  fingerprintOf?: (snapshot: Snapshot) => string;
}): Promise<ReachResult> {
  const fingerprintOf = params.fingerprintOf ?? stateFingerprint;
  if (params.seedUrl !== undefined) {
    await params.actor.attemptsTo(Navigate.to(params.seedUrl));
    const stepCount = params.item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
    if (stepCount > 0) {
      await new RecordingInterpreter().run(params.actor, params.item.pathPrefix);
    }
  } else {
    await new RecordingInterpreter().run(params.actor, params.item.pathPrefix);
  }
  const snapshot = await params.snapshotNow();
  if (fingerprintOf(snapshot) !== params.item.fromFingerprint) return { ok: false, reason: "stale" };
  return { ok: true, snapshot };
}
