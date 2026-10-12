// ux-usability/hang.ts — phase 4 of `runUsabilityMission` (#500): hang reproduction.
import { journeyFixtureBaseDir } from "../journey-api.js";
import type { BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { reproduceHang, hangFinding, type HangFinding, type VerifySession } from "@jevitate/explore";
import type { UsabilitySetup } from "./setup.js";
import type { UsabilityLoop } from "./loop.js";

/**
 * Opens a FRESH browser session for replays (hang reproduction): a new context from the same port
 * and options — same authenticated storageState, never the session the finding was made in.
 */
function freshSessionOpener(
  portFactory: () => BrowserPort,
  launch: Parameters<BrowserPort["open"]>[0],
  allowlist: readonly string[],
): () => Promise<VerifySession> {
  return async () => {
    const session = await portFactory().open(launch);
    const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [...allowlist]));
    return { page: session.page, actor, close: () => session.close() };
  };
}

/** Phase 4 — a run that stopped on a hang: reproduced in fresh contexts (`undefined` when it did not). */
export async function reproduceUsabilityHang(ctx: UsabilitySetup, run: UsabilityLoop["run"]) {
  const { opts, portFactory, launch } = ctx;
  // #126: a run that stops on a hang is never `clean` — it is reproduced in fresh contexts (same
  // as a goal mission) and mapped through the same hang/intermittent/inconclusive rule.
  let hang: HangFinding | undefined;
  if (run.stop === "hang" && run.hang !== undefined) {
    const h = run.hang;
    const reproduction = await reproduceHang({
      recording: run.recording,
      recordingStepIndex: h.recordingStepIndex,
      hang: h.signal,
      openSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      fixtureBaseDir: journeyFixtureBaseDir(),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      writtenBy: run.sideEffects.map((e) => e.control), // #181
      perceive: {
        ...(opts.target?.settle === undefined ? {} : { settleConfig: opts.target.settle }),
        ...(opts.target?.hangs === undefined ? {} : { hangConfig: opts.target.hangs }),
      },
    });
    hang = hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction);
  }
  return hang;
}
