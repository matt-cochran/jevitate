import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { validateInvariantSpec, type InvariantSpec } from "@jevitate/recording";
import { runUsabilityMission, UsabilityInvariantsUnsupportedError } from "./ux-api.js";

/**
 * #150 — a mission spend budget over a declared observable, wired into the usability review (which
 * reuses `explore()`'s loop). Same credits fixture as `budget-served.test.ts`: a "Generate" button
 * that drops a credits counter by 50 per click. `maxDelta: -100` stops the review cleanly
 * (`missionOutcome: "inconclusive"`, `stop: "budget"`, never `clean`) after the 2nd click. Usability
 * does not check declared invariants/captures (#86/#147) — a spec carrying either is refused.
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

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Always clicks the sole candidate (the "Generate" button) and answers every UX-rubric question benignly. */
function scriptedJudge(): JudgmentPort {
  return {
    async systemOne({ questions }) {
      if ("action" in questions) return { action: { kind: "choice", value: "click:0", confidence: 0.9 } };
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.5 };
      }
      return out;
    },
  };
}

const CREDITS_SPEC = (): InvariantSpec =>
  validateInvariantSpec(
    {
      observe: { credits: { dom: { selector: "[data-testid=credits]", number: true } } },
      invariants: [],
      budget: [{ observe: "credits", maxDelta: -100 }],
    },
    { allowlist: [origin], baseUrl: `${origin}/app` },
  );

describe("mission spend budget (#150) — usability review", () => {
  it(
    "stops cleanly (missionOutcome inconclusive, stop budget) after 2 generations, and reports the trajectory — never clean",
    async () => {
      const result = await runUsabilityMission({
        url: `${origin}/app`,
        job: "generate credits",
        allowlist: [origin],
        appContext: { appClass: "internal-tool", job: "generate credits" },
        judge: scriptedJudge(),
        gen: new FakeGenerationGateway(),
        bounds: { maxDecisions: 10, maxActions: 10 },
        minConfidence: 0,
        browserPortFactory: () => new PlaywrightBrowserPort(),
        invariants: CREDITS_SPEC(),
      });

      expect(result.stop).toBe("budget");
      expect(result.missionOutcome).toBe("inconclusive");
      expect(result.missionOutcome).not.toBe("clean");

      expect(result.budget).toHaveLength(1);
      const b = result.budget?.[0];
      expect(b).toMatchObject({ observe: "credits", limit: -100, baseline: 1000, final: 900, delta: -100 });
      expect(b?.unreadable).toBeUndefined();
      const withChange = b?.perAction.filter((p) => p.before !== null && p.after !== null && p.before !== p.after) ?? [];
      expect(withChange).toEqual([
        { step: withChange[0]?.step, before: 1000, after: 950 },
        { step: withChange[1]?.step, before: 950, after: 900 },
      ]);
    },
    120_000,
  );

  it(
    "an unreadable budget observable fails closed: inconclusive",
    async () => {
      const spec = validateInvariantSpec(
        {
          observe: { gone: { dom: { selector: "[data-testid=nope]", number: true } } },
          invariants: [],
          budget: [{ observe: "gone", maxDelta: -10 }],
        },
        { allowlist: [origin], baseUrl: `${origin}/app` },
      );
      const result = await runUsabilityMission({
        url: `${origin}/app`,
        job: "generate credits",
        allowlist: [origin],
        appContext: { appClass: "internal-tool", job: "generate credits" },
        judge: scriptedJudge(),
        gen: new FakeGenerationGateway(),
        bounds: { maxDecisions: 10, maxActions: 10 },
        minConfidence: 0,
        browserPortFactory: () => new PlaywrightBrowserPort(),
        invariants: spec,
      });

      expect(result.stop).toBe("budget");
      expect(result.missionOutcome).toBe("inconclusive");
      expect(result.missionOutcome).not.toBe("clean");
      expect(result.budget?.[0]).toMatchObject({ observe: "gone", unreadable: true });
    },
    120_000,
  );

  it("refuses a spec that also declares invariants (not supported by usability)", async () => {
    const spec = validateInvariantSpec(
      {
        observe: { credits: { dom: { selector: "[data-testid=credits]", number: true } } },
        invariants: [{ id: "always-positive", require: "credits >= 0" }],
      },
      { allowlist: [origin], baseUrl: `${origin}/app` },
    );
    await expect(
      runUsabilityMission({
        url: `${origin}/app`,
        job: "generate credits",
        allowlist: [origin],
        appContext: { appClass: "internal-tool", job: "generate credits" },
        judge: scriptedJudge(),
        gen: new FakeGenerationGateway(),
        bounds: { maxDecisions: 2 },
        minConfidence: 0,
        browserPortFactory: () => new PlaywrightBrowserPort(),
        invariants: spec,
      }),
    ).rejects.toBeInstanceOf(UsabilityInvariantsUnsupportedError);
  });
});
