import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Snapshot } from "../index.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

export type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" };

/**
 * A live Playwright session can't teleport to an earlier state — the only
 * deterministic way back is reset-to-seed + interpreter replay of the exact
 * recorded prefix. Verifies the replay actually landed where the frontier item
 * expected (fingerprint equality); a mismatch is dropped as "stale" rather than
 * guessed at (guardrail #2, bounded + fail-closed).
 *
 * An empty prefix (a state reachable from the seed with no further steps) skips
 * the interpreter entirely — the re-navigation IS the whole path.
 */
export async function reachFrontierState(params: {
  page: Page;
  actor: Actor;
  seedUrl: string;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
}): Promise<ReachResult> {
  await params.actor.attemptsTo(Navigate.to(params.seedUrl));
  const stepCount = params.item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
  if (stepCount > 0) {
    await new RecordingInterpreter().run(params.actor, params.item.pathPrefix);
  }
  const snapshot = await params.snapshotNow();
  if (stateFingerprint(snapshot) !== params.item.fromFingerprint) return { ok: false, reason: "stale" };
  return { ok: true, snapshot };
}
