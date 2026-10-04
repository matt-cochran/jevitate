/**
 * `report` (#101): a find-out goal ends with a grounded ANSWER — the goal loop's report handler,
 * moved out of `explore.ts` unchanged (#232).
 */
import { NO_ANSWER_REASON, UNSAVED_WRITE_REASON, reportAnswer, type AnswerVerdict } from "../answer.js";
import { readPageText, waitForReply } from "../conversation.js";
import type { RunContext } from "./context.js";
import { firstLine, quote } from "./helpers.js";
import { MAX_REPORT_REJECTIONS } from "./limits.js";
import type { Flow, Step } from "./step.js";

export async function handleReport(ctx: RunContext, step: Step): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, record } = step;
  if (ctx.replyGoal) {
    // #200 — a reply still on its way is listened for (what is left of the reply wait) before
    // the report is judged; then the current page's post-send text is taken in.
    if (ctx.awaitingReply && ctx.lastTurn !== null && ctx.busyWaitedMs < ctx.replyWaitMs) {
      const t0 = ctx.now();
      const listen = ctx.replyWaitMs - ctx.busyWaitedMs;
      const reply = await waitForReply(ctx.page, { secrets: ctx.secrets, ...ctx.lastTurn, timeoutMs: listen, ceilingMs: listen, quietMs: ctx.replyQuietMs });
      ctx.busyWaitedMs += ctx.now() - t0;
      if (reply.received) {
        ctx.conversation.latestReply = reply.text;
        ctx.replies.add(snap.url, reply.text);
        ctx.awaitingReply = false;
        ctx.busyWaitedMs = 0;
        ctx.history.push(`waited for the reply → reply: ${quote(reply.text, 300)}`);
      }
    }
    ctx.noteReplyText(snap.url, await readPageText(ctx.page, ctx.secrets));
  }
  const replyPages = ctx.replyGoal ? ctx.replies.pages() : null;
  const verdict: AnswerVerdict =
    replyPages !== null && replyPages.length === 0
      ? {
          accept: false as const,
          reason:
            ctx.preSend === null
              ? "no reply observed: no message was sent yet — text on the page before the conversation is not a reply"
              : `no reply observed: no new message appeared after the send within the reply wait (${Math.round(ctx.replyWaitMs / 1000)}s)`,
          answer: null,
        }
      : await reportAnswer(cfg.gen, {
          goal: cfg.goal,
          url: snap.url,
          pages: replyPages ?? ctx.observed.pages(),
          history: ctx.history,
          secrets: ctx.secrets,
          judge: cfg.judge,
          vetoes: ctx.vetoes,
          // #238: "none exists" is an answer only on observed pages that cover the app enough.
          ...(replyPages === null ? { topNav: ctx.observed.topNavigation(), ownInputs: ctx.observed.ownInputs() } : {}),
        })
          // #239: a write goal's report settles nothing before a write of the run succeeded.
          .then((v): AnswerVerdict =>
            v.accept && ctx.writeGoal && !ctx.wroteOk && v.answer.absent !== true ? { accept: false, reason: UNSAVED_WRITE_REASON, answer: v.answer } : v,
          )
          .catch((e: unknown) => ({ accept: false as const, reason: `no answer could be generated: ${firstLine(e)}`, answer: null }));
  if (verdict.accept) {
    const on = replyPages === null ? "the observed pages" : "the reply observed after the send";
    record(true, `report accepted: answer grounded on ${on} (${verdict.answer.evidence.length} claim(s))`, {
      answer: verdict.answer,
    });
    ctx.answer = verdict.answer;
    ctx.outcome = { status: "completed", verifiedBy: "grounded-answer" };
    ctx.stop = "done";
    return "stop";
  }
  ctx.reportRejections += 1;
  // #223: an answer that is on the page but does not answer the question is no answer either.
  ctx.lastReportNotFound = (verdict.answer === null && verdict.reason === NO_ANSWER_REASON) || verdict.notAnswer === true;
  ctx.lastAbsenceUncovered = verdict.absenceUncovered === true ? verdict.reason : null;
  ctx.history.push(`report rejected: ${verdict.reason} — find the answer on the page before reporting`);
  record(false, `report rejected (${ctx.reportRejections}/${MAX_REPORT_REJECTIONS}): ${verdict.reason}`, {
    answer: verdict.answer,
  });
  if (ctx.reportRejections >= MAX_REPORT_REJECTIONS) {
    ctx.incomplete = `the model reported an answer ${ctx.reportRejections} times, but ${verdict.reason}`;
    ctx.stop = "blocked";
    return "stop";
  }
  return "continue";
}
