import { afterAll, beforeAll, expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb, BrowseTheWebToken } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { safeRunPolicy } from "@jevitate/domain";
import type { Journey } from "@jevitate/journey";
import { JourneyRunner, type HandbackHandler } from "./journey-runner.js";

let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

// Ruling 4: the example-site fixture's login form is USERNAME-ONLY — there is
// no password field (see apps/example-site/src/server.ts: `/login` renders
// only `<input name="username" aria-label="Username">`, and `POST /login`
// requires only `username`). So the `username` field itself is modeled as the
// `handback` (secret) step here: it stands in for whatever real secret field
// a real site would have, and genuinely exercises the visible-handback
// mechanism (interpreter stops at the handback, the runner never holds the
// value, a human-standin fills it live, and resume only proceeds once the
// resume postcondition is independently verified).
const recording: Recording = {
  version: "1.0.0",
  site: "example-site",
  pages: [
    {
      url: "/login",
      steps: [
        {
          step: {
            kind: "navigate",
            url: "/login",
            expect: { kind: "visible", target: { label: "Username" } },
          },
        },
        {
          step: {
            kind: "handback",
            prompt: "Enter your username",
            resume: { kind: "visible", target: { role: "button", name: "Sign in" } },
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
  ],
};

const journey: Journey = {
  metadata: { id: "login", name: "Log in", promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
  recording,
};

test(
  "Slice 1 acceptance: a real login Journey runs end-to-end through JourneyRunner via visible-handback",
  async () => {
    const port = new PlaywrightBrowserPort();
    const session = await port.open({
      headless: true,
      allowedOrigins: [site.url],
      baseUrl: site.url,
    });
    try {
      const actor = CastActor.named("human-standin").whoCan(new BrowseTheWeb(session, [site.url]));

      // The test HandbackHandler stands in for the human: it fills the
      // username field on the LIVE page via the real actor, and resolves.
      // The JourneyRunner itself never sees or holds this value — it only
      // calls `present(prompt)` and waits.
      const handbackHandler: HandbackHandler = {
        async present(_prompt: string) {
          const page = actor.ability(BrowseTheWebToken).session.page;
          await page.getByLabel("Username").fill("jane");
        },
      };

      const policy = { ...safeRunPolicy(), secret: { secretMode: "visible-handback" as const } };
      const runner = new JourneyRunner(actor, new RecordingInterpreter(), handbackHandler);

      const result = await runner.run({ journey, params: {}, policy });
      expect(result).toEqual({ outcome: "ok", output: {} });

      // Assert the AUTHENTICATED state was actually reached: resume only
      // happened after the handback's postcondition passed, and the run
      // completed with the session logged in.
      const page = actor.ability(BrowseTheWebToken).session.page;
      await page.goto("/inbox");
      expect(await page.getByRole("heading", { name: "Inbox" }).isVisible()).toBe(true);

      const whoami = await page.evaluate(async () => {
        const res = await fetch("/whoami");
        return res.json();
      });
      expect(whoami).toEqual({ authenticated: true, account: "jane" });
    } finally {
      await session.close();
    }
  },
  60_000,
);
