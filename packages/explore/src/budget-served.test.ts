import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec, type InvariantSpec } from "@jevitate/recording";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { ScriptedJudge } from "./testkit.js";

/**
 * #150 — a mission spend budget over a declared observable, against a served fixture: a "Generate"
 * button that drops a credits counter by 50 per click. `maxDelta: -100` stops the mission cleanly
 * (outcome `inconclusive`, `run.stop === "budget"`, never `succeeded`) after the 2nd click, with the
 * observed trajectory reported. A budget observable that cannot be read fails closed the same way.
 */

let server: Server;
let origin: string;

const APP = `<!doctype html><html><body>
  <p>Credits: <span data-testid="credits">1000</span></p>
  <button type="button" id="gen">Generate</button>
  <script>
    let credits = 1000;
    document.getElementById("gen").onclick = () => {
      credits -= 50;
      document.querySelector("[data-testid=credits]").textContent = String(credits);
    };
  </script>
</body></html>`;

// Two controls, each -50, so the adversarial mission's deterministic `exercise-controls` strategy
// (one settled click per not-yet-exercised control) reproduces the same "stop after 2 generations"
// shape as the goal mission's repeated single click.
const APP2 = `<!doctype html><html><body>
  <p>Credits: <span data-testid="credits">1000</span></p>
  <button type="button" id="genA">Generate A</button>
  <button type="button" id="genB">Generate B</button>
  <script>
    let credits = 1000;
    const spend = () => {
      credits -= 50;
      document.querySelector("[data-testid=credits]").textContent = String(credits);
    };
    document.getElementById("genA").onclick = spend;
    document.getElementById("genB").onclick = spend;
  </script>
</body></html>`;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
      return;
    }
    if (path === "/app2") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP2);
      return;
    }
    res.writeHead(404).end();
  });
  origin = await listen(server);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const port = new PlaywrightBrowserPort();

const CREDITS_SPEC = (): InvariantSpec =>
  validateInvariantSpec(
    {
      observe: { credits: { dom: { selector: "[data-testid=credits]", number: true } } },
      invariants: [],
      budget: [{ observe: "credits", maxDelta: -100 }],
    },
    { allowlist: [origin], baseUrl: `${origin}/app` },
  );

describe("mission spend budget (#150)", () => {
  it(
    "stops cleanly (outcome inconclusive, stop budget) after 2 generations, and reports the trajectory — never succeeded",
    async () => {
      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      const actor = CastActor.named("budget").whoCan(new BrowseTheWeb(session, [origin]));
      try {
        const result = await runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "click", target: "0" }]),
          gen: new FakeGenerationGateway(),
          goal: "spend credits by generating",
          allowlist: [origin],
          startUrl: `${origin}/app`,
          // Never actually holds: the run must stop on the budget, not on a lucky success match.
          successAssertion: { kind: "textIncludes", target: { testId: "credits" }, text: "never-shown-value" },
          oracleTimeoutMs: 300,
          waitOpMs: 300,
          bounds: { maxDecisions: 10, maxActions: 10 },
          invariants: CREDITS_SPEC(),
        });

        expect(result.run.stop).toBe("budget");
        expect(result.outcome).toBe("inconclusive");
        expect(result.outcome).not.toBe("succeeded");
        expect(result.reason).toMatch(/budget/);
        expect(result.reason).toMatch(/-100/);

        expect(result.budget).toHaveLength(1);
        const b = result.budget?.[0];
        expect(b).toMatchObject({ observe: "credits", limit: -100, baseline: 1000, final: 900, delta: -100 });
        expect(b?.unreadable).toBeUndefined();
        // Two generations recorded: 1000→950, 950→900 (plus the baseline-only first settle).
        const withChange = b?.perAction.filter((p) => p.before !== null && p.after !== null && p.before !== p.after) ?? [];
        expect(withChange).toEqual([
          { step: withChange[0]?.step, before: 1000, after: 950 },
          { step: withChange[1]?.step, before: 950, after: 900 },
        ]);
      } finally {
        await session.close();
      }
    },
    120_000,
  );

  it(
    "an unreadable budget observable fails closed: inconclusive, with the reason",
    async () => {
      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      const actor = CastActor.named("budget-unreadable").whoCan(new BrowseTheWeb(session, [origin]));
      try {
        const spec = validateInvariantSpec(
          {
            observe: { gone: { dom: { selector: "[data-testid=nope]", number: true } } },
            invariants: [],
            budget: [{ observe: "gone", maxDelta: -10 }],
          },
          { allowlist: [origin], baseUrl: `${origin}/app` },
        );
        const result = await runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "click", target: "0" }]),
          gen: new FakeGenerationGateway(),
          goal: "spend credits by generating",
          allowlist: [origin],
          startUrl: `${origin}/app`,
          successAssertion: { kind: "textIncludes", target: { testId: "credits" }, text: "never-shown-value" },
          oracleTimeoutMs: 300,
          waitOpMs: 300,
          bounds: { maxDecisions: 10, maxActions: 10 },
          invariants: spec,
        });

        expect(result.run.stop).toBe("budget");
        expect(result.outcome).toBe("inconclusive");
        expect(result.outcome).not.toBe("succeeded");
        expect(result.reason).toMatch(/could not be read|unreadable/);
        expect(result.budget?.[0]).toMatchObject({ observe: "gone", unreadable: true });
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});

const CREDITS_SPEC2 = (): InvariantSpec =>
  validateInvariantSpec(
    {
      observe: { credits: { dom: { selector: "[data-testid=credits]", number: true } } },
      invariants: [],
      budget: [{ observe: "credits", maxDelta: -100 }],
    },
    { allowlist: [origin], baseUrl: `${origin}/app2` },
  );

describe("mission spend budget (#150) — adversarial mission", () => {
  it(
    "stops cleanly (missionOutcome inconclusive, stop budget) after 2 generations, and reports the trajectory — never clean",
    async () => {
      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      const actor = CastActor.named("budget-adversarial").whoCan(new BrowseTheWeb(session, [origin]));
      try {
        const result = await runAdversarialMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/app2`,
          allowlist: [origin],
          bounds: { maxDecisions: 10, maxActions: 10 },
          strategies: ["exercise-controls"],
          safety: { allowDestructive: true },
          invariants: CREDITS_SPEC2(),
        });

        expect(result.stop).toBe("budget");
        expect(result.outcome).toBe("inconclusive");
        expect(result.outcome).not.toBe("clean");

        expect(result.budget).toHaveLength(1);
        const b = result.budget?.[0];
        expect(b).toMatchObject({ observe: "credits", limit: -100, baseline: 1000, final: 900, delta: -100 });
        expect(b?.unreadable).toBeUndefined();
        const withChange = b?.perAction.filter((p) => p.before !== null && p.after !== null && p.before !== p.after) ?? [];
        expect(withChange).toEqual([
          { step: withChange[0]?.step, before: 1000, after: 950 },
          { step: withChange[1]?.step, before: 950, after: 900 },
        ]);
      } finally {
        await session.close();
      }
    },
    120_000,
  );

  it(
    "an unreadable budget observable fails closed: inconclusive, with the reason",
    async () => {
      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      const actor = CastActor.named("budget-adversarial-unreadable").whoCan(new BrowseTheWeb(session, [origin]));
      try {
        const spec = validateInvariantSpec(
          {
            observe: { gone: { dom: { selector: "[data-testid=nope]", number: true } } },
            invariants: [],
            budget: [{ observe: "gone", maxDelta: -10 }],
          },
          { allowlist: [origin], baseUrl: `${origin}/app2` },
        );
        const result = await runAdversarialMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/app2`,
          allowlist: [origin],
          bounds: { maxDecisions: 10, maxActions: 10 },
          strategies: ["exercise-controls"],
          safety: { allowDestructive: true },
          invariants: spec,
        });

        expect(result.stop).toBe("budget");
        expect(result.outcome).toBe("inconclusive");
        expect(result.outcome).not.toBe("clean");
        expect(result.budget?.[0]).toMatchObject({ observe: "gone", unreadable: true });
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});
