import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordingSchema } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { RunRecorder, toPath } from "./index.js";
import { withSession } from "./testkit.js";

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

describe("record — append RecordedStep -> replayable Recording (Task 8)", () => {
  it("toPath reduces an absolute URL to its path and leaves a relative path alone", () => {
    expect(toPath("http://127.0.0.1:3000/login?x=1")).toBe("/login");
    expect(toPath("/inbox")).toBe("/inbox");
  });

  it(
    "a recording assembled from executed steps validates and replays on the fixture",
    async () => {
      const rec = new RunRecorder("example-site");
      let t = 0;
      rec.navigate("/login", (t += 10));
      rec.observed("/login", t);
      rec.fill({ role: "textbox", name: "Username" }, "jane", (t += 20));
      rec.observed("/login", t);
      rec.click({ role: "button", name: "Sign in" }, (t += 20));
      // Re-observe AFTER the click: the URL changed, so record() rewrites the
      // click's postcondition to urlIncludes(/inbox).
      rec.observed("/inbox", t);

      const recording = rec.finish({ intent: "log in and reach the inbox" });

      // Schema-valid.
      expect(() => RecordingSchema.parse(recording)).not.toThrow();
      // The click's postcondition became a URL check (record-before-reobserve).
      const loginSteps = recording.pages[0]!.steps;
      const click = loginSteps.find((s) => s.step.kind === "click")!;
      expect(click.step).toMatchObject({ kind: "click", expect: { kind: "urlIncludes", text: "/inbox" } });
      // The fill value is self-contained (non-secret, model-authored).
      const fill = loginSteps.find((s) => s.step.kind === "fill")!;
      expect(fill.step).toMatchObject({ kind: "fill", value: { redacted: false, value: "jane" } });

      // Replays deterministically in a genuinely fresh session.
      await withSession(
        "explore-record-replay-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [site.url]));
          const result = await new RecordingInterpreter().run(actor, recording);
          expect(result.outcome).toBe("completed");
          expect(fresh.page.url()).toContain("/inbox");
        },
        site.url,
      );
    },
    120_000,
  );
});
