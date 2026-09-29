/** Conversational-page tuning shared by the goal and usability strategies (CLI flags). */
export interface ConversationOptions {
  readonly replyWaitMs?: number;
  readonly replyCeilingMs?: number;
  readonly replyMaxChars?: number;
  /** Job-wait budget (ms, #92): waiting on an in-progress status the page shows. */
  readonly jobWaitMs?: number;
}

/** The ExploreConfig fields a `ConversationOptions` sets. */
export function conversationConfig(
  c: ConversationOptions | undefined,
): { replyWaitMs?: number; replyCeilingMs?: number; replyMaxChars?: number; jobWaitMs?: number } {
  return {
    ...(c?.replyWaitMs === undefined ? {} : { replyWaitMs: c.replyWaitMs }),
    ...(c?.replyCeilingMs === undefined ? {} : { replyCeilingMs: c.replyCeilingMs }),
    ...(c?.replyMaxChars === undefined ? {} : { replyMaxChars: c.replyMaxChars }),
    ...(c?.jobWaitMs === undefined ? {} : { jobWaitMs: c.jobWaitMs }),
  };
}
