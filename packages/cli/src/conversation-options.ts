/** Conversational-page tuning shared by the goal and usability strategies (CLI flags). */
export interface ConversationOptions {
  readonly replyWaitMs?: number;
  /** #331: how long a reply must hold still before it is read as complete. */
  readonly replyQuietMs?: number;
  readonly replyCeilingMs?: number;
  readonly replyMaxChars?: number;
  /** Job-wait budget (ms, #92): waiting on an in-progress status the page shows. */
  readonly jobWaitMs?: number;
}

/** The ExploreConfig fields a `ConversationOptions` sets. */
export function conversationConfig(
  c: ConversationOptions | undefined,
): { replyWaitMs?: number; replyQuietMs?: number; replyCeilingMs?: number; replyMaxChars?: number; jobWaitMs?: number } {
  return {
    ...(c?.replyWaitMs === undefined ? {} : { replyWaitMs: c.replyWaitMs }),
    ...(c?.replyQuietMs === undefined ? {} : { replyQuietMs: c.replyQuietMs }),
    ...(c?.replyCeilingMs === undefined ? {} : { replyCeilingMs: c.replyCeilingMs }),
    ...(c?.replyMaxChars === undefined ? {} : { replyMaxChars: c.replyMaxChars }),
    ...(c?.jobWaitMs === undefined ? {} : { jobWaitMs: c.jobWaitMs }),
  };
}
