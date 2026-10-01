import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference } from "../testkit.js";

/**
 * #276 — a run whose `--deny` refused every useful control, and whose model then only scrolled,
 * was stopped as an APP hang (`ui-no-progress`: "after click X the page returned to an earlier state
 * and made no progress"), exit 3 — although the app had answered every action. When the steps since
 * the app was last acted on were jevitate's own refusals (or scrolls that moved the page), the stall is the run's,
 * not the app's: plain no-progress.
 */

const HTML = `<!doctype html><html><body>
<h1>Reports</h1>
<button id="more">Show more</button>
<div id="extra" hidden><p>Quarterly figures: 12 exports this quarter.</p><button id="less">Show less</button></div>
<button>Export data</button> <button>Export CSV</button> <button>Export PDF</button>
<div style="height:3000px">Archive</div>
<script>
  document.getElementById("more").addEventListener("click", () => { document.getElementById("extra").hidden = false; document.getElementById("more").hidden = true; });
  document.getElementById("less").addEventListener("click", () => { document.getElementById("extra").hidden = true; document.getElementById("more").hidden = false; });
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(prefs: (n: number) => readonly Preference[]): Promise<GoalBasedResult> {
  const judge = new PreferenceJudge(prefs, "scroll_down");
  judge.goalMetProbability = 0.1;
  return withSession(
    "refused-no-hang-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Export the quarterly data as a file.",
        allowlist: [origin],
        startUrl: `${origin}/reports`,
        waitOpMs: 300,
        stallMs: 1_500,
        safety: { deny: ["Export"], allowWrites: true },
        bounds: { maxDecisions: 20 },
      });
    },
    origin,
  );
}

const EXPORTS: Preference[] = [
  { op: "click", name: "Export data" },
  { op: "click", name: "Export CSV" },
  { op: "click", name: "Export PDF" },
];

describe("#276 — refused actions are never an app hang", () => {
  it(
    "after an in-place return, steps that were all policy refusals end as no-progress, not ui-no-progress",
    async () => {
      const result = await run((n) => (n === 0 ? [{ op: "click", name: "Show more" }] : n === 1 ? [{ op: "click", name: "Show less" }] : EXPORTS));
      expect(result.transcript.filter((e) => e.origin === "engine" && /Export/.test(e.target ?? "")).length).toBeGreaterThanOrEqual(3);
      expect(result.run.stop).toBe("no-progress");
      expect(result.run.hang).toBeUndefined();
      expect(result.outcome).not.toBe("hang");
    },
    90_000,
  );

  it(
    "only scrolls that moved the page after the in-place return: no-progress too",
    async () => {
      // Reads up and down the long page: every scroll moves it (the app answers each one).
      const result = await run((n) =>
        n === 0 ? [{ op: "click", name: "Show more" }] : n === 1 ? [{ op: "click", name: "Show less" }] : [{ op: n % 2 === 0 ? "scroll_down" : "scroll_up" }],
      );
      expect(result.run.stop).toBe("no-progress");
      expect(result.run.hang).toBeUndefined();
    },
    90_000,
  );
});
