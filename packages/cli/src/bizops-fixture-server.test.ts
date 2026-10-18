import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDENTITIES, SEED_COMMENTS } from "../../../test/fixtures/bizops-community/data.js";
import { startBizopsCommunity } from "../../../test/fixtures/bizops-community/server.js";

/**
 * #580: smoke test for the offline Bizops fixture (test/fixtures/bizops-community), which the
 * two-journey comment workflow drives through a browser. Everything it asserts is plain HTML over
 * HTTP, so it runs in the `unit` project: the inbox lists the seeded comments, a comment's permalink
 * serves the composer (source text, parent, both selects, the textarea), an unknown id is a 404, and
 * a reply POST is counted — without touching the disk.
 *
 * Each test makes ONE assertion about one rendered outcome: the helpers below read the fixture's
 * public hooks (`data-testid`, `data-*` attributes) out of the page, never the source code.
 */

/** The first tag carrying `data-testid="<testId>"`. */
const tagOf = (html: string, testId: string): string =>
  new RegExp(`<[a-z]+\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";

/** One attribute on a tag (`""` when absent). */
const attrOf = (tag: string, name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

/** Every inbox row tag, in the order the page renders them. */
const inboxRows = (html: string): string[] => [...html.matchAll(/<li\b[^>]*data-testid="inbox-row"[^>]*>/g)].map(([tag]) => tag);

const optionTags = (html: string, testId: string): string[] => {
  const select = new RegExp(`<select\\b[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? "";
  return [...select.matchAll(/<option\b[^>]*>/g)].map(([tag]) => tag);
};

/** The `value` of every option in a select. */
const optionValues = (html: string, testId: string): string[] => optionTags(html, testId).map((tag) => attrOf(tag, "value"));

/** The accessible name a `<label for=...>` gives the control carrying `testId`. */
const labelOf = (html: string, testId: string): string => {
  const id = attrOf(tagOf(html, testId), "id");
  return new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>([^<]*)</label>`).exec(html)?.[1]?.trim() ?? "";
};

/** A seeded reply (a comment that answers another one): the page under test for parents. */
const replied = SEED_COMMENTS.find((s) => s.comment.parentId !== null)!;

let fixture: Awaited<ReturnType<typeof startBizopsCommunity>>;
let inbox: string;
let conversation: string;

const page = async (path: string): Promise<{ status: number; html: string }> => {
  const res = await fetch(`${fixture.url}${path}`);
  return { status: res.status, html: await res.text() };
};

beforeAll(async () => {
  fixture = await startBizopsCommunity();
  inbox = (await page("/")).html;
  conversation = (await page(`/c/${replied.comment.id}`)).html;
});

afterAll(async () => {
  await fixture.close();
});

describe("the Bizops community fixture inbox", () => {
  it("lists every seeded comment id", () => {
    expect(inboxRows(inbox).map((row) => attrOf(row, "data-comment-id")).sort()).toEqual(SEED_COMMENTS.map((s) => s.comment.id).sort());
  });

  it("shows every row's full source text", () => {
    expect(SEED_COMMENTS.every((s) => inbox.includes(s.comment.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")))).toBe(true);
  });

  it("links every row to that comment's permalink", () => {
    expect(inboxRows(inbox).every((row) => attrOf(row, "data-permalink") === `/c/${attrOf(row, "data-comment-id")}`)).toBe(true);
  });
});

describe("the Bizops community fixture conversation page", () => {
  it("serves the reply composer", () => {
    expect(tagOf(conversation, "reply-body").startsWith("<textarea")).toBe(true);
  });

  it("renders the parent of a reply", () => {
    expect(attrOf(tagOf(conversation, "parent-comment"), "data-comment-id")).toBe(replied.comment.parentId);
  });

  it("offers every seeded identity in the reply-as select", () => {
    expect(optionValues(conversation, "account-select")).toEqual(IDENTITIES.map((identity) => identity.id));
  });

  it("preselects the comment's own thread", () => {
    const selected = optionTags(conversation, "thread-select").find((tag) => /\bselected\b/.test(tag)) ?? "";
    expect(attrOf(selected, "value")).toBe(replied.thread.id);
  });

  it("labels the account select 'Reply as'", () => {
    expect(labelOf(conversation, "account-select")).toBe("Reply as");
  });

  it("labels the thread select 'Thread'", () => {
    expect(labelOf(conversation, "thread-select")).toBe("Thread");
  });

  it("labels the composer textarea 'Reply'", () => {
    expect(labelOf(conversation, "reply-body")).toBe("Reply");
  });

  it("answers 404 for an unknown comment id", async () => {
    expect((await page("/c/c-does-not-exist")).status).toBe(404);
  });
});

describe("the Bizops community fixture reply endpoint", () => {
  it("accepts a reply", async () => {
    const res = await fetch(`${fixture.url}/c/${replied.comment.id}/reply`, {
      method: "POST",
      body: new URLSearchParams({ account: "personal", thread: replied.thread.id, body: "Tuesday the ninth works for the crew." }),
    });
    await res.text();
    expect(res.status).toBe(200);
  });

  it("counts a submitted reply", async () => {
    const before = fixture.submissions();
    const res = await fetch(`${fixture.url}/c/${replied.comment.id}/reply`, {
      method: "POST",
      body: new URLSearchParams({ account: "personal", thread: replied.thread.id, body: "Second confirmation for the freight lift." }),
    });
    await res.text();
    expect(fixture.submissions()).toBe(before + 1);
  });
});
