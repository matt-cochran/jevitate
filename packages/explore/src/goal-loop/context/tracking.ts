/** `createRunContext`: the run's bounds and trackers, fill helper, recorder, page, crash watch and heap log (#500: moved verbatim out of `context.ts`). */
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { BoundsTracker, NoProgressDetector, resolveBounds } from "../../bounds.js";
import { FillHelper } from "../../fill.js";
import { RunRecorder } from "../../record.js";
import { CrashWatch } from "../../mission-failure.js";
import { HeapLog } from "../../crash-report.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initTracking(ctx: MutableRunContext, cfg: ExploreConfig): void {
  ctx.bounds = resolveBounds(cfg.bounds);
  ctx.tracker = new BoundsTracker(ctx.bounds);
  ctx.noProgress = new NoProgressDetector(3);
  ctx.fillHelper = new FillHelper(cfg.gen, cfg.identityToken === undefined ? {} : { identityToken: cfg.identityToken });
  ctx.recorder = new RunRecorder(cfg.site ?? ctx.startOrigin, undefined, ctx.secrets, cfg.onRecording);
  ctx.page = cfg.actor.ability(BrowseTheWebToken).session.page;
  ctx.crashWatch = new CrashWatch(ctx.page);
  ctx.heap = new HeapLog();
}
