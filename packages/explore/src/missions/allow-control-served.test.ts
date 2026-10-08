import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SafetyConfig } from "../safety.js";
import { ScriptedJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #428 — a mission was refused a click on a benign 'Generate Your First Key' button by the built-in
 * "may cost money" heuristic, and the refusal didn't say which rule matched. Real Chromium, a served
 * API-keys page whose button POSTs a new key: without an exemption the refusal names
 * `builtin:may-cost-money`; with `allowControl: ["^Generate Your First Key$"]` (`--allow-control`) the
 * button is clicked and the exemption is recorded in the result.
 */

let generated = 0;

const page = (): string => `<!doctype html><html><body><main><h1>API keys</h1>
<p id="keys">${generated === 0 ? "No keys yet" : `${generated} key(s)`}</p>
<button type="button" id="g">Generate Your First Key</button><p role="status" id="s"></p></main>
<script>
document.getElementById("g").addEventListener("click", async () => {
  const r = await fetch("/api/keys", { method: "POST" });
  document.getElementById("s").textContent = r.ok ? "Key created" : "Failed";
});
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/keys" && req.method === "POST") {
      generated += 1;
      res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (path === "/keys") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  generated = 0;
});

async function run(safety: SafetyConfig): Promise<GoalBasedResult> {
  return withSession(
    "allow-control-",
    async (session) => {
      const actor = CastActor.named("keys").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        // [0] Generate Your First Key
        judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
        gen: new FakeGenerationGateway(),
        goal: "Open the API keys page and get an API key for the account",
        allowlist: [origin],
        startUrl: `${origin}/keys`,
        waitOpMs: 300,
        safety,
        successChecks: [{ kind: "textIncludes", target: { css: "#s" }, text: "Key created" }],
        bounds: { maxDecisions: 4 },
      });
    },
    origin,
  );
}

describe("#428 — a refusal names its rule; --allow-control exempts one benign control", () => {
  it(
    "without the exemption: 'Generate Your First Key' is refused and the reason names builtin:may-cost-money",
    async () => {
      const r = await run({});
      const refused = r.transcript.find((e) => e.safety !== undefined);
      expect({ generated, ruleId: refused?.safety?.ruleId, control: refused?.safety?.control, reason: refused?.reason }).toMatchObject({
        generated: 0,
        ruleId: "builtin:may-cost-money",
        control: "Generate Your First Key",
        reason: expect.stringContaining('[rule builtin:may-cost-money, matched "Generate"]'),
      });
    },
    90_000,
  );

  it(
    'with allowControl "^Generate Your First Key$": the button is clicked and the override is recorded',
    async () => {
      const r = await run({ allowControl: ["^Generate Your First Key$"] });
      expect({ generated, overrides: r.run.safetyOverrides }).toEqual({
        generated: 1,
        overrides: [{ regex: "^Generate Your First Key$", control: "Generate Your First Key", ruleId: "builtin:may-cost-money", pattern: "Generate", step: 1 }],
      });
    },
    90_000,
  );
});
