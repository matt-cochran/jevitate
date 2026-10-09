import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #447 — a grounded answer could not state an absence: "No controls allow starting or launching
 * calls" was rejected (quote not found), because a negative claim has no page text to quote. An
 * absence claim (`absent`: the missing thing's name) is grounded on the observed control inventory
 * and page text instead — accepted only when nothing observed matches the name (fail-closed).
 */

const OFF_HTML = `<!doctype html><html><body><main><h1>Calls</h1><p>Calling is off</p>
<button type="button">Settings</button></main></body></html>`;
const ON_HTML = `<!doctype html><html><body><main><h1>Calls</h1><p>Calling is off</p>
<button type="button">Settings</button><button type="button">Launch</button></main></body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end((req.url ?? "").startsWith("/on") ? ON_HTML : OFF_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const GOAL = "check there is no Launch control";
const ABSENCE = new FakeGenerationGateway({
  "goal.answer": {
    answer: "There is no Launch control: no control starts or launches calls.",
    claims: [{ claim: "No controls allow starting or launching calls", quote: "", absent: "Launch" }],
  },
});

async function run(path: string): Promise<ExploreRun> {
  return withSession(
    "explore-absence-claim-",
    async (session) => {
      const actor = CastActor.named("absence").whoCan(new BrowseTheWeb(session, [base]));
      return explore({ actor, judge: new ScriptedJudge([{ op: "report" }]), gen: ABSENCE, goal: GOAL, allowlist: [base], startUrl: `${base}${path}`, bounds: { maxDecisions: 4 } });
    },
    base,
  );
}

const reports = (r: ExploreRun) => r.transcript.filter((e) => e.op === "report");

describe("#447 — an absence claim on the observed control inventory", () => {
  it(
    "is accepted on the first answer when the page has no Launch control",
    async () => {
      const r = await run("/off");
      expect(reports(r)[0]?.actOk, reports(r)[0]?.reason).toBe(true);
    },
    60_000,
  );

  it(
    "is rejected when the page has a Launch button",
    async () => {
      const r = await run("/on");
      expect(reports(r)[0]?.reason).toMatch(/report rejected \(1\/3\): .*control "Launch" matches "Launch"/);
    },
    60_000,
  );
});
