import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { Recorder } from "@jevitate/recorder";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { buildProgram } from "./program.js";
import { runRecording } from "./record-api.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #566 served (real Chromium): two takes of a fictional comment-reply flow recorded through the
 * real `jevitate record` writer, `recording propose` over them, then the UNPROMOTED draft replayed:
 *
 * - with params for a THIRD thread: it passes and stops before Send (the reply endpoint is never hit);
 * - with a thread the app redirects to another thread (a changed source context): it fails closed at
 *   the pre-write identity check on the thread URL, before anything is typed.
 */

const MOVED = "T-MOVED";
const OTHER = "T-5000";

const THREAD_PAGE = (id: string): string => `<!doctype html><html><head><title>Thread ${id}</title></head><body><main>
  <header data-testid="thread-header" data-thread-id="${id}"><h1>Thread ${id}</h1></header>
  <form onsubmit="event.preventDefault()">
    <label for="reply">Reply</label>
    <textarea id="reply" name="reply" oninput="fetch('/api/typed', { method: 'POST' })"></textarea>
    <label for="account">Account</label>
    <select id="account" name="account">
      <option value="acct-support">Support</option>
      <option value="acct-billing">Billing</option>
    </select>
    <button type="button" onclick="fetch('/api/reply', { method: 'POST' }).then(() => { document.getElementById('sent').hidden = false; })">Send</button>
    <p id="sent" data-testid="sent-toast" hidden>Sent</p>
  </form>
</main></body></html>`;

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let replyHits = 0;
let typedHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/api/reply") {
      replyHits += 1;
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (req.method === "POST" && u.pathname === "/api/typed") {
      typedHits += 1;
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    // A thread that moved: the app sends the reader to another thread.
    if (u.pathname === `/threads/${MOVED}`) return void res.writeHead(302, { location: `/threads/${OTHER}` }).end();
    const m = /^\/threads\/([A-Za-z0-9-]+)$/.exec(u.pathname);
    if (m !== null) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(THREAD_PAGE(m[1]!));
    res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><title>Not found</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jevitate-566-served-"));
  journeysDir = join(root, "journeys");

  const takeA = await recordTake("a", "T-1001", "Thanks, the refund is on its way.", "acct-support");
  const takeB = await recordTake("b", "T-2002", "Your parcel ships on Monday.", "acct-billing");
  const proposed = await cli(["recording", "propose", takeA, takeB, "--id", "reply-draft", "--json"]);
  if (proposed.exitCode !== 0) throw new Error(`recording propose failed: ${proposed.out}`);
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Waits until `count` distinct elements have delivered an action to the recorder. */
async function waitForCapturedActions(recorder: Recorder, count: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const eids = new Set(recorder.events.filter((e) => e.type === "action").map((e) => (e.type === "action" ? e.payload.eid : "")));
    if (eids.size >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} captured actions`);
}

/** One take through the real record writer: open the thread, type the reply, choose the account, Send. */
async function recordTake(tag: string, thread: string, reply: string, account: string): Promise<string> {
  const port = new PlaywrightBrowserPort();
  let recorder: Recorder | undefined;
  let page: Page | undefined;
  const result = await runRecording({
    url: `${origin}/threads/${thread}`,
    allowlist: [origin],
    outDir: await mkdtemp(join(root, `take-${tag}-`)),
    headless: true,
    intent: "Reply to a support thread",
    browserPortFactory: () => ({
      async open(o) {
        const session = await port.open(o);
        page = session.page as unknown as Page;
        return session;
      },
    }),
    recorderFactory: (session, site) => {
      recorder = new Recorder(session, site);
      return recorder;
    },
    waitForStop: async () => {
      if (page === undefined || recorder === undefined) throw new Error("session was not captured");
      await page.getByLabel("Reply").fill(reply);
      await page.getByLabel("Account").selectOption(account);
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByTestId("sent-toast").waitFor();
      await waitForCapturedActions(recorder, 3);
    },
    nowIso: () => `2026-10-17T12:00:0${tag === "a" ? 1 : 2}.000Z`,
  });
  return result.recordingPath;
}

async function cli(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  const override = (c: Command): void => {
    c.exitOverride();
    c.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => out.push(s) });
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode };
}

async function runDraft(thread: string): Promise<{ out: string; exitCode: number | undefined }> {
  replyHits = 0;
  typedHits = 0;
  return cli(["journey", "run", "reply-draft", "--param", `thread=${thread}`, "--param", "reply=We have escalated this.", "--param", "account=acct-billing", "--json"]);
}

describe("#566 recording propose over real takes (real Chromium)", () => {
  it("saves the draft unpromoted", async () => {
    const draft = (await new FsJourneyStore(journeysDir).get("reply-draft")) as Journey;
    expect(draft.metadata.promoted).toBe(false);
  });

  it("proposes the thread, reply and account as the draft's parameters", async () => {
    const draft = (await new FsJourneyStore(journeysDir).get("reply-draft")) as Journey;
    expect([...draft.metadata.params].sort()).toEqual(["account", "reply", "thread"]);
  });

  it("the draft replays for a third thread", async () => {
    const r = await runDraft("T-3003");
    expect(r.exitCode, r.out).toBe(0);
  }, 120_000);

  it("the third-thread replay stops before Send", async () => {
    await runDraft("T-3003");
    expect(replyHits).toBe(0);
  }, 120_000);

  it("the third-thread replay types the reply", async () => {
    await runDraft("T-3003");
    expect(typedHits).toBeGreaterThan(0);
  }, 120_000);

  it("a thread the app redirects elsewhere fails closed", async () => {
    const r = await runDraft(MOVED);
    expect(r.exitCode, r.out).toBe(1);
  }, 120_000);

  it("the redirected replay fails before anything is typed", async () => {
    await runDraft(MOVED);
    expect(typedHits).toBe(0);
  }, 120_000);

  it("the redirected replay never reaches the reply endpoint", async () => {
    await runDraft(MOVED);
    expect(replyHits).toBe(0);
  }, 120_000);
});
