/** `createRunContext`: sign-in / save progress (#188, #225), idle and reply waits (#373) and revisits (#500: moved verbatim out of `context.ts`). */
import { AuthProgress } from "../../auth-completion.js";
import { SaveProgress } from "../../save-completion.js";
import { goalListsSeveral } from "../../fill.js";
import { boundSecretField } from "../../secret-fields.js";
import type { Control } from "../../snapshot.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initProgress(ctx: MutableRunContext, cfg: ExploreConfig): void {
  /** The run's own sign-in steps and the sign-in completion code observes on each state (#188). */
  ctx.auth = new AuthProgress();
  /** #225: the run's own typed-and-submitted form values, for the code-observed save signal. */
  ctx.save = new SaveProgress();
  ctx.isBound = (c: Control): boolean => boundSecretField(c, cfg.secretFields) !== null;
  ctx.idleSteps = 0;
  ctx.idleSince = null;
  /** How long consecutive `wait`s have waited on a still-busy app (bounded by `replyWaitMs`). */
  ctx.busyWaitedMs = 0;
  ctx.replyWaitedMs = 0;
  /** The last message sent got no reply yet (a slow LLM turn): `wait`s are patience, bounded. */
  ctx.awaitingReply = false;
  /** The page text before the last message, and the message — to keep listening for its reply. */
  ctx.lastTurn = null;
  /**
   * #241 × #283: endpoints the run's own conversation turns wrote to (the chat's POST). Never the
   * page's background polling: the next turn's write to the same endpoint is that turn's own work.
   */
  ctx.turnWrites = new Set<string>();
  ctx.lastPath = null;
  // #188 — an add-another flow (the goal lists several items) comes back to a state it already went
  // through (the second item's one-time dialog, identical to the first's). The model is reminded of
  // what it did next from there, once per return — it read the history as those steps being done.
  ctx.listsSeveral = goalListsSeveral(cfg.goal);
  ctx.nextFrom = new Map<string, string[]>();
  ctx.prevSignature = null;
}
