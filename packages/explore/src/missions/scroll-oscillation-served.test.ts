import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #323 — a model that scrolls down and up beside its target (A→B→A→B…) on a page with more
 * controls than the candidate cap: each scroll moved the page AND changed the offered control set
 * (the signature), which reset the #172 moving-scroll bound every time, so no-progress never fired
 * and the run went on to its budget. Revisiting states the scroll streak has already seen now
 * counts toward the bound, and the run stops as no-progress.
 */
// A virtualized list (as React apps render long settings pages): only the rows in the viewport
// exist, so each scroll position offers a different control set — a different signature.
const PAGE = `<!doctype html><html><body style="margin:0"><h1>Settings</h1>
<div id="list" style="position:relative;height:7200px"></div><button id="save">Save</button>
<script>
  const list = document.getElementById("list");
  function render() {
    const top = Math.max(0, Math.floor(window.scrollY / 180) - 1);
    const rows = [];
    for (let i = top; i < Math.min(40, top + 6); i++) rows.push('<div style="position:absolute;top:' + i * 180 + 'px"><button>Row ' + (i + 1) + '</button></div>');
    list.innerHTML = rows.join("");
  }
  window.addEventListener("scroll", render);
  render();
</script></body></html>`;

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

describe("#323 — an oscillating scroll is no progress", () => {
  it("scrolling down and up beside the target stops as no-progress well before the decision budget", async () => {
    const steps: ScriptedStep[] = Array.from({ length: 60 }, (_, i) => ({ op: i % 2 === 0 ? "scroll_down" : "scroll_up" }) as ScriptedStep);
    const result = await withSession(
      "scroll-oscillation-",
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("hesitant").whoCan(new BrowseTheWeb(session, [origin])),
          judge: new ScriptedJudge(steps),
          gen: new FakeGenerationGateway({}),
          goal: "Turn on the two settings and save",
          allowlist: [origin],
          startUrl: `${origin}/`,
          successChecks: [{ kind: "page", assertion: { kind: "visible", target: { text: "Saved" } } }],
          bounds: { maxDecisions: 60 },
          oracleTimeoutMs: 300,
        }),
      origin,
    );
    const scrolls = result.transcript.filter((e) => e.op === "scroll_down" || e.op === "scroll_up").length;
    expect(result.run.stop).toBe("no-progress");
    expect(scrolls).toBeLessThan(40);
  }, 120_000);
});
