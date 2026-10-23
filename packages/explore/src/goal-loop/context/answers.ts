/** `createRunContext`: rejections, observed pages and grounded answers (#101, #200, #207, #229, #238, #239, #424) (#500: moved verbatim out of `context.ts`). */
import { ObservedPages, goalAsksToWrite, goalAsksForReply, VetoedAnswers } from "../../answer.js";
import { DepthLog } from "../../run-depth.js";
import { newPageText, withoutAuthored } from "../../conversation.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initAnswers(ctx: MutableRunContext, cfg: ExploreConfig): void {
  ctx.doneRejections = 0;
  ctx.reportRejections = 0;
  /** The visible text of every page state observed — what a reported answer is grounded against (#101). */
  ctx.observed = new ObservedPages(ctx.secrets);
  /**
   * #200 — a goal about a conversational reply (`goalAsksForReply`, code-side) is reported from, and
   * grounded on, ONLY text that appeared after the run's first send: each observed state's text minus
   * the pre-send snapshot and the run's own messages, plus every reply the reply wait read. A chat
   * panel's intro / placeholder copy, on screen before the conversation, is never a reply.
   */
  ctx.replyGoal = goalAsksForReply(cfg.goal);
  /**
   * #207 — a find-out goal (read-only, #158; not a reply goal, #200) is answered from page text: its
   * decisions carry the page's visible text, and a model `blocked` on a page state is first turned
   * into one grounded report attempt there (the answer may be plain text no control carries).
   */
  ctx.findOut = cfg.readOnly === true && !ctx.replyGoal;
  /** #424: depth and the minimum effort (resolved by the mission; the loop only enforces it). */
  ctx.depth = new DepthLog();
  ctx.minEffort = cfg.minEffort ?? null;
  ctx.minEffortRefusals = 0;
  ctx.minEffortRefusedAt = -1;
  ctx.deferredAnswer = undefined;
  ctx.reportClaims = [];
  /** #207: page states whose `blocked` was already turned into a report attempt (once per state). */
  ctx.blockedReported = new Set<string>();
  /** #207: the latest report attempt found no answer — the run's end reason then names the pages seen. */
  ctx.lastReportNotFound = false;
  ctx.noControls = false;
  /** #238: the latest report's "none exists" was below the coverage floor (its reason), else null. */
  ctx.lastAbsenceUncovered = null;
  /** #239: the last click whose window was settled, and whether any click's writes all succeeded (2xx). */
  ctx.settledClick = null;
  ctx.clickedRegion = null;
  ctx.wroteOk = false;
  ctx.readBackAsked = false;
  /** #239: a write goal ("record a decision…") is not settled by a report before the run saved anything. */
  ctx.writeGoal = goalAsksToWrite(cfg.goal);
  // #229: answers Jev vetoed stay rejected for the rest of the run, however often they are re-reported.
  ctx.vetoes = new VetoedAnswers();
  ctx.replies = new ObservedPages(ctx.secrets);
  /** The page text just before the run's first message was sent (null until one is sent). */
  ctx.preSend = null;
  ctx.noteReplyText = (url: string, pageText: string): void => {
    if (ctx.preSend !== null) ctx.replies.add(url, withoutAuthored(newPageText(ctx.preSend, pageText, ""), ctx.conversation.sent));
  };
  /** The grounded answer a `report` ended the run with. */
  ctx.answer = undefined;
  /** Page states already goal-checked on the decision's "already met" signal (once each, #91). */
  ctx.goalChecked = new Set<string>();
}
