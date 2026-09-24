/** Conversational-page tuning shared by the goal and usability strategies (CLI flags). */
export interface ConversationOptions {
  readonly replyWaitMs?: number;
  readonly replyMaxChars?: number;
}

/** The ExploreConfig fields a `ConversationOptions` sets. */
export function conversationConfig(c: ConversationOptions | undefined): { replyWaitMs?: number; replyMaxChars?: number } {
  return {
    ...(c?.replyWaitMs === undefined ? {} : { replyWaitMs: c.replyWaitMs }),
    ...(c?.replyMaxChars === undefined ? {} : { replyMaxChars: c.replyMaxChars }),
  };
}
