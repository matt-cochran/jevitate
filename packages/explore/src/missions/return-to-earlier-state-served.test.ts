import { createServer, type Server } from "node:http";
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

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/items") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(["Alpha", "Beta"]));
    else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(open: string, back: string): Promise<GoalBasedResult> {
  const prefs = (n: number): readonly Preference[] =>
    n === 0 ? [{ op: "click", name: open }] : n === 1 ? [{ op: "click", name: back }] : [{ op: "scroll_down" }];
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
        startUrl: `${origin}/items`,
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
