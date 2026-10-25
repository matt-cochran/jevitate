import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "../testkit.js";
import type { JudgmentState } from "@jevitate/ai-core";

useSkippingTime({ per: "all" });

/**
 * #693 — after prior actions, a model `blocked` must not stand while the page still has an obvious,
 * enabled, untried forward control that the goal and the page's own instruction both name.
 */
const GOAL = "Choose the design and submit the application.";
const DESIGN_HTML = `<!doctype html><html><body>
<h1>Design</h1>
<p>Choose the design to continue.</p>
<a href="/home">Back</a>
<button type="button">Choose the design</button>
</body></html>`;
const HOME_HTML = `<!doctype html><html><body>
<h1>Home</h1>
<a href="/design">Start</a>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/design" ? DESIGN_HTML : HOME_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(prefs: (n: number, s: JudgmentState) => readonly Preference[]): Promise<GoalBasedResult> {
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = 0.1;
  return withSession(
    "primary-forward-blocked-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}/home`,
        waitOpMs: 300,
        bounds: { maxDecisions: 12 },
      });
    },
    origin,
  );
}

const afterPriorAction = (n: number, s: JudgmentState): readonly Preference[] => (n === 0 ? [{ op: "click", name: "Start" }] : []);

describe("#693 — blocked with an obvious goal-matching forward control still untried", () => {
  it(
    "refuses the blocked decision after a prior action",
    async () => {
      const result = await run(afterPriorAction);
      expect(result.transcript.find((e) => e.op === "blocked")?.actOk).toBe(false);
    },
    90_000,
  );

  it(
    "names the untried forward control in the engine's refusal",
    async () => {
      const result = await run(afterPriorAction);
      const reasons = result.transcript.filter((e) => e.op === "blocked").map((e) => e.reason ?? "");
      expect(reasons.some((r) => /blocked refused: .*"Choose the design".*untried/.test(r))).toBe(true);
    },
    90_000,
  );

  it(
    "ends inconclusive after the bounded refusals",
    async () => {
      const result = await run(afterPriorAction);
      expect(result.run).toMatchObject({ stop: "inconclusive", failure: { kind: "insufficient-coverage" } });
    },
    90_000,
  );
});
