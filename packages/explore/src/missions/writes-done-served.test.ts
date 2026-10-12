import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { WRITES_DONE_NOTE } from "../conversation.js";
import { GOAL_IS_WRITES_QUESTION } from "../decide.js";
import { ScriptedJudge, withSession, useSkippingTime, type ScriptedStep } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #514 — a goal mission's job whose write succeeded but left the page identical (the same contacts
 * imported again: nothing new to show). Served page, real Chromium, a scripted model and a page judge
 * that never sees the goal met (p 0.24, as in the dogfood); the advisory scope head ("the whole goal
 * is what these writes did") is staged per test.
 */

const PAGE = `<!doctype html><html><head><title>Contacts</title></head><body><h1>Contacts</h1>
<ul><li>Ada Lovelace</li><li>Grace Hopper</li></ul>
<button type="button" id="upload">Upload CSV</button>
<button type="button" id="import">Import contacts</button>
<script>
document.getElementById("upload").addEventListener("click", () => {
  fetch("/api/upload", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});
document.getElementById("import").addEventListener("click", () => {
  fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});</script></body></html>`;

let importStatus = 201;
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if ((path === "/api/import" || path === "/api/upload") && req.method === "POST") {
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

// Contacts: [0] Upload CSV, [1] Import contacts.
const IMPORT_THEN_DONE: ScriptedStep[] = [{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "done" }];

async function run(steps: ScriptedStep[], goalIsWrites: number): Promise<GoalBasedResult> {
  const judge = new ScriptedJudge(steps);
  judge.goalMetProbability = 0.24;
  judge.noulProbabilities = { [GOAL_IS_WRITES_QUESTION]: goalIsWrites };
  return withSession(
    "writes-done-",
    async (session) => {
      const actor = CastActor.named("importer").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Upload the contacts CSV, then import the contacts.",
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
      const r = await run(IMPORT_THEN_DONE, 0.95);
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
      const r = await run(IMPORT_THEN_DONE, 0.95);
      expect(r.outcome).not.toBe("succeeded");
    },
    120_000,
  );

  it(
    "an early done after the first step's 201, scoped as more than those writes, is not done",
    async () => {
      importStatus = 201;
      const r = await run([{ op: "click", target: "0" }, { op: "done" }], 0.2);
      expect(r.outcome).not.toBe("succeeded");
    },
    120_000,
  );
});
