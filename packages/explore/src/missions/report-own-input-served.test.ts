import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";
import { UNSAVED_WRITE_REASON } from "../answer.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #239 — a false success: "record a decision … finish by reporting the saved decision" was accepted
 * with nothing saved. The model typed into the form, submitted nothing, and reported — every claim
 * grounded on its OWN unsubmitted input (`source: "control-value"`). Real Chromium, a served form
 * whose save is a POST; a deterministic generator.
 */

let saved: unknown[] = [];

const FORM = `<!doctype html><html><body><main><h1>Start a bet</h1><p>Decisions you record appear in your ledger.</p>
<form id="f"><label>The bet <input name="bet" aria-label="The bet"></label>
<label>Context <textarea name="context" aria-label="Context"></textarea></label>
<button type="submit">Save decision</button></form><p role="status" id="s"></p></main>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  document.getElementById("s").textContent = r.ok ? "Saved" : "Failed";
});
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/decisions" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        saved.push(JSON.parse(raw));
        res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    if (path === "/decisions/new") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORM);
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
  saved = [];
});

const GOAL =
  "Record a real decision you're about to make — launching an annual plan at a 20% discount — with what's riskiest about it. Finish by reporting the saved decision and its riskiest assumption.";

/** The fake generator types `value:<label>`: a report quoting the field holding it. */
const ON_OWN_INPUT = {
  answer: "The bet is value:The bet",
  claims: [{ claim: "The bet is value:The bet", quote: "The bet: value:The bet", absent: null }],
};

async function run(steps: ScriptedStep[], answer: unknown): Promise<GoalBasedResult> {
  return withSession(
    "report-own-input-",
    async (session) => {
      const actor = CastActor.named("recorder").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "goal.answer": answer }),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}/decisions/new`,
        waitOpMs: 300,
        // --allow-writes, as in the dogfood run.
        safety: { allowWrites: true },
        bounds: { maxDecisions: 8 },
      });
    },
    origin,
  );
}

const reports = (r: GoalBasedResult) => r.transcript.filter((e) => e.op === "report").map((e) => e.reason ?? "");

// /decisions/new: [0] The bet, [1] Context, [2] Save decision.
describe("#239 — a report never grounds on the run's own unsaved input", () => {
  it(
    "typed, never submitted, reported on the field's value: rejected (the run's own input), never succeeded",
    async () => {
      const r = await run([{ op: "type", target: "0" }, { op: "type", target: "1" }, { op: "report" }], ON_OWN_INPUT);
      expect(saved).toHaveLength(0);
      expect(r.outcome).not.toBe("succeeded");
      expect(r.run.answer).toBeUndefined();
      expect(reports(r)[0]).toMatch(/the quote is the run's own typed input in "The bet", never saved/);
    },
    90_000,
  );

  it(
    "a write goal's report on page text, before anything was saved: rejected — no write of the run succeeded",
    async () => {
      const onPage = { answer: "Decisions you record appear in your ledger.", claims: [{ claim: "Decisions appear in the ledger", quote: "Decisions you record appear in your ledger.", absent: null }] };
      const r = await run([{ op: "type", target: "0" }, { op: "report" }], onPage);
      expect(r.outcome).not.toBe("succeeded");
      expect(reports(r)[0]).toContain(UNSAVED_WRITE_REASON);
    },
    90_000,
  );

  it(
    "typed, saved (a 2xx write), then reported on the field's value: the value is the app's now — accepted",
    async () => {
      const r = await run([{ op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }, { op: "report" }], ON_OWN_INPUT);
      expect(saved).toHaveLength(1);
      expect(reports(r).at(-1)).toMatch(/report accepted/);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "The bet" });
    },
    90_000,
  );
});
