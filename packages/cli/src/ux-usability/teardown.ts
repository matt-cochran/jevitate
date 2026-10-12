// ux-usability/teardown.ts — phase 7 of `runUsabilityMission` (#500): teardown on every exit path.
import type { UsabilitySetup } from "./setup.js";

/** Phase 7 — teardown, on every exit path (the orchestrator's `finally`): listeners, kill switch, host sampler, log sources, session. */
export async function tearDownUsabilityMission(ctx: UsabilitySetup): Promise<void> {
  const { capture, disarmKillSwitch, health, serverLog, closeSession } = ctx;
  capture.detach();
  disarmKillSwitch();
  health.stop();
  // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
  // (no drain wait) rather than leaving them open until process exit.
  await serverLog?.abort();
  // #159: reaches this even when the mission above threw — the context is still open here.
  await closeSession();
}
