import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #328 — a status that never completes ("Preparing QR…", an app defect): the model keeps choosing
 * `wait`. Each wait was patience, so the run spent its whole decision budget (120 decisions, 1
 * action). Once the job-wait budget is spent with the same status still shown, the run stops,
 * naming the stuck status.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Your QR code</h1>
<div role="status">Preparing QR…</div><button type="button">Exit</button></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#328 — a status that never completes is not waited on until the budget is gone", () => {
  it("stops once the job-wait budget is spent with the status unchanged, naming it", async () => {
    const result = await withSession(
      "stuck-status-",
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("patient").whoCan(new BrowseTheWeb(session, [origin])),
          judge: new ScriptedJudge([{ op: "wait" }]),
          gen: new FakeGenerationGateway({}),
          goal: "Show the QR code",
          allowlist: [origin],
          startUrl: `${origin}/qr`,
          successChecks: [{ kind: "page", assertion: { kind: "visible", target: { css: "img" } } }],
          jobWaitMs: 20_000,
          bounds: { maxDecisions: 120 },
          oracleTimeoutMs: 300,
        }),
      origin,
    );
    const waits = result.transcript.filter((e) => e.op === "wait").length;
    expect(result.run.stop).toBe("no-progress");
    expect(waits).toBeLessThan(30);
    expect(result.reason ?? "").toMatch(/still shows status "Preparing QR…".*job-wait budget/);
  }, 120_000);
});
