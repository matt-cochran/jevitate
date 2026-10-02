import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #241 — a `send` into "Start a new inquiry" sent nothing (Enter there does nothing; the real action
 * is a separate Continue button), yet the loop waited ~15 minutes on "the reply is still on its way"
 * while only the page's background balance poll ran. A send that started no request and changed
 * nothing is a failed send (the model is told), and waits with nothing of the send's in flight are
 * quiet waits that end the run — background polling is not the reply being worked on.
 */

const HTML = `<!doctype html><html><body>
<h1>Workspace</h1>
<p>Balance: <span id="bal">0</span> credits</p>
<label>Start a new inquiry <input id="inq" type="text"></label>
<button id="go" disabled>Continue in this context →</button>
<script>
  setInterval(() => fetch("/api/balance").then((r) => r.json()).then((b) => { document.getElementById("bal").textContent = String(b.credits); }).catch(() => {}), 2000);
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/balance")) return void res.writeHead(200, { "content-type": "application/json" }).end("{\"credits\":0}");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(): Promise<{ result: GoalBasedResult; judge: PreferenceJudge; ms: number }> {
  // Sends once, then only waits — the model in the report.
  const judge = new PreferenceJudge((n) => (n === 0 ? [{ op: "send", name: "Start a new inquiry" }] : [{ op: "wait" }]));
  const t0 = Date.now();
  const result = await withSession(
    "failed-send-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Apply for the startup program plan for your workspace and submit the application.",
        allowlist: [origin],
        startUrl: `${origin}/workspace`,
        waitOpMs: 500,
        replyWaitMs: 6_000,
        replyCeilingMs: 6_000,
        bounds: { maxDecisions: 30 },
      });
    },
    origin,
  );
  return { result, judge, ms: Date.now() - t0 };
}

describe("#241 — a send that started nothing is a failed send, not a pending reply", () => {
  it(
    "the model is told its message was not sent, and the waits after it end the run instead of listening on",
    async () => {
      const { result, judge, ms } = await run();
      const send = result.transcript.find((e) => e.op === "send");
      expect(send?.actOk).toBe(false);
      expect(send?.reason).toMatch(/message was not sent/);
      expect(judge.states.some((s) => s.history.some((h) => /message was not sent: .*look for a send \/ continue control/.test(h)))).toBe(true);
      expect(result.transcript.some((e) => /the reply is still on its way/.test(e.reason ?? ""))).toBe(false);
      expect(result.run.stop).toBe("no-progress");
      expect(result.transcript.filter((e) => e.op === "wait").length).toBeLessThanOrEqual(4);
      // Never the reply ceiling per wait: bounded well below the old listen-on loop (generous under load).
      expect(ms).toBeLessThan(120_000);
    },
    180_000,
  );
});
