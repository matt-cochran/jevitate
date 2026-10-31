import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "@jevitate/example-site";
import type { Recording } from "@jevitate/recording";
import { BrowseTheWeb, BrowseTheWebToken, CastActor } from "@jevitate/screenplay";
import { useSkippingTime, withSession } from "../../explore/src/testkit.js";
import { RecordingInterpreter } from "./interpreter.js";
import { PostconditionFailed } from "./assertion.js";
import { runStep } from "./run-step.js";

useSkippingTime({ per: "all" });

let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

describe("reload step replay", () => {
  it(
    "reloading after a client-side route change keeps the live runtime query string",
    async () => {
      const recording: Recording = {
        version: "1",
        site: site.url,
        pages: [
          {
            url: "/login",
            steps: [
              { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { role: "heading", name: "Sign in" } } } },
              { step: { kind: "reload", expect: { kind: "urlIncludes", text: "?id=live-" } } },
            ],
          },
        ],
      };
      const urls: string[] = [];
      await withSession(
        "jev-reload-",
        async (session) => {
          const actor = CastActor.named("reload").whoCan(new BrowseTheWeb(session, [site.url]));
          await new RecordingInterpreter({
            observer: {
              afterStep: async ({ actor: observed, recorded }) => {
                const page = observed.ability(BrowseTheWebToken).session.page;
                if (recorded.step.kind === "navigate") {
                  await page.evaluate(() => {
                    const id = `live-${Date.now()}`;
                    history.pushState({}, "", `/login?id=${id}`);
                  });
                }
                if (recorded.step.kind === "navigate" || recorded.step.kind === "reload") urls.push(page.url());
              },
            },
          }).run(actor, recording);
        },
        site.url,
      );

      expect(urls[1]).toBe(urls[0]);
    },
    60_000,
  );

  it(
    "fails closed when the reload's expectation does not hold",
    async () => {
      await withSession(
        "jev-reload-fail-",
        async (session) => {
          const actor = CastActor.named("reload").whoCan(new BrowseTheWeb(session, [site.url]));
          await session.page.goto(`${site.url}/login`);
          const rec = { step: { kind: "reload", expect: { kind: "urlIncludes", text: "/does-not-exist" } } } as const;
          await expect(runStep(actor, rec as never, new Map(), 0, { timeoutMs: 500 })).rejects.toBeInstanceOf(PostconditionFailed);
        },
        site.url,
      );
    },
    60_000,
  );
});
