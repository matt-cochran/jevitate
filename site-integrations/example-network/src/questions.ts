import type { Question } from "@doit/screenplay";
import { BrowseTheWebToken } from "@doit/screenplay";
import type { NormalizedMessage, NormalizedThread } from "@doit/domain";

export const AuthenticatedUser: Question<{ authenticated: boolean; account: string | null }> = {
  description: "authenticated user",
  async answeredBy(actor) {
    const page = actor.ability(BrowseTheWebToken).session.page;
    const res = await page.request.get("/whoami");
    return res.json() as Promise<{ authenticated: boolean; account: string | null }>;
  },
};

export const InboxThreads: Question<NormalizedThread[]> = {
  description: "inbox threads",
  async answeredBy(actor) {
    const page = actor.ability(BrowseTheWebToken).session.page;
    const items = page.locator("li[data-thread-id]");
    const count = await items.count();
    const threads: NormalizedThread[] = [];
    for (let i = 0; i < count; i++) {
      const li = items.nth(i);
      const [sourceThreadId, sourceMessageId, sender, receivedAt] = await Promise.all([
        li.getAttribute("data-thread-id"), li.getAttribute("data-message-id"),
        li.getAttribute("data-sender"), li.getAttribute("data-received-at"),
      ]);
      const subject = (await li.getByRole("link").innerText()).trim();
      const text = (await li.locator("p").innerText()).trim();
      threads.push({
        sourceThreadId: sourceThreadId!, subject,
        messages: [{ sourceThreadId: sourceThreadId!, sourceMessageId: sourceMessageId!, sender: sender!, receivedAt: receivedAt!, text }],
      });
    }
    return threads;
  },
};

export function ThreadDetail(threadId: string): Question<NormalizedThread> {
  return {
    description: `thread ${threadId}`,
    async answeredBy(actor) {
      const page = actor.ability(BrowseTheWebToken).session.page;
      const subject = (await page.getByRole("heading").first().innerText()).trim();
      const items = page.locator("li[data-message-id]");
      const count = await items.count();
      const messages: NormalizedMessage[] = [];
      for (let i = 0; i < count; i++) {
        const li = items.nth(i);
        const [sourceMessageId, sender, receivedAt] = await Promise.all([
          li.getAttribute("data-message-id"), li.getAttribute("data-sender"), li.getAttribute("data-received-at"),
        ]);
        messages.push({ sourceThreadId: threadId, sourceMessageId: sourceMessageId!, sender: sender!, receivedAt: receivedAt!, text: (await li.innerText()).trim() });
      }
      return { sourceThreadId: threadId, subject, messages };
    },
  };
}
