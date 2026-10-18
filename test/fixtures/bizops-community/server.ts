import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { COMMENT_BY_ID, IDENTITIES, type BizopsSeedComment } from "./data.js";

/**
 * #580: the offline, fictional "community" fixture the two-journey Bizops comment workflow drives.
 * Plain `node:http` on 127.0.0.1:0 — no framework, no new dependency, no disk I/O — because the pair
 * of journeys (read the inbox, reply on a comment's permalink) must run offline and repeatably.
 *
 *  - `GET  /`                 the inbox: one row per seeded comment (open conversation), in seeded
 *                             order (deliberately not id order), each row carrying provider, channel,
 *                             account, post/thread/comment id, the parent id when any, and its
 *                             permalink (`/c/<commentId>`);
 *  - `GET  /c/<commentId>`    the conversation at that comment's native permalink: the full source
 *                             text, the parent comment when any, a "Reply as" account select, a
 *                             "Thread" select (the comment's thread preselected), the "Reply"
 *                             textarea and a Send button — every element with a `data-testid` hook;
 *  - `POST /c/<commentId>/reply`  records the reply in memory and answers 200. Nothing is persisted:
 *                             `submissions()` is the count a test compares before and after.
 *
 * Anything else is 404. HTML output is escaped, so seeded text (multiline included) is safe to render.
 */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;

/** `name="value"` for an attribute, or "" when absent: keeps rows free of empty data-parent-id. */
const attr = (name: string, value: string | null): string => (value === null ? "" : ` ${name}="${esc(value)}"`);

/** The inbox row for one seeded comment: the identity of the conversation, not its position. */
const inboxRow = ({ post, thread, comment }: BizopsSeedComment): string =>
  `<li data-testid="inbox-row" data-provider="${esc(post.provider)}" data-channel="${esc(post.channel)}" data-account="${esc(comment.account)}" data-post-id="${esc(post.id)}" data-thread-id="${esc(thread.id)}" data-comment-id="${esc(comment.id)}"${attr("data-parent-id", comment.parentId)} data-permalink="/c/${esc(comment.id)}">` +
  `<a href="/c/${esc(comment.id)}">${esc(thread.title)}</a> <span>${esc(comment.author)}</span>` +
  // The full source text, so a discover Journey can return it as the record's `sourceText`.
  `<p data-testid="row-text" style="white-space:pre-wrap">${esc(comment.text)}</p></li>`;

/** The parent comment (when a reply has one), with the id a test can match against the inbox row. */
const parentBlock = (parent: BizopsSeedComment | undefined): string =>
  parent === undefined
    ? ""
    : `<div data-testid="parent-comment" data-comment-id="${esc(parent.comment.id)}" data-author="${esc(parent.comment.author)}"><span>In reply to ${esc(parent.comment.author)}</span><p style="white-space:pre-wrap">${esc(parent.comment.text)}</p></div>`;

/** The reply composer: "Reply as" identity, target thread, multiline body, Send. */
const composer = ({ post, thread, comment }: BizopsSeedComment): string =>
  `<form method="post" action="/c/${esc(comment.id)}/reply">` +
  `<label for="reply-as">Reply as</label><select id="reply-as" name="account" data-testid="account-select">` +
  IDENTITIES.map((identity) => `<option value="${esc(identity.id)}"${identity.id === comment.account ? " selected" : ""}>${esc(identity.label)}</option>`).join("") +
  `</select>` +
  `<label for="reply-thread">Thread</label><select id="reply-thread" name="thread" data-testid="thread-select">` +
  post.threads.map((t) => `<option value="${esc(t.id)}"${t.id === thread.id ? " selected" : ""}>${esc(t.title)}</option>`).join("") +
  `</select>` +
  `<label for="reply-body">Reply</label><textarea id="reply-body" name="body" data-testid="reply-body" rows="6" cols="60"></textarea>` +
  `<button type="submit" data-testid="reply-send">Send</button></form>`;

const inboxPage = (): string => {
  const rows = [...COMMENT_BY_ID.values()].map(inboxRow).join("");
  return page("Inbox", `<h1>Inbox — open conversations</h1><ul data-testid="inbox-list">${rows}</ul>`);
};

const conversationPage = (seed: BizopsSeedComment): string => {
  const parent = seed.comment.parentId === null ? undefined : COMMENT_BY_ID.get(seed.comment.parentId);
  return page(
    `Conversation ${seed.comment.id}`,
    `<h1>${esc(seed.thread.title)}</h1>` +
      `<p data-testid="conversation-meta" data-provider="${esc(seed.post.provider)}" data-channel="${esc(seed.post.channel)}" data-post-id="${esc(seed.post.id)}" data-thread-id="${esc(seed.thread.id)}" data-comment-id="${esc(seed.comment.id)}">${esc(seed.post.provider)} — ${esc(seed.post.channel)} — ${esc(seed.thread.title)}</p>` +
      parentBlock(parent) +
      `<div data-testid="source-comment" data-comment-id="${esc(seed.comment.id)}" data-account="${esc(seed.comment.account)}" data-author="${esc(seed.comment.author)}"><span>${esc(seed.comment.author)}</span><p style="white-space:pre-wrap">${esc(seed.comment.text)}</p></div>` +
      composer(seed),
  );
};

const notFound = (what: string): string => page("Not found", `<h1>Not found</h1><p>${esc(what)}</p>`);

/** The request body as form fields (node:http only: no body parser). */
const formFields = async (req: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

export interface BizopsCommunity {
  readonly url: string;
  /** How many replies have been POSTed so far (in memory only). */
  submissions(): number;
  close(): Promise<void>;
}

/** One recorded reply; in memory only, so nothing reaches the disk. */
interface Submission {
  readonly commentId: string;
  readonly account: string;
  readonly threadId: string;
  readonly body: string;
}

export async function startBizopsCommunity(): Promise<BizopsCommunity> {
  const submissions: Submission[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter((p) => p !== "");
    const send = (code: number, body: string): void => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (req.method === "GET" && parts.length === 0) { send(200, inboxPage()); return; }

    if (parts[0] === "c" && parts[1] !== undefined && parts.length === 2 && req.method === "GET") {
      const seed = COMMENT_BY_ID.get(parts[1]);
      if (seed === undefined) { send(404, notFound(`No comment ${parts[1]}.`)); return; }
      send(200, conversationPage(seed));
      return;
    }

    if (parts[0] === "c" && parts[1] !== undefined && parts[2] === "reply" && parts.length === 3 && req.method === "POST") {
      const seed = COMMENT_BY_ID.get(parts[1]);
      if (seed === undefined) { send(404, notFound(`No comment ${parts[1]}.`)); return; }
      const fields = await formFields(req);
      submissions.push({
        commentId: seed.comment.id,
        account: fields.get("account") ?? "",
        threadId: fields.get("thread") ?? "",
        body: fields.get("body") ?? "",
      });
      send(200, page("Reply sent", `<h1>Reply queued</h1><p data-testid="reply-receipt" data-comment-id="${esc(seed.comment.id)}">Fictional reply to ${esc(seed.comment.id)} recorded.</p><a href="/c/${esc(seed.comment.id)}">Back to the conversation</a>`));
      return;
    }

    send(404, notFound(`${req.method ?? "GET"} ${url.pathname} is not part of this fixture.`));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`fixture error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("bizops fixture failed to bind 127.0.0.1:0");

  return {
    url: `http://127.0.0.1:${address.port}`,
    submissions: () => submissions.length,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A test's keep-alive sockets would otherwise hold close() open for a whole idle window.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
