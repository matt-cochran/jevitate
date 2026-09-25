import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Snapshot } from "../snapshot.js";
import { seedRedirectReason } from "../seed-redirect.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

/**
 * Why a reset-and-replay did not land on the item's state:
 *
 *  - `stale` — the replay ran but the page fingerprints differently (the UI moved on); drop the item.
 *  - `seed-unreachable` — re-navigating to the seed was redirected elsewhere (a session lost after a
 *    "Sign out", a login bounce): no queued item can be reached any more (#114).
 *  - `timeout` — the reset did not finish within its bound (a seed that stopped responding) (#114).
 *
 * A seed that loaded but whose prefix replay then failed or ran out the bound is `stale` (#183): that
 * one path is gone, the seed is fine — dropping the item never ends the run.
 */
export type ReachFailure = "stale" | "seed-unreachable" | "timeout";

export type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: ReachFailure; detail?: string };

/** Default bound (ms) on one whole reset-and-replay — navigate, replay and re-perceive (#114). */
export const DEFAULT_REACH_TIMEOUT_MS = 45_000;
/** How long one replayed step's recorded target may take to appear during a reset (the interpreter's default is 15s). */
const REACH_TARGET_TIMEOUT_MS = 10_000;

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
 *
 * Bounded (#114): the whole reset is time-boxed (`timeoutMs`), and with `homeUrl` + `currentUrl`
 * the landing right after the seed navigation is checked — a seed that now redirects elsewhere
 * (the session was lost after a departure) fails fast as `seed-unreachable` instead of replaying,
 * and waiting out, every queued item's steps against a login page.
 */
export async function reachFrontierState(params: {
  actor: Actor;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
  seedUrl?: string;
  fingerprintOf?: (snapshot: Snapshot) => string;
  /** The seed the mission started from — a landing elsewhere after the seed navigation is `seed-unreachable`. */
  homeUrl?: string;
  /** The page's current URL (cheap; no perception) — read right after the seed navigation. */
  currentUrl?: () => string;
  /** Bound (ms) on the whole reset. Default `DEFAULT_REACH_TIMEOUT_MS`. */
  timeoutMs?: number;
}): Promise<ReachResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_REACH_TIMEOUT_MS;
  const phase: ReachPhase = { seedLoaded: false, steps: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ReachResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          phase.seedLoaded
            ? // #183: the seed answered; only this item's prefix replay is slow or stale — drop it.
              { ok: false, reason: "stale", detail: `the seed loaded, but replaying the path to this state did not finish within ${timeoutMs}ms (${phase.steps} step(s))` }
            : { ok: false, reason: "timeout", detail: `the reset to the seed did not finish within ${timeoutMs}ms` },
        ),
      timeoutMs,
    );
  });
  try {
    // `Promise.race` subscribes to the reset, so a rejection after the timeout won is handled.
    return await Promise.race([reach(params, phase), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** How far a reset got — read when its bound runs out (#183). */
interface ReachPhase {
  seedLoaded: boolean;
  /** Prefix steps to replay after the seed. */
  steps: number;
}

async function reach(params: {
  actor: Actor;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
  seedUrl?: string;
  fingerprintOf?: (snapshot: Snapshot) => string;
  homeUrl?: string;
  currentUrl?: () => string;
}, phase: ReachPhase): Promise<ReachResult> {
  const fingerprintOf = params.fingerprintOf ?? stateFingerprint;
  const interpreter = new RecordingInterpreter({ targetTimeoutMs: REACH_TARGET_TIMEOUT_MS });
  const seedLanding = (): ReachResult | null => {
    if (params.homeUrl === undefined || params.currentUrl === undefined) return null;
    const redirect = seedRedirectReason(params.homeUrl, params.currentUrl());
    return redirect === null ? null : { ok: false, reason: "seed-unreachable", detail: redirect.reason };
  };
  const stepCount = params.item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
  phase.steps = stepCount;
  // #183: once the seed has loaded, a prefix that throws makes this ITEM stale, never the seed
  // unreachable. A replay that reports a failed step still gets the fingerprint check (a failed
  // no-op step may land on the state anyway); its failure only explains a mismatch.
  let replayNote: string | undefined;
  const replayPrefix = async (run: () => Promise<{ readonly outcome: string; readonly at?: number; readonly error?: string }>): Promise<ReachResult | null> => {
    try {
      const r = await run();
      if (r.outcome === "failed") replayNote = `step ${(r.at ?? 0) + 1}: ${(r.error ?? "").split("\n")[0] ?? ""}`;
      return null;
    } catch (e) {
      return { ok: false, reason: "stale", detail: `the seed loaded, but replaying the path to this state failed: ${e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e)}` };
    }
  };
  if (params.seedUrl !== undefined) {
    await params.actor.attemptsTo(Navigate.to(params.seedUrl));
    const lost = seedLanding();
    if (lost !== null) return lost;
    phase.seedLoaded = true;
    if (stepCount > 0) {
      const failed = await replayPrefix(() => interpreter.run(params.actor, params.item.pathPrefix));
      if (failed !== null) return failed;
    }
  } else if (params.homeUrl !== undefined && stepCount > 0) {
    // A self-contained path: its first step is the seed navigate — check where that landed first.
    const first = await interpreter.runToCheckpoint(params.actor, params.item.pathPrefix, 0);
    const lost = seedLanding();
    if (lost !== null) return lost;
    if (first.outcome === "completed") phase.seedLoaded = true;
    if (first.outcome === "completed" && stepCount > 1) {
      const failed = await replayPrefix(() => interpreter.resumeFrom(params.actor, params.item.pathPrefix, 1));
      if (failed !== null) return failed;
    }
  } else {
    await interpreter.run(params.actor, params.item.pathPrefix);
  }
  const snapshot = await params.snapshotNow();
  if (fingerprintOf(snapshot) !== params.item.fromFingerprint) {
    return replayNote === undefined
      ? { ok: false, reason: "stale" }
      : { ok: false, reason: "stale", detail: `the seed loaded, but replaying the path to this state failed at ${replayNote}` };
  }
  return { ok: true, snapshot };
}
