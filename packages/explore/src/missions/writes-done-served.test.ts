import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { WRITES_DONE_NOTE } from "../conversation.js";
import { ScriptedJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #514 — a goal mission's job whose write succeeded but left the page identical (the same contacts
 * imported again: nothing new to show). Served page, real Chromium, a scripted model and a page judge
 * that never sees the goal met (p 0.24, as in the dogfood).
 */

const PAGE = `<!doctype html><html><head><title>Contacts</title></head><body><h1>Contacts</h1>
<ul><li>Ada Lovelace</li><li>Grace Hopper</li></ul>
<button type="button" id="import">Import contacts</button>
<script>document.getElementById("import").addEventListener("click", () => {
  fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});</script></body></html>`;

let importStatus = 201;
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/import" && req.method === "POST") {
      req.resume();
      req.on("end", () => res.writeHead(importStatus, { "content-type": "application/json" }).end('{"imported":0}'));
      return;
    }
    if (path === "/contacts") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
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

async function run(): Promise<GoalBasedResult> {
  const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]);
  judge.goalMetProbability = 0.24;
  return withSession(
    "writes-done-",
    async (session) => {
      const actor = CastActor.named("importer").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Import the contacts.",
        allowlist: [origin],
        startUrl: `${origin}/contacts`,
        bounds: { maxDecisions: 6 },
      });
    },
    origin,
  );
}

describe("#514 — a goal mission whose writes succeeded on an unchanged page", () => {
  it(
    "ends succeeded, its done accepted on the succeeded writes with the repeat-data note",
    async () => {
      importStatus = 201;
      const r = await run();
      expect({ outcome: r.outcome, run: r.run.outcome, transcript: r.transcript.at(-1)?.reason }).toEqual({
        outcome: "succeeded",
        run: { status: "completed", verifiedBy: "succeeded-writes", note: WRITES_DONE_NOTE },
        transcript: `done accepted: goal verified by succeeded-writes — ${WRITES_DONE_NOTE}`,
      });
    },
    120_000,
  );

  it(
    "a failed write keeps today's rejection: not succeeded",
    async () => {
      importStatus = 500;
      const r = await run();
      expect(r.outcome).not.toBe("succeeded");
    },
    120_000,
  );
});
