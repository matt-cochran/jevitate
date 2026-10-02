import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "../testkit.js";
import type { JudgmentState } from "@jevitate/ai-core";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #237 — the model's `blocked` was accepted as the run's FIRST step, on the start page, with 26
 * controls never tried (Settings among them): `defects-found`, exit 1, from zero exploration. A
 * `blocked` before any action is refused and fed back ("explore first"); a model that insists ends
 * the run `inconclusive` (insufficient-coverage) — never a defect.
 */

const page = (title: string, body: string): string => `<!doctype html><html><body>
<nav><a href="/home">Home</a> <a href="/workspace">Workspace</a> <a href="/settings">Settings</a></nav>
<h1>${title}</h1>${body}</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const html =
      req.url === "/settings"
        ? page("Settings", "<p>Plans: Free · Pro. The design partner programme is closed.</p>")
        : page("Home", "<p>Welcome back.</p>");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const GOAL = "Apply to become a design partner for this product, and submit the application.";

async function run(prefs: (n: number, s: JudgmentState) => readonly Preference[]): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = 0.1;
  const result = await withSession(
    "early-blocked-",
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
  return { result, judge };
}

describe("#237 — a model `blocked` before any exploration", () => {
  it(
    "is refused and fed back; after exploring, the model's `blocked` stands",
    async () => {
      // Gives up at once; once told to explore, it opens Settings, and gives up there.
      const { result, judge } = await run((n, s) =>
        s.history.some((h) => /blocked refused/.test(h)) && !s.url.endsWith("/settings") ? [{ op: "click", name: "Settings" }] : [],
      );
      expect(result.transcript[0]?.op).toBe("blocked");
      expect(result.transcript[0]?.actOk).toBe(false);
      expect(result.transcript[0]?.origin).toBe("engine");
      expect(judge.states[1]?.history.some((h) => /blocked refused: nothing was tried yet .*"Settings"/.test(h))).toBe(true);
      expect(result.transcript.some((e) => e.op === "click" && e.actOk && (e.target ?? "").includes('"Settings"'))).toBe(true);
      expect(result.run.stop).toBe("blocked");
      expect(result.outcome).toBe("blocked");
    },
    90_000,
  );

  it(
    "a model that insists without trying anything ends inconclusive (insufficient exploration), never defects-found",
    async () => {
      const { result } = await run(() => []);
      expect(result.transcript.filter((e) => e.op === "click" || e.op === "type")).toHaveLength(0);
      expect(result.run.stop).toBe("inconclusive");
      expect(result.run.failure?.kind).toBe("insufficient-coverage");
      expect(result.run.failure?.message).toMatch(/gave up before trying any of the page's \d+ controls/);
      expect(result.outcome).toBe("inconclusive");
    },
    90_000,
  );
});
