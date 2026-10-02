import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SafetyConfig } from "../safety.js";
import { isDestructiveRequest } from "../read-only.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #253 — the find-out guard judges a form submit by the requests it SENDS: a lookup form's "Load"
 * (GETs + a `Get*` RPC) is clicked and answers the goal; a submit that writes is stopped at the
 * network (a JS POST aborted, a native form POST answered 204 in the browser — the page stays).
 *
 * #270 — a goal with no success check that asks for a change ("Remove a product…") is no longer
 * read-only, yet it must NEVER destroy: the member row's "Remove" is refused before the click, and a
 * harmless-named control that fires `RemoveMember` is aborted at the network.
 */

const BILLING_HTML = `<!doctype html><html><body>
<h1>Billing</h1>
<form id="lookup">
  <label for="ws">Workspace id</label><input id="ws" name="ws" />
  <button type="submit">Load</button>
</form>
<form id="grant"><label for="amt">Credits</label><input id="amt" value="10" /><button type="submit">Grant credits</button></form>
<form method="post" action="/api/notes"><input type="hidden" name="n" value="x" /><button type="submit">Record</button></form>
<p id="out"></p>
<script>
  document.getElementById("lookup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = encodeURIComponent(document.getElementById("ws").value || "demo");
    const money = await (await fetch("/v1/admin/billing/money/tenants/" + id)).json();
    await fetch("/acme.billing.BillingService/GetGrants", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    document.getElementById("out").textContent = "Revenue: $" + money.revenue + " · Cost: $" + money.cost;
  });
  document.getElementById("grant").addEventListener("submit", (e) => {
    e.preventDefault();
    fetch("/api/grants", { method: "POST", body: "10" }).catch(() => {});
  });
</script>
</body></html>`;

const TEAM_HTML = `<!doctype html><html><body>
<h1>Settings</h1>
<section aria-label="Products"><p>Product: Acme Analytics</p></section>
<section aria-label="Team">
  <p>sam@example.com</p>
  <select aria-label="role for sam@example.com"><option>Member</option><option>Admin</option></select>
  <button id="rm">Remove</button>
  <button id="tidy">Tidy up list</button>
  <button id="save">Save team name</button>
</section>
<p id="out"></p>
<script>
  const rpc = (m) => fetch("/simuli.org.OrgService/" + m, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then(() => { document.getElementById("out").textContent = m + " sent"; }, () => {});
  document.getElementById("rm").addEventListener("click", () => rpc("RemoveMember"));
  // A harmless-looking name: only the network guard can tell it destroys.
  document.getElementById("tidy").addEventListener("click", () => rpc("RemoveMember"));
  // A non-destructive write the change goal may make.
  document.getElementById("save").addEventListener("click", () => rpc("UpdateTeam"));
</script>
</body></html>`;

let server: Server;
let origin: string;
let writes: string[] = [];
let reads: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" || req.method === "DELETE") {
      if (url.includes("/Get")) reads.push(url);
      else writes.push(`${req.method} ${url}`);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (url.startsWith("/v1/admin/billing/money/tenants/")) {
      reads.push(url);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ revenue: 120, cost: 45 }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(url.startsWith("/settings") ? TEAM_HTML : BILLING_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  writes = [];
  reads = [];
});

async function run(
  steps: ScriptedStep[],
  opts: { readonly path: string; readonly goal: string; readonly gen: FakeGenerationGateway; readonly safety?: SafetyConfig },
): Promise<{ result: GoalBasedResult; judge: ScriptedJudge; url: string }> {
  const judge = new ScriptedJudge(steps);
  const out = await withSession(
    "findout-guard-requests-",
    async (session) => {
      const actor = CastActor.named("guard").whoCan(new BrowseTheWeb(session, [origin]));
      const result = await runGoalBasedMission({
        actor,
        judge,
        gen: opts.gen,
        goal: opts.goal,
        allowlist: [origin],
        startUrl: `${origin}${opts.path}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 10 },
        ...(opts.safety === undefined ? {} : { safety: opts.safety }),
      });
      return { result, url: session.page.url() };
    },
    origin,
  );
  return { ...out, judge };
}

describe("#253: a find-out submit is judged by the requests it sends", () => {
  it(
    "a lookup form's Load (GET + Get* RPC) is clicked and answers; a JS write submit and a native POST form are blocked at the network",
    async () => {
      const gen = new FakeGenerationGateway({
        "form.value": { text: "demo" },
        "goal.answer": {
          answer: "Workspace demo earns $120 revenue and costs $45.",
          claims: [{ claim: "revenue $120, cost $45", quote: "Revenue: $120 · Cost: $45" }],
        },
      });
      // Controls: [0] Workspace id, [1] Load, [2] Credits, [3] Grant credits, [4] Record.
      const { result, url } = await run(
        [{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "click", target: "3" }, { op: "click", target: "4" }, { op: "report" }],
        { path: "/admin/billing", goal: 'Check whether the workspace "demo" earns enough revenue to cover its cost. Report its revenue and cost figures.', gen },
      );

      // Load was never refused for its shape, and its reads reached the server.
      expect(result.transcript.some((e) => /"Load" submits a form/.test(e.reason ?? ""))).toBe(false);
      expect(reads).toContain("/v1/admin/billing/money/tenants/demo");
      expect(reads).toContain("/acme.billing.BillingService/GetGrants");
      // No write ever reached the server: the JS POST was aborted, the native form POST answered 204.
      expect(writes).toEqual([]);
      const blocked = result.transcript.filter((e) => e.strategy === "read-only").map((e) => e.reason ?? "");
      expect(blocked.some((r) => /POST \/api\/grants/.test(r))).toBe(true);
      expect(blocked.some((r) => /POST \/api\/notes/.test(r))).toBe(true);
      // The blocked native POST never left the page on an error page.
      expect(new URL(url).pathname).toBe("/admin/billing");
      expect(result.outcome).toBe("succeeded");
      expect(result.run.answer?.text).toContain("$120");
    },
    90_000,
  );
});

describe("#270: a goal without a success check never destroys without --allow-writes", () => {
  const GOAL = "Remove a product you no longer work on from your account. Finish by reporting whether you could and how.";
  const gen = (): FakeGenerationGateway =>
    new FakeGenerationGateway({
      "goal.answer": {
        answer: "The settings page lists the product Acme Analytics but offers no way to remove it.",
        claims: [{ claim: "the product is Acme Analytics", quote: "Product: Acme Analytics" }],
      },
    });

  it(
    "refuses the member row's Remove before the click, aborts a RemoveMember RPC a harmless-named control fires, and lets a non-destructive write through",
    async () => {
      // Controls: [0] role select, [1] Remove, [2] Tidy up list, [3] Save team name.
      const { result, judge } = await run(
        [{ op: "click", target: "1" }, { op: "click", target: "2" }, { op: "click", target: "3" }, { op: "report" }],
        { path: "/settings", goal: GOAL, gen: gen() },
      );

      // The destructive RPC never reached the server — by name or by request.
      expect(writes.filter((w) => /RemoveMember/.test(w))).toEqual([]);
      const refused = result.transcript.find((e) => e.op === "click" && e.origin === "engine" && /"Remove" is destructive/.test(e.reason ?? ""));
      expect(refused?.reason).toMatch(/--allow-writes/);
      expect(result.transcript.some((e) => e.strategy === "read-only" && /POST \/simuli\.org\.OrgService\/RemoveMember/.test(e.reason ?? ""))).toBe(true);
      // A change goal is not read-only: its non-destructive write went through.
      expect(writes).toContain("POST /simuli.org.OrgService/UpdateTeam");
      const history = judge.states.at(-1)?.history ?? [];
      expect(history.some((h) => /destructive actions .* are refused/.test(h))).toBe(true);
    },
    90_000,
  );

  it(
    "--allow-writes lifts it (the operator's decision, never the goal's words)",
    async () => {
      await run([{ op: "click", target: "1" }, { op: "report" }], { path: "/settings", goal: GOAL, gen: gen(), safety: { allowWrites: true } });
      expect(writes).toContain("POST /simuli.org.OrgService/RemoveMember");
    },
    90_000,
  );

  it("classifies destructive requests by code", () => {
    expect(isDestructiveRequest("POST", "/simuli.org.OrgService/RemoveMember")).toBe(true);
    expect(isDestructiveRequest("POST", "/simuli.org.OrgService/UpdateTeam")).toBe(false);
    expect(isDestructiveRequest("DELETE", "/api/members/4")).toBe(true);
    expect(isDestructiveRequest("POST", "/api/members/4/remove")).toBe(true);
    expect(isDestructiveRequest("POST", "/api/keys/revoke-all")).toBe(true);
    expect(isDestructiveRequest("POST", "/api/removals-report")).toBe(false);
    expect(isDestructiveRequest("POST", "/api/projects")).toBe(false);
  });
});
