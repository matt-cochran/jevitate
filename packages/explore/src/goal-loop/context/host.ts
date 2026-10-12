/** `createRunContext`: the host probe and judgment (#203), degraded stops, liveness (#230) and the clock read (#500: moved verbatim out of `context.ts`). */
import { isAuthorizedExploreTarget } from "../../authorized-targets.js";
import { hostProbe } from "../../host-pressure.js";
import type { HostJudgment } from "../../host-health.js";
import { clock } from "@jevitate/domain";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initHost(ctx: MutableRunContext, cfg: ExploreConfig): void {
  ctx.probeHost = cfg.hostProbe ?? hostProbe();
  /** #203: the fresh host sample around a finding, and whether the run's sampler calls it starved. */
  ctx.judgeHost = async (): Promise<HostJudgment> =>
    cfg.hostHealth === undefined ? { host: await ctx.probeHost(), starved: null } : cfg.hostHealth.judge();
  /** #203: a finding the starved host explains ends the run `inconclusive`, never as a hang. */
  ctx.degradedStop = (finding: "hang" | "no-progress", detail: string, starved: string): void => {
    cfg.hostHealth?.markDegraded({ finding, detail, step: Math.max(0, ctx.transcript.entries().length - 1) }, starved);
    ctx.failure = {
      kind: "degraded-environment",
      message: `environment-degraded ${finding} (${detail}) while the host was starved: ${starved} — not an app finding`,
    };
    ctx.stop = "inconclusive";
  };
  /**
   * #230: before a hang/no-progress is a finding (or blamed on a starved host), did the app itself
   * stop answering? Throws `TargetUnresponsiveError` (→ `inconclusive` / `target-unresponsive`).
   */
  ctx.livenessOf = () => ({
    pageUrl: ctx.page.url(),
    authorized: (u: string) => isAuthorizedExploreTarget(u, cfg.allowlist),
  });
  ctx.now = (): number => clock.now();
}
