import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer, SEED_THREADS } from "@jevitate/example-site";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { recordPatch } from "./patch.js";

/**
 * RxD Phase A.3b, Task 4: record-a-patch orchestration.
 *
 * `recordPatch` composes three existing pieces against a real browser:
 *  1. `RecordingInterpreter.runToCheckpoint` drives a live session to a
 *     checkpoint mid-`base` (here: the last step of a hand-authored, fully
 *     real journey — login -> inbox -> thread).
 *  2. The recorder is attached on that same, already-navigated page — its
 *     "start-from-state" capture path (A.2 §5c / `assemble.ts`'s `onAction`
 *     `current === null` branch): no leading `navigate` step, so the segment
 *     is a delimited supplement, not a re-record of the journey.
 *  3. `spliceRecording(base, at, segment, "insert")` splices it in.
 *
 * The demonstrated extra action (a click on the thread's message `<li>`) is
 * on the *same* page the checkpoint left off on, and is not itself base's
 * last step — so this also exercises `spliceRecording`'s merge-adjacent-
 * same-URL behavior (commit 8b3a959): the result must have exactly as many
 * pages as `base`, not one more for the segment.
 */

const port = new PlaywrightBrowserPort();

const FIRST_THREAD = SEED_THREADS[0]!;
const FIRST_MESSAGE = FIRST_THREAD.messages[0]!;
const MESSAGE_CSS = `li[data-message-id='${FIRST_MESSAGE.id}']`;

let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

type Session = Awaited<ReturnType<typeof port.open>>;

async function withSession<T>(prefix: string, body: (session: Session) => Promise<T>): Promise<T> {
  const profileDir = await mkdtemp(join(tmpdir(), prefix));
  const session = await port.open({
    profileDir,
    headless: true,
    allowedOrigins: [site.url],
    baseUrl: site.url,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

/** A fully real, replayable journey — the same shape as `golden-replay.test.ts`'s recording. */
function makeBase(): Recording {
  return {
    version: "1.0.0",
    site: "example-site",
    pages: [
      {
        url: "/login",
        steps: [
          { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Username" } } } },
          {
            step: {
              kind: "fill",
              target: { label: "Username" },
              value: { redacted: false, value: "jane" },
              expect: { kind: "visible", target: { role: "button", name: "Sign in" } },
            },
          },
          {
            step: {
              kind: "click",
              target: { role: "button", name: "Sign in" },
              expect: { kind: "urlIncludes", text: "/inbox" },
            },
          },
        ],
      },
      {
        url: "/inbox",
        steps: [
          { step: { kind: "waitFor", target: { role: "heading", name: "Inbox" }, state: "visible" } },
          {
            step: {
              kind: "click",
              target: { role: "link", name: FIRST_THREAD.subject },
              expect: { kind: "urlIncludes", text: `/thread/${FIRST_THREAD.id}` },
            },
          },
        ],
      },
      {
        url: `/thread/${FIRST_THREAD.id}`,
        steps: [
          { step: { kind: "waitFor", target: { role: "heading", name: FIRST_THREAD.subject }, state: "visible" } },
          {
            step: {
              kind: "extract",
              target: { css: MESSAGE_CSS },
              as: "messageText",
              expect: { kind: "textIncludes", target: { css: MESSAGE_CSS }, text: FIRST_MESSAGE.text },
            },
          },
        ],
      },
    ],
  };
}

test(
  "recordPatch: replay-to-checkpoint + capture + splice produces a Recording that interprets end-to-end",
  async () => {
    const base = RecordingSchema.parse(makeBase());
    const flat = base.pages.flatMap((p) => p.steps);
    const checkpoint = flat.length - 1; // base's very last step: the `extract` on /thread/t-1

    const patched = await withSession("jevitate-patch-record-", async (session) =>
      recordPatch({
        base,
        checkpoint,
        browser: session,
        allowedOrigins: [site.url],
        intent: "click the message to acknowledge it",
        retro: "clicked the message",
        demonstrate: async (demoSession) => {
          // A real user gesture on the SAME page the checkpoint left off on
          // (no navigation) — the in-page patch scenario the merge fix targets.
          await demoSession.page.locator(MESSAGE_CSS).click();
        },
      }),
    );

    // === Structural assertions: this is a splice, not a re-record ===
    expect(() => RecordingSchema.parse(patched)).not.toThrow();

    // Same page count as base: the merge-adjacent-same-URL fix folds the
    // capture's single-page segment into the existing /thread/t-1 page
    // instead of appending a fourth page.
    expect(patched.pages.map((p) => p.url)).toEqual(base.pages.map((p) => p.url));
    expect(patched.pages.length).toBe(base.pages.length);

    const lastPage = patched.pages[patched.pages.length - 1]!;
    // base's two /thread/t-1 steps (waitFor, extract) plus exactly one new
    // captured step from the demonstration.
    expect(lastPage.steps.length).toBe(3);
    expect(lastPage.steps[0]!.step.kind).toBe("waitFor");
    expect(lastPage.steps[1]!.step.kind).toBe("extract");
    const appended = lastPage.steps[2]!.step;
    expect(appended.kind).toBe("click");
    expect(appended.kind === "handback").toBe(false);

    // === End-to-end: the combined recording replays in a fresh session ===
    await withSession("jevitate-patch-replay-", async (fresh) => {
      const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [site.url]));
      const result = await new RecordingInterpreter().run(actor, patched, { username: "jane" });
      if (result.outcome !== "completed") {
        throw new Error(`expected the patched recording to replay to completion, got ${JSON.stringify(result)}`);
      }
      expect(result.outcome).toBe("completed");
      expect(result.vars.messageText).toContain(FIRST_MESSAGE.text);
      expect(fresh.page.url()).toContain(`/thread/${FIRST_THREAD.id}`);
    });
  },
  120_000,
);
