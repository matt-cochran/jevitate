import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type JudgmentPort } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { explore } from "./index.js";
import { ScriptedJudge, withSession } from "./testkit.js";

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

describe("explore — bounded perceive->decide->act->record loop (Task 9)", () => {
  it(
    "drives the fixture to the goal with fakes and emits a replayable Recording",
    async () => {
      const run = await withSession(
        "explore-loop-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          const judge = new ScriptedJudge([
            { op: "type", target: "0" }, // Username
            { op: "click", target: "1" }, // Sign in -> /inbox
            { op: "done" },
          ]);
          const gen = new FakeGenerationGateway({ "form.value": { text: "jane" } });
          return explore({
            actor,
            judge,
            gen,
            goal: "sign in and reach the inbox",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
            site: "example-site",
          });
        },
        site.url,
      );

      expect(run.stop).toBe("done");
      expect(run.decisions).toBe(3);
      expect(run.finalUrl).toContain("/inbox");

      // The emitted Recording replays deterministically in a fresh session.
      await withSession(
        "explore-loop-replay-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [site.url]));
          const result = await new RecordingInterpreter().run(actor, run.recording);
          expect(result.outcome).toBe("completed");
          expect(fresh.page.url()).toContain("/inbox");
        },
        site.url,
      );
    },
    120_000,
  );

  it(
    "stops as exhausted at the decision cap (bounded, fail-closed)",
    async () => {
      const run = await withSession(
        "explore-exhaust-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          const judge = new ScriptedJudge([{ op: "wait" }]); // never done (a cap below MAX_QUIET_WAITS, so the budget ends it first)
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "loop forever",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
            bounds: { maxDecisions: 2 },
          });
        },
        site.url,
      );
      expect(run.stop).toBe("exhausted");
      expect(run.decisions).toBe(2);
    },
    120_000,
  );

  it(
    "stops as no-progress when a repeated non-wait action never changes the page",
    async () => {
      const run = await withSession(
        "explore-noprogress-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          // Scroll a page too short to scroll, forever: the action runs but the page never moves.
          const judge = new ScriptedJudge([{ op: "scroll_down" }]);
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "go nowhere",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
            bounds: { maxDecisions: 30 },
          });
        },
        site.url,
      );
      expect(run.stop).toBe("no-progress");
      expect(run.decisions).toBeLessThan(30);
    },
    120_000,
  );

  it("refuses an unauthorized start target before anything runs (guardrail #1)", async () => {
    await withSession(
      "explore-unauth-",
      async (session) => {
        const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
        await expect(
          explore({
            actor,
            judge: new ScriptedJudge([{ op: "done" }]),
            gen: new FakeGenerationGateway(),
            goal: "x",
            allowlist: ["https://only-this.example.com"],
            startUrl: `${site.url}/login`,
          }),
        ).rejects.toThrow(/not an authorized origin/);
      },
      site.url,
    );
  });
});

describe("explore — typed stops instead of throws (owner ruling 1)", () => {
  it(
    "a model decision that stays unavailable ends the run `inconclusive` with its transcript and Recording",
    async () => {
      const run = await withSession(
        "explore-inconclusive-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          const judge = {
            async systemOne(): Promise<never> {
              throw new Error("judgment provider unavailable");
            },
          };
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "sign in",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
          });
        },
        site.url,
      );
      expect(run.stop).toBe("inconclusive");
      expect(run.failure?.message).toBe("model decision unavailable: judgment provider unavailable");
      expect(run.transcript).toHaveLength(1);
      expect(run.transcript[0]).toMatchObject({ op: null, actOk: false });
      expect(run.recording.pages[0]?.steps[0]?.step.kind).toBe("navigate");
    },
    120_000,
  );

  it(
    "an unavailable value generator is a helper failure: the step fails, and the run carries on",
    async () => {
      const run = await withSession(
        "explore-helper-down-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "done" }]);
          const gen = {
            async generate(): Promise<never> {
              throw new Error("generation provider unavailable");
            },
          };
          return explore({
            actor,
            judge,
            gen,
            goal: "sign in",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
          });
        },
        site.url,
      );
      expect(run.stop).toBe("done");
      expect(run.transcript[0]).toMatchObject({
        op: "type",
        actOk: false,
        reason: "value generation unavailable: generation provider unavailable",
      });
      expect(run.decisions).toBe(2);
    },
    120_000,
  );

  it(
    "a page that dies mid-run ends `crashed` (page-closed), never a thrown error",
    async () => {
      const run = await withSession(
        "explore-crash-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          const scripted = new ScriptedJudge([{ op: "click", target: "1" }]);
          // The judge closes the page before answering: the loop's next page read hits a dead page.
          const judge: JudgmentPort = {
            async systemOne(args) {
              await session.page.close();
              return scripted.systemOne(args);
            },
          };
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "sign in",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
          });
        },
        site.url,
      );
      expect(run.stop).toBe("crashed");
      expect(run.failure?.kind).toBe("page-closed");
      expect(run.transcript.length).toBeLessThanOrEqual(1);
      expect(run.recording.pages[0]?.steps[0]?.step.kind).toBe("navigate");
    },
    120_000,
  );
});
