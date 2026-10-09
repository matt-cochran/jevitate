import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SettleConfig } from "../settle-config.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #274 / #284 on a served page (real Chromium). A safe control — a button that toggles a user menu
 * — fires no write of its own, but on every click a third-party SDK posts telemetry to ITS origin
 * (`navigator.sendBeacon` to a csp-report endpoint, a Stripe.js-like `fetch` beacon) and the app's
 * own analytics posts to `/api/ux/hits` (a name #374's built-in bookkeeping check does not know),
 * which the target declares background
 * (`--settle-ignore`). Before the fix the repeated-side-effect guard counted those beacons as the
 * menu's side effect and refused the second click ("repeated side effect refused: … already sent
 * POST https://<vendor>/csp-report → 200"), so the run could not reopen the menu.
 *
 * The app runs on 127.0.0.1:<app>; the vendor is a second server reached as `localhost:<tp>` —
 * another host, so another site, so third-party (#194).
 */

let app: Server;
let tp: Server;
let origin: string;
let tpPort: number;
let tpHits: string[] = [];
let telemetry = 0;

const pageHtml = (): string => `<!doctype html><html><body>
<h1>Dashboard</h1>
<button type="button" id="menu" aria-expanded="false">Open user menu</button>
<ul id="rows" hidden><li>Profile</li><li>Billing</li></ul>
<p id="opened">opened 0 times</p>
<script>
  let n = 0;
  document.getElementById("menu").addEventListener("click", () => {
    const rows = document.getElementById("rows");
    rows.hidden = !rows.hidden;
    document.getElementById("menu").setAttribute("aria-expanded", String(!rows.hidden));
    if (!rows.hidden) n += 1;
    document.getElementById("opened").textContent = "opened " + n + " times";
    // The vendor's own telemetry: fire-and-forget beacons to its origin.
    navigator.sendBeacon("http://localhost:${tpPort}/csp-report", JSON.stringify({ "csp-report": {} }));
    fetch("http://localhost:${tpPort}/6", { method: "POST", mode: "no-cors", body: "sig" }).catch(() => {});
    // The app's own analytics, declared background by the target.
    fetch("/api/ux/hits", { method: "POST", body: "{}" }).catch(() => {});
  });
</script>
</body></html>`;

beforeAll(async () => {
  tp = createServer((req, res) => {
    if (req.method === "POST") tpHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
  });
  await new Promise<void>((resolve) => tp.listen(0, "127.0.0.1", resolve));
  tpPort = (tp.address() as AddressInfo).port;
  app = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/ux/hits") {
      telemetry += 1;
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml());
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  app.closeAllConnections();
  tp.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => tp.close(() => resolve()));
});
beforeEach(() => {
  tpHits = [];
  telemetry = 0;
});

async function run(steps: ScriptedStep[], settle?: SettleConfig): Promise<GoalBasedResult> {
  return withSession(
    "side-effect-beacons-",
    async (session) => {
      const actor = CastActor.named("menu").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({
          "goal.answer": { answer: "The menu lists Profile and Billing.", claims: [{ claim: "Profile is a row", quote: "Profile", absent: null }] },
        }),
        goal: "Open the menu twice and report its rows.",
        allowlist: [origin],
        startUrl: `${origin}/dashboard`,
        waitOpMs: 500,
        bounds: { maxDecisions: 8 },
        safety: { allowWrites: true },
        ...(settle === undefined ? {} : { settle }),
      });
    },
    origin,
  );
}

const refusals = (r: GoalBasedResult): string[] =>
  r.transcript.map((e) => e.reason ?? "").filter((reason) => /repeated side effect refused/.test(reason));

describe("third-party / --settle-ignore beacons are not a control's side effect (#274, #284)", () => {
  it(
    "the safe menu control is clicked again (open, close, open) — never refused; the beacons are still listed",
    async () => {
      // Controls: [0] Open user menu.
      const result = await run(
        [{ op: "click", target: "0" }, { op: "click", target: "0" }, { op: "click", target: "0" }, { op: "report" }],
        { ignoreRequests: ["/api/ux/*"] },
      );
      expect(refusals(result)).toEqual([]);
      const clicks = result.transcript.filter((e) => e.op === "click");
      expect(clicks).toHaveLength(3);
      expect(clicks.every((c) => c.actOk)).toBe(true);
      // Every click's beacons went out (nothing was blocked or refused).
      expect(tpHits.filter((u) => u === "/csp-report").length).toBeGreaterThanOrEqual(3);
      expect(telemetry).toBeGreaterThanOrEqual(3);
      // Still recorded as evidence: the vendor's beacons are listed, marked thirdParty.
      const vendor = result.run.sideEffects.filter((e) => e.request.endpoint.startsWith(`http://localhost:${tpPort}/`));
      expect(vendor.length).toBeGreaterThan(0);
      expect(vendor.every((e) => e.thirdParty === true)).toBe(true);
    },
    90_000,
  );

  it(
    "without the --settle-ignore declaration, the app's own first-party POST is still guarded (refused on repeat)",
    async () => {
      const result = await run([{ op: "click", target: "0" }, { op: "click", target: "0" }, { op: "report" }]);
      const refused = refusals(result);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(refused[0]).toContain("POST /api/ux/hits");
      // The third-party beacons are never named as the control's side effect.
      expect(refused.join("\n")).not.toContain(`localhost:${tpPort}`);
    },
    90_000,
  );
});
