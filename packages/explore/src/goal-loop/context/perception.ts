/** `createRunContext`: reply/wait limits, seen states, the last mutation and the perception options (#192) (#500: moved verbatim out of `context.ts`). */
import { textMatcher } from "../../settle-config.js";
import { DEFAULT_STALL_MS } from "../../hang-repro.js";
import { REPLY_CEILING_MS, REPLY_QUIET_MS, REPLY_WAIT_MS } from "../../conversation.js";
import { REPLY_MAX_CHARS, WAIT_OP_MS } from "../limits.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initPerception(ctx: MutableRunContext, cfg: ExploreConfig): void {
  ctx.replyWaitMs = cfg.replyWaitMs ?? REPLY_WAIT_MS;
  ctx.replyQuietMs = cfg.replyQuietMs ?? REPLY_QUIET_MS;
  ctx.replyCeilingMs = Math.max(ctx.replyWaitMs, cfg.replyCeilingMs ?? REPLY_CEILING_MS);
  ctx.replyMaxChars = cfg.replyMaxChars ?? REPLY_MAX_CHARS;
  ctx.waitOpMs = cfg.waitOpMs ?? WAIT_OP_MS;
  /** Every page state seen so far (for "the action sent the page back to an earlier state"). */
  ctx.seen = new Set<string>();
  /** The last executed page-changing action: when, from which state, and its Recording index. */
  ctx.track = { lastMutation: null, lastRecordedTarget: null };
  // #192: an option the goal names (a country, a currency) is perceived even deep in a long list.
  ctx.goalText = cfg.goal.toLowerCase();
  ctx.perceiveOpts = {
    maxCandidates: ctx.bounds.maxCandidates,
    mentioned: (name: string) => name.trim().length >= 2 && ctx.goalText.includes(name.trim().toLowerCase()),
    // #219: page content is redacted of every registered secret as it is perceived.
    secrets: ctx.secrets,
    ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
    ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
    ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
    ...(cfg.settle === undefined ? {} : { settleConfig: cfg.settle }),
    ...(cfg.hangs === undefined ? {} : { hangConfig: cfg.hangs }),
    ...(cfg.timingConfig === undefined ? {} : { timingConfig: cfg.timingConfig }),
  };
  ctx.ignoreNoProgress = textMatcher(cfg.hangs?.ignoreNoProgress);
  ctx.stallMs = cfg.stallMs ?? DEFAULT_STALL_MS;
}
