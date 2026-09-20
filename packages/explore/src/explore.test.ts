import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { explore, type Op } from "./index.js";
import { withSession } from "./testkit.js";

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

/** A JudgmentPort that plays a fixed sequence of op+target decisions. */
class ScriptedJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly seq: ReadonlyArray<{ op: Op; target?: string }>) {}
  async systemOne(args: { questions: Record<string, unknown> }): Promise<Record<string, Answer>> {
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)]!;
    this.#i += 1;
    const out: Record<string, Answer> = { op: { kind: "choice", value: cur.op, confidence: 0.9 } };
    if (args.questions.target && cur.target !== undefined) {
      out.target = { kind: "choice", value: cur.target, confidence: 0.9 };
    }
    return out;
  }
}

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
          const judge = new ScriptedJudge([{ op: "wait" }]); // never done
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "loop forever",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
            bounds: { maxDecisions: 4 },
          });
        },
        site.url,
      );
      expect(run.stop).toBe("exhausted");
      expect(run.decisions).toBe(4);
    },
    120_000,
  );

  it(
    "stops as no-progress when repeated actions never change the page",
    async () => {
      const run = await withSession(
        "explore-noprogress-",
        async (session) => {
          const actor = CastActor.named("explore").whoCan(new BrowseTheWeb(session, [site.url]));
          const judge = new ScriptedJudge([{ op: "click", target: "0" }]); // click the textbox forever
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
