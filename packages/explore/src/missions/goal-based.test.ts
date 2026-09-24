import { createServer } from "node:http";
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
      expect(result.reason).toBeUndefined();
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
      // A `blocked` run carries no engine failure, but always says why it did not succeed.
      expect(result.reason).toMatch(/success check failed: .+ did not hold on the final page/);
      expect(result.finalUrl).toContain("/login");
    },
    120_000,
  );

  it(
    "a `runOutcome` of `completed` never accompanies an `outcome` of `blocked` (#113): the in-run `done` " +
      "grounding skips `reloadThen` (a mid-run reload would discard state the run is still building), so it " +
      "can accept `done` before the final, full check (which DOES reload) has a chance to fail",
    async () => {
      // A checkbox that flips a badge purely client-side — nothing is ever sent to a server, so a
      // reload always reverts it. The ONLY success check is `reloadThen`: filtered out of the in-run
      // check (which is left with nothing to fail on, so it accepts `done` right after the click).
      const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          `<!doctype html><html><body>
            <button type="button" onclick="document.getElementById('badge').textContent='Approved'">Approve</button>
            <p data-testid="badge">Pending</p>
          </body></html>`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as any).port}`;
      try {
        const result = await withSession(
          "explore-goal-runoutcome-",
          async (session) => {
            const actor = CastActor.named("m").whoCan(new BrowseTheWeb(session, [origin]));
            return runGoalBasedMission({
              actor,
              judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
              gen: new FakeGenerationGateway(),
              goal: "approve the badge",
              allowlist: [origin],
              startUrl: `${origin}/`,
              successChecks: [
                { kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "badge" }, text: "Approved" } },
              ],
              oracleTimeoutMs: 500,
            });
          },
          origin,
        );

        // The click never reached a server: a reload reverts it, so the final, full check
        // (which DOES include reloadThen) fails.
        expect(result.assertionPassed).toBe(false);
        expect(result.outcome).toBe("blocked");
        // The final verdict must override the in-run `completed` grounding — the two must never
        // disagree.
        expect(result.run.outcome.status).toBe("incomplete");
        if (result.run.outcome.status === "incomplete") {
          expect(result.run.outcome.reason).toMatch(/did not hold after a reload/);
          // The text actually read (#113) is in the reason, so the mismatch is visible.
          expect(result.run.outcome.reason).toMatch(/read: "Pending"/);
        }
        // The same failure detail is on the check itself.
        expect(result.checks[0]?.detail).toMatch(/did not hold after a reload \(read: "Pending"\)/);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      }
    },
    120_000,
  );
});
