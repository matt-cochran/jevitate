/** `createRunContext`: the read-only guard (#158) and the job / overlay / hang-work wait budgets (#500: moved verbatim out of `context.ts`). */
import { ReadOnlyGuard } from "../../read-only.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initGuards(ctx: MutableRunContext, cfg: ExploreConfig): void {
  /** A find-out goal's read-only guard (#158), or null when the run may write. */
  ctx.readOnly = cfg.readOnly === true || cfg.noDestructiveWrites === true
      ? new ReadOnlyGuard(ctx.isWrite, {
          mode: cfg.readOnly === true ? "read-only" : "no-destructive",
          // #194: only writes to the app's own origins are blocked; a third-party beacon passes (listed).
          allowlist: cfg.allowlist,
          firstParty: ctx.firstParty,
          ...(cfg.safety?.allowWriteRequests === undefined ? {} : { allowWrites: cfg.safety.allowWriteRequests }),
        })
      : null;
  ctx.jobWaitMs = cfg.jobWaitMs ?? ctx.replyCeilingMs;
  ctx.jobWaitExplicit = cfg.jobWaitMs !== undefined;
  /** How long `wait`s have waited on the in-progress status the page shows (bounded by `jobWaitMs`). */
  ctx.jobWaitedMs = 0;
  ctx.overlayWaitedMs = 0;
  /**
   * How long a hang signal has been deferred because the page is visibly WORKING (#153): never reset,
   * so a page that keeps "working" is still reported as a hang once the job-wait budget is spent.
   */
  ctx.hangWorkWaitedMs = 0;
  /** #258: the longest wait the page has documented this run (its budget, ms); 0 when none. */
  ctx.documentedBudgetMs = 0;
}
