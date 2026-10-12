/** `createRunContext`: the transcript, the model's history and the demo overlay (#245) (#500: moved verbatim out of `context.ts`). */
import { demoOverlayFor } from "../../demo-overlay.js";
import { TranscriptLog } from "../../transcript.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initTranscript(ctx: MutableRunContext, cfg: ExploreConfig): void {
  ctx.transcript = new TranscriptLog(ctx.secrets, cfg.onTranscriptEntry);
  ctx.history = [];
  /** #245: the demo overlay (null unless `demoOverlay`) — display only, never an input to the loop. */
  ctx.overlay = demoOverlayFor(cfg.demoOverlay, ctx.secrets);
  ctx.overlayWhy = `goal: ${cfg.goal}`;
}
