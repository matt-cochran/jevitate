import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { SuccessCheck } from "./success-checks.js";
import { runGoalBasedMission, type SuccessWhen } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #337 — a goal whose checks live on different pages: "Connected" on Connections (after a click),
 * then "Payments ready" on Pricing. No single page holds both, so `final` and `held` (all together)
 * can never pass; `each` passes once each check went from not holding to holding, in any order, and
 * the run stops there instead of acting on.
 */
const CONNECTIONS = `<!doctype html><html><head><title>Connections</title></head><body>
<h1>Connections</h1><p id="st">Offline</p>
<button onclick="document.getElementById('st').textContent = 'Connected'">Connect payments</button>
<a href="/pricing">Pricing</a>
</body></html>`;
const PRICING = `<!doctype html><html><head><title>Pricing</title></head><body>
<h1>Pricing</h1><p>Payments ready</p><a href="/connections">Connections</a>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) =>
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/pricing" ? PRICING : CONNECTIONS),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const checks: SuccessCheck[] = [
  { kind: "page", assertion: { kind: "textIncludes", target: { css: "#st" }, text: "Connected" } },
  { kind: "page", assertion: { kind: "visible", target: { text: "Payments ready" } } },
];

async function run(successWhen: SuccessWhen) {
  // Controls on /connections: [0] Connect payments, [1] Pricing. The extra steps after reaching
  // Pricing (back to Connections) are what `each` never takes: it stops once both checks held.
  const judge = new ScriptedJudge([
    { op: "click", target: "0" },
    { op: "click", target: "1" },
    { op: "click", target: "0" },
    { op: "done" },
  ]);
  return withSession(
    "success-when-each-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin])),
        judge,
        gen: new FakeGenerationGateway({}),
        goal: "Connect the payment provider, then confirm pricing shows payments are ready",
        allowlist: [origin],
        startUrl: `${origin}/connections`,
        successChecks: checks,
        successWhen,
        oracleTimeoutMs: 500,
      }),
    origin,
  );
}

describe("--success-when each: checks on different pages (#337)", () => {
  it("each: succeeds once every check held at some step, and stops there", async () => {
    const r = await run("each");
    expect(r.outcome).toBe("succeeded");
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.checks[0]?.detail).toMatch(/held at settled step \d+ \(--success-when each\)/);
    // It stopped on Pricing: the scripted step back to Connections never ran.
    expect(r.finalUrl).toMatch(/\/pricing$/);
  }, 60_000);

  it("final and held cannot pass a goal whose checks are on different pages", async () => {
    for (const when of ["final", "held"] as const) {
      const r = await run(when);
      expect(r.outcome, when).not.toBe("succeeded");
    }
  }, 120_000);
});
