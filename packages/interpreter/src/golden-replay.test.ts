import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "./interpreter.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-golden-"));
});
afterAll(async () => {
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

test(
  "golden replay: a hand-authored declarative Recording reproduces login -> inbox -> thread on the real fixture",
  async () => {
    const recording: Recording = {
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
                kind: "forEach",
                items: { css: "li[data-thread-id]" },
                as: "thread",
                steps: [
                  {
                    kind: "extract",
                    target: { css: "a" },
                    as: "threadSubject",
                    expect: { kind: "visible", target: { css: "a" } },
                  },
                ],
              },
            },
            {
              step: {
                kind: "click",
                target: { role: "link", name: "Welcome" },
                expect: { kind: "urlIncludes", text: "/thread/t-1" },
              },
            },
          ],
        },
        {
          url: "/thread/t-1",
          steps: [
            { step: { kind: "waitFor", target: { role: "heading", name: "Welcome" }, state: "visible" } },
            {
              step: {
                kind: "extract",
                target: { css: "li[data-message-id='m-1']" },
                as: "messageText",
                expect: { kind: "textIncludes", target: { css: "li[data-message-id='m-1']" }, text: "Hello there" },
              },
            },
          ],
        },
      ],
    };

    // Validate through the schema FIRST — proves the schema genuinely accepts a real journey, not just synthetic unit-test shapes.
    const parsed = RecordingSchema.parse(recording);

    const port = new PlaywrightBrowserPort();
    const session = await port.open({
      profileDir,
      headless: true,
      allowedOrigins: [site.url],
      baseUrl: site.url,
    });
    try {
      const actor = CastActor.named("golden").whoCan(new BrowseTheWeb(session, [site.url]));
      const result = await new RecordingInterpreter().run(actor, parsed);
      expect(result.outcome).toBe("completed");
      if (result.outcome !== "completed") throw new Error(`expected completed, got ${JSON.stringify(result)}`);
      // forEach iterated both /inbox rows in real-DOM order (t-1 "Welcome"
      // first, t-2 "Follow up" second, per SEED_THREADS) and, per A.1's
      // documented last-row-wins semantics, the LAST row's extraction is
      // what remains in vars — proving both that the loop genuinely
      // iterated real rows (not the same element resolved twice) and that
      // the last-row-wins contract holds against a real browser.
      expect(result.vars.threadSubject).toBe("Follow up");
      expect(result.vars.messageText).toBe("Hello there");
    } finally {
      await session.close();
    }
  },
  60_000,
);
