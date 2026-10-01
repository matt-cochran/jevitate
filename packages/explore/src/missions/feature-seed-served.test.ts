import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runFeatureMission } from "./feature.js";
import { withSession } from "../testkit.js";
import { snapshot } from "../snapshot.js";

/**
 * #277 — a feature mission seeded at a list page whose controls do not name the feature must still
 * follow the in-scope navigation (a project row → the piece that holds the feature) up to its budget.
 * #278 — a page that polls a status RPC every few seconds is idle between polls: the feature mission
 * perceives and acts on it, never stalls.
 */

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
let server: Server;
let origin: string;
let statusHits = 0;

/** A dismissible banner whose dismissal PERSISTS (like a real app's "don't show again"). */
const banner = `<div id="banner" role="region" aria-label="Announcement"><p>New: templates!</p>
  <button type="button" id="dismiss">Dismiss</button><button type="button" id="later">Remind me later</button></div>
  <script>
    if (localStorage.getItem("banner") === "off") document.getElementById("banner").remove();
    for (const id of ["dismiss", "later"]) {
      const b = document.getElementById(id);
      if (b) b.onclick = () => { localStorage.setItem("banner", "off"); document.getElementById("banner").remove(); };
    }
  </script>`;

/** Polls a status RPC every 1.5s and re-renders a status chip (the editor's "saved" indicator). */
const poller = `<p id="status">Status: idle</p><script>
  setInterval(() => {
    fetch("/rpc/status.v1.StatusService/GetStatus", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((r) => r.json()).then((j) => { document.getElementById("status").textContent = "Status: " + j.state; });
  }, 1500);
</script>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const send = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(html(body));
    switch (path) {
      case "/projects":
        return send(`${banner}<h1>Projects</h1><ul><li><a href="/projects/alpha">Alpha project</a></li></ul>`);
      case "/projects/alpha":
        return send(`<h1>Alpha</h1><a href="/projects/alpha/pieces/1">Chapter one</a>`);
      case "/projects/alpha/pieces/1":
        return send(
          `<h1>Chapter one</h1>${poller}<section aria-label="Detector findings"><h2>Detector findings</h2>
           <button type="button" onclick="document.getElementById('ev').hidden=false">Show evidence panel</button>
           <div id="ev" hidden><p>Evidence</p><button type="button" onclick="this.textContent='Removed'">Remove filler</button></div>
           <button type="button" onclick="document.getElementById('hm').hidden=false">Heatmap</button><div id="hm" hidden>Heat</div></section>`,
        );
      case "/workspace":
        // The banner's only control is a link OUT of scope that also dismisses it for good.
        return send(`<div id="nb"><a href="/changelog" onclick="localStorage.setItem('nb','off')">What's new</a></div>
          <script>if (localStorage.getItem("nb") === "off") document.getElementById("nb").remove();</script>
          <h1>Workspace</h1><a href="/workspace/alpha">Alpha project</a>`);
      case "/workspace/alpha":
        return send(`<h1>Alpha</h1><button type="button" onclick="this.textContent='Heatmap shown'">Heatmap</button>`);
      case "/changelog":
        return send(`<h1>Changelog</h1>`);
      case "/heatmap":
        // A heatmap of clickable words (many same-named role=button spans), re-rendered by a poller.
        return send(
          `<h1>Heatmap</h1><div>${Array.from({ length: 600 }, (_, i) => `<span role="button" tabindex="0" class="w">word${i % 40}</span>`).join(" ")}</div>
           <script>setInterval(() => fetch("/rpc/status.v1.StatusService/GetStatus", { method: "POST", body: "{}" })
             .then(() => document.querySelectorAll(".w").forEach((w) => w.setAttribute("data-h", String(Date.now() % 7)))), 3000);</script>`,
        );
      case "/rpc/status.v1.StatusService/GetStatus":
        statusHits += 1;
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: statusHits % 2 ? "saved" : "syncing" }));
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const feature = (seed: string, stallTimeoutMs = 60_000, routeGlobs: readonly string[] = ["/projects/**"]) =>
  withSession(
    "feature-seed-",
    async (session) => {
      const actor = CastActor.named("feature").whoCan(new BrowseTheWeb(session, [origin]));
      return runFeatureMission({
        actor,
        page: session.page,
        seedUrl: `${origin}${seed}`,
        allowlist: [origin],
        scope: { name: "detector findings: heatmap, evidence panel, fix and remove-filler actions", originAllowlist: [origin], routeGlobs },
        bounds: { maxActions: 40 },
        stallTimeoutMs,
      });
    },
    origin,
  );

describe("#277 — no seed control names the feature: in-scope navigation is still followed", () => {
  it("dismissing a persistent banner does not drop the seed's project row; the run reaches the feature", async () => {
    const r = await feature("/projects");
    const acted = r.transcript.filter((e) => e.actOk && e.op === "click").map((e) => e.target ?? "").join("\n");
    expect(acted).toContain("Alpha project");
    expect(acted).toContain("Chapter one");
    expect(r.coverage.relevantActionsExercised).toBeGreaterThan(0);
  }, 180_000);
});

describe("#277 — a seed that re-renders differently after a reset is queued afresh", () => {
  it("an out-of-scope banner link that dismisses itself for good does not end the run at the seed", async () => {
    const r = await feature("/workspace", 60_000, ["/workspace/**"]);
    const acted = r.transcript.filter((e) => e.actOk && e.op === "click").map((e) => e.target ?? "").join("\n");
    expect(acted).toContain("What's new");
    expect(acted).toContain("Alpha project");
    expect(acted).toContain("Heatmap");
    expect(r.coverage.relevantActionsExercised).toBeGreaterThan(0);
  }, 180_000);
});

describe("#278 — a page that polls a status RPC is idle between polls", () => {
  it("the feature mission seeded at the polling editor acts and finishes — never stalled", async () => {
    statusHits = 0;
    const r = await feature("/projects/alpha/pieces/1", 60_000);
    expect(r.outcome).not.toBe("stalled");
    expect(r.failure?.kind).not.toBe("stalled");
    expect(r.coverage.relevantActionsExercised).toBeGreaterThan(0);
    expect(statusHits).toBeGreaterThan(2);
  }, 180_000);
});

describe("#278 — reading a large polling page is bounded", () => {
  it("a snapshot of hundreds of same-named clickable words stops at its time bound and says it truncated", async () => {
    const r = await withSession(
      "feature-heatmap-",
      async (session) => {
        await session.page.goto(`${origin}/heatmap`);
        const t = Date.now();
        const snap = await snapshot(session.page, { budgetMs: 1_500 });
        return { snap, ms: Date.now() - t };
      },
      origin,
    );
    expect(r.snap.truncated).toBe(true);
    expect(r.snap.controls.length).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(10_000); // the bound plus one control's read, never the whole page
    // An ambiguous name resolves by ordinal (one query per rung, not one per same-named sibling).
    expect(r.snap.controls.some((c) => c.descriptor.ordinal !== undefined)).toBe(true);
  }, 120_000);
});
