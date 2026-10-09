import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime, type Preference } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #444 — an action that legitimately returns the page to an identical earlier state (a Refresh that
 * re-fetches the same JSON, a Done that removes a one-time reveal panel) was reported as a
 * `ui-no-progress` hang. A request that completed (2xx) followed by a stable DOM is settled.
 */

const HTML = `<!doctype html><html><body>
<main id="list"><h1>Items</h1><ul><li>Alpha</li><li>Beta</li></ul>
<button id="open">Open Alpha</button> <button id="reveal">Reveal key</button></main>
<section id="detail" hidden><h1>Alpha detail</h1><p>Updated on demand.</p><button id="refresh">Refresh</button></section>
<section id="panel" hidden><h1>Your one-time key</h1><p>k-1234-5678</p><button id="done">Done</button></section>
<section id="notice" hidden><h1>Heads up</h1><p>Exports moved to Settings.</p><button id="gotit">Got it</button></section>
<script>
  const show = (id) => { for (const s of ["list", "detail", "panel", "notice"]) document.getElementById(s).hidden = s !== id; };
  document.getElementById("open").addEventListener("click", () => show("detail"));
  document.getElementById("reveal").addEventListener("click", () => show("panel"));
  const back = async () => { const r = await fetch("/api/items"); await r.json(); show("list"); };
  document.getElementById("refresh").addEventListener("click", back);
  document.getElementById("done").addEventListener("click", back);
  document.getElementById("list").insertAdjacentHTML("beforeend", '<button id="news">Read notice</button>');
  document.getElementById("news").addEventListener("click", () => show("notice"));
  // no request at all: the panel just removes itself
  document.getElementById("gotit").addEventListener("click", () => show("list"));
</script>
</body></html>`;

/**
 * #463 — client-side tabs: Accounts (start) → Billing → Members → Accounts. Returning to the tab
 * the run started on is navigation. `mode` sets what the Accounts tab's click does besides rendering:
 * nothing (no request), a request the server rejects, or a request the server never answers.
 */
const tabsHtml = (mode: "none" | "fail" | "pending"): string => `<!doctype html><html><body>
<div role="tablist"><button role="tab" id="t-accounts" aria-selected="true">Accounts</button>
<button role="tab" id="t-billing" aria-selected="false">Billing</button>
<button role="tab" id="t-members" aria-selected="false">Members</button></div>
<section id="accounts"><h2>Accounts</h2><p>Two accounts.</p><button>Add account</button></section>
<section id="billing" hidden><h2>Billing</h2><p>Paid monthly.</p><button>Change plan</button></section>
<section id="members" hidden><h2>Members</h2><p>Three members.</p><button>Invite member</button></section>
<script>
  const tabs = ["accounts", "billing", "members"];
  const select = (id) => { for (const t of tabs) { document.getElementById(t).hidden = t !== id; document.getElementById("t-" + t).setAttribute("aria-selected", String(t === id)); } };
  document.getElementById("t-billing").addEventListener("click", () => select("billing"));
  document.getElementById("t-members").addEventListener("click", () => select("members"));
  document.getElementById("t-accounts").addEventListener("click", () => {
    select("accounts");
    if (${JSON.stringify(mode)} !== "none") fetch("/api/accounts-${mode}").catch(() => {});
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
const held: ServerResponse[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const tabs = /^\/tabs-(none|fail|pending)$/.exec(req.url ?? "");
    if (tabs !== null) res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(tabsHtml(tabs[1] as "none" | "fail" | "pending"));
    else if (req.url === "/api/accounts-fail") res.writeHead(500, { "content-type": "application/json" }).end("{}");
    else if (req.url === "/api/accounts-pending") held.push(res);
    else if (req.url === "/api/items") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(["Alpha", "Beta"]));
    else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of held) r.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(open: string, back: string, path = "/items"): Promise<GoalBasedResult> {
  return runClicks([open, back], path);
}

/** Clicks `names` in order, then only scrolls. */
async function runClicks(names: readonly string[], path: string): Promise<GoalBasedResult> {
  const prefs = (n: number): readonly Preference[] => {
    const name = names[n];
    return name === undefined ? [{ op: "scroll_down" }] : [{ op: "click", name }];
  };
  const judge = new PreferenceJudge(prefs, "scroll_down");
  judge.goalMetProbability = 0.1;
  return withSession(
    "return-to-earlier-state-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Read the list of items.",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        stallMs: 1_500,
        bounds: { maxDecisions: 12 },
      });
    },
    origin,
  );
}

describe("#444 — a completed request that returns to an earlier stable state is settled", () => {
  it("a Refresh that re-fetches identical JSON and returns to the list does not end as a hang", async () => {
    const result = await run("Open Alpha", "Refresh");
    expect(result.run.hang).toBeUndefined();
  }, 90_000);

  it("a Done that removes a one-time reveal panel and returns to the list does not end as a hang", async () => {
    const result = await run("Reveal key", "Done");
    expect(result.run.hang).toBeUndefined();
  }, 90_000);

  it("a Got it that closes a notice without any request and returns to the list does not end as a hang", async () => {
    const result = await run("Read notice", "Got it");
    expect(result.run.hang).toBeUndefined();
  }, 90_000);
});

describe("#463 — a settled tab click back to the starting tab is navigation, not a hang", () => {
  it("Accounts → Billing → Members → Accounts on client-side tabs (no request) does not end as a hang", async () => {
    const result = await runClicks(["Billing", "Members", "Accounts"], "/tabs-none");
    expect(result.run.hang).toBeUndefined();
  }, 90_000);

  it("the same return while the Accounts tab's request failed (500) is still a ui-no-progress hang", async () => {
    const result = await runClicks(["Billing", "Members", "Accounts"], "/tabs-fail");
    expect(result.run.hang?.signal.kind).toBe("ui-no-progress");
  }, 90_000);

  it("the same return while the Accounts tab's request is still pending past the window is still a hang", async () => {
    const result = await runClicks(["Billing", "Members", "Accounts"], "/tabs-pending");
    expect(result.run.hang).toBeDefined();
  }, 90_000);

  it("a tab click that changes nothing (the tab already shown) still ends as no-progress", async () => {
    const result = await runClicks(["Accounts", "Accounts", "Accounts"], "/tabs-none");
    expect(result.run.stop).toBe("no-progress");
  }, 90_000);
});
