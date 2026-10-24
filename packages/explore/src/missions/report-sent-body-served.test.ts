import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";
import { NO_WRITE_YET } from "../goal-loop/handle-done.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #649 — the accuracy lab's `j3-phantom`: an import whose rows come from a prefilled CSV (nothing the
 * run typed) answers 2xx, renders the rows from what it sent, and stores nothing. What the write sent
 * — its request body — awaits read-back like typed values (#647): a report resting on the rendered
 * rows is accepted only once a page loaded from the server shows them.
 */

let stored: Array<{ name: string; email: string }> = [];
/** Whether the import keeps what it was sent (false: the phantom). */
let keeps = true;

const ROWS = [
  { name: "Ada Lovelace", email: "ada@example.com" },
  { name: "Katherine Johnson", email: "katherine@example.com" },
];

const importPage = `<!doctype html><html><body><nav><a href="/contacts">Contacts</a></nav><main><h1>Import contacts</h1>
<label>CSV <textarea aria-label="CSV" readonly>${ROWS.map((r) => `${r.name},${r.email}`).join("\n")}</textarea></label>
<button type="button" id="go">Import</button><ul id="out"></ul></main>
<script>
document.getElementById("go").addEventListener("click", async () => {
  const contacts = ${JSON.stringify(ROWS)};
  const r = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contacts }) });
  if (r.ok) document.getElementById("out").innerHTML = contacts.map((c) => "<li>" + c.name + " — " + c.email + "</li>").join("");
});
</script></body></html>`;

const contactsPage = (): string =>
  `<!doctype html><html><body><nav><a href="/import">Import</a></nav><main><h1>Contacts</h1><ul>${stored.map((c) => `<li>${c.name} — ${c.email}</li>`).join("")}</ul></main></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/import" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        if (keeps) stored.push(...(JSON.parse(raw) as { contacts: typeof ROWS }).contacts);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    if (path === "/import") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(importPage);
    if (path === "/contacts") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(contactsPage());
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  stored = [];
  keeps = true;
});

const GOAL = "Import the CSV of contacts shown on the page and confirm the imported rows appear. Finish by reporting the imported contacts.";

const ON_ROWS = {
  answer: "Imported Ada Lovelace",
  claims: [{ claim: "Ada Lovelace was imported", quote: "Ada Lovelace — ada@example.com", absent: null }],
};

async function run(steps: ScriptedStep[], judge = new ScriptedJudge(steps)): Promise<GoalBasedResult> {
  return withSession(
    "report-sent-body-",
    async (session) => {
      const actor = CastActor.named("importer").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway({ "goal.answer": ON_ROWS }),
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}/import`,
        waitOpMs: 300,
        safety: { allowWrites: true },
        bounds: { maxDecisions: 8 },
      });
    },
    origin,
  );
}

const accepted = (r: GoalBasedResult): boolean => r.transcript.some((e) => e.op === "report" && /report accepted/.test(e.reason ?? ""));

// /import: [0] Contacts (link), [1] CSV (read-only field), [2] Import.
describe("#649 — what a write sent awaits read-back, whoever typed it", () => {
  it(
    "a prefilled import that answers 2xx and stores nothing: a report on the rendered rows is not accepted",
    async () => {
      keeps = false;
      const r = await run([{ op: "click", target: "2" }, { op: "report" }]);
      expect(accepted(r)).toBe(false);
    },
    90_000,
  );

  it(
    "a prefilled import the app keeps: a report on the Contacts page listing the rows is accepted",
    async () => {
      const r = await run([{ op: "click", target: "2" }, { op: "click", target: "0" }, { op: "report" }]);
      expect(accepted(r)).toBe(true);
    },
    90_000,
  );

  it(
    "the model is told when a page loaded from the server shows what the run sent",
    async () => {
      const judge = new ScriptedJudge([{ op: "click", target: "2" }, { op: "click", target: "0" }, { op: "done" }]);
      await run([], judge);
      expect(judge.states.at(-1)?.history?.some((h) => h.startsWith("read back: this page"))).toBe(true);
    },
    90_000,
  );

  it(
    "#667 — the done judgment is given the read-back as a code fact",
    async () => {
      const judge = new ScriptedJudge([{ op: "click", target: "2" }, { op: "click", target: "0" }, { op: "done" }]);
      await run([], judge);
      const fact = judge.goalCalls.at(-1)?.state.controls.find((c) => c.startsWith("READ-BACK (observed by code"));
      expect(fact).toContain("this page shows 4 of them");
    },
    90_000,
  );

  it(
    "#667 — a done on a write goal before anything was imported is told no write succeeded",
    async () => {
      const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]);
      judge.goalMetProbability = 0.3;
      const r = await run([], judge);
      expect(r.transcript.find((e) => e.op === "done")?.reason).toContain(NO_WRITE_YET);
    },
    90_000,
  );

  it(
    "#680 — a rejected report on a write goal before anything was imported is told no write succeeded",
    async () => {
      const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "report" }]);
      const r = await run([], judge);
      expect(r.transcript.find((e) => e.op === "report")?.reason).toContain(NO_WRITE_YET);
      expect(judge.states.at(-1)?.history?.some((h) => h.startsWith("report rejected:") && h.includes(NO_WRITE_YET))).toBe(true);
    },
    90_000,
  );
});
