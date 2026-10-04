import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #332 — the issue's repro, served for real: the model writes `8:00 AM` for an `<input type=time>`.
 * Playwright's fill throws "Malformed value" on it; the value is now typed in the input's wire
 * format (`08:00`), so the save goes through.
 */
const PAGE = `<!doctype html><html><head><title>Hours</title></head><body>
<h1>Opening hours</h1>
<label>Sat opens <input id="t" type="time"></label>
<button onclick="out.textContent = 'saved ' + t.value">Save</button>
<div id="out" data-testid="out"></div>
</body></html>`;

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

describe("goal mission — a date/time input gets its wire format (#332)", () => {
  it("types '8:00 AM' into <input type=time> as 08:00 and the save goes through", async () => {
    const gen = new FakeGenerationGateway({ "form.value": { text: "8:00 AM" } });
    // Controls: [0] Sat opens (time), [1] Save.
    const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]);
    const result = await withSession(
      "temporal-input-",
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin])),
          judge,
          gen,
          goal: "Set Saturday opening to 8 AM and save",
          allowlist: [origin],
          startUrl: `${origin}/`,
          successChecks: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "out" }, text: "saved 08:00" } }],
          oracleTimeoutMs: 500,
        }),
      origin,
    );

    expect(result.outcome).toBe("succeeded");
    const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
    expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([{ redacted: false, value: "08:00" }]);
  });
});
