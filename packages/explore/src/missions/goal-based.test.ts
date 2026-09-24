import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { runGoalBasedMission } from "../index.js";
import { ScriptedJudge, withSession } from "../testkit.js";

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

describe("goal-based mission — independent oracle adjudicates (Task 10, guardrail #4)", () => {
  it(
    "succeeds ONLY when the user assertion holds — and emits a replayable Recording",
    async () => {
      const result = await withSession(
        "explore-goal-ok-",
        async (session) => {
          const actor = CastActor.named("m").whoCan(new BrowseTheWeb(session, [site.url]));
          return runGoalBasedMission({
            actor,
            judge: new ScriptedJudge([
              { op: "type", target: "0" },
              { op: "click", target: "1" },
              { op: "done" },
            ]),
            gen: new FakeGenerationGateway({ "form.value": { text: "jane" } }),
            goal: "sign in and reach the inbox",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
            successAssertion: { kind: "urlIncludes", text: "/inbox" },
            site: "example-site",
          });
        },
        site.url,
      );

      expect(result.assertionPassed).toBe(true);
      expect(result.outcome).toBe("succeeded");
      expect(result.finalUrl).toContain("/inbox");

      await withSession(
        "explore-goal-replay-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [site.url]));
          const r = await new RecordingInterpreter().run(actor, result.recording);
          expect(r.outcome).toBe("completed");
        },
        site.url,
      );
    },
    120_000,
  );

  it(
    "a premature model `done` does NOT succeed when the assertion fails (DONE is advisory)",
    async () => {
      const result = await withSession(
        "explore-goal-earlydone-",
        async (session) => {
          const actor = CastActor.named("m").whoCan(new BrowseTheWeb(session, [site.url]));
          return runGoalBasedMission({
            actor,
            // Jev claims done immediately on /login, before reaching the inbox.
            judge: new ScriptedJudge([{ op: "done" }]),
            gen: new FakeGenerationGateway(),
            goal: "sign in and reach the inbox",
            allowlist: [site.url],
            startUrl: `${site.url}/login`,
            successAssertion: { kind: "urlIncludes", text: "/inbox" },
            oracleTimeoutMs: 500,
          });
        },
        site.url,
      );

      expect(result.assertionPassed).toBe(false); // still on /login
      expect(result.outcome).toBe("blocked"); // NOT succeeded despite model done
      expect(result.finalUrl).toContain("/login");
    },
    120_000,
  );
});
