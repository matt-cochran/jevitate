import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { requestEndpoint, thirdPartyOrigin } from "../authorized-targets.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #194 on served pages. Dogfood (engine 8a71beb, a find-out goal): jevitate BLOCKED `POST /6` three
 * times as an app write — it was Stripe.js's fraud-signal beacon to `https://m.stripe.com/6`, a
 * third-party background request — and printed it without its host.
 *
 * The app runs on 127.0.0.1:<app>. A "third party" (a second server, NOT on the allowlist) is reached
 * as `localhost:<tp>` — another host, so another site. The same server reached as `127.0.0.1:<tp>`
 * (the app's own host on another port — an app API next to its UI) stays first-party: blocked.
 */

let app: Server;
let tp: Server;
let origin: string;
let tpPort: number;
let appWrites: string[] = [];
let tpWrites: string[] = [];

const pageHtml = (): string => `<!doctype html><html><body>
<h1>Plans</h1>
<p>Pro: $49/mo.</p>
<button id="details">Show details</button>
<p id="out"></p>
<script>
  // Stripe.js-style fraud beacon: an off-origin, no-cors POST — on a timer and again on any click.
  const beacon = () => fetch("http://localhost:${tpPort}/6", { method: "POST", mode: "no-cors", body: "sig" }).catch(() => {});
  setTimeout(beacon, 200);
  document.getElementById("details").addEventListener("click", () => {
    beacon();
    // The app's own write (must still be blocked) and a write to the app's host on another port.
    fetch("/api/track", { method: "POST" }).catch(() => {});
    fetch("http://127.0.0.1:${tpPort}/collect", { method: "POST", mode: "no-cors", body: "x" }).catch(() => {});
    document.getElementById("out").textContent = "details shown";
  });
</script>
</body></html>`;

beforeAll(async () => {
  tp = createServer((req, res) => {
    if (req.method === "POST") tpWrites.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
  });
  await new Promise<void>((resolve) => tp.listen(0, "127.0.0.1", resolve));
  tpPort = (tp.address() as AddressInfo).port;
  app = createServer((req, res) => {
    if (req.method === "POST") {
      appWrites.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml());
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => tp.close(() => resolve()));
});
beforeEach(() => {
  appWrites = [];
  tpWrites = [];
});

async function run(steps: ScriptedStep[]): Promise<GoalBasedResult> {
  const judge = new ScriptedJudge(steps);
  return withSession(
    "findout-third-party-",
    async (session) => {
      const actor = CastActor.named("findout").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway({
          "goal.answer": { answer: "Pro costs $49/mo.", claims: [{ claim: "Pro costs $49/mo", quote: "Pro: $49/mo." }] },
        }),
        goal: "Find out what the Pro plan costs.",
        allowlist: [origin],
        startUrl: `${origin}/plans`,
        waitOpMs: 800,
        bounds: { maxDecisions: 10 },
      });
    },
    origin,
  );
}

describe("a third-party beacon is not the mission's write (#194)", () => {
  it(
    "passes the off-origin beacon (listed with its full URL, thirdParty), still blocks the app's own writes",
    async () => {
      // Controls: [0] Show details. Wait (the timer beacon), click (beacon + app writes), wait, report.
      const result = await run([{ op: "wait" }, { op: "click", target: "0" }, { op: "wait" }, { op: "report" }]);
      const tpUrl = `http://localhost:${tpPort}/6`;

      // The beacon reached the third party both times — never aborted, not even inside the click's window.
      expect(tpWrites.filter((w) => w.endsWith("/6")).length).toBeGreaterThanOrEqual(2);
      // The app's own write and the write to the app's host on another port were aborted and reported.
      expect(appWrites).not.toContain("/api/track");
      expect(tpWrites.some((w) => w.endsWith("/collect"))).toBe(false);
      const blocked = result.transcript.filter((e) => e.strategy === "read-only").map((e) => e.reason ?? "");
      expect(blocked.some((r) => /POST \/api\/track/.test(r))).toBe(true);
      // Off an allowed origin: named origin + path, never a bare path.
      expect(blocked.some((r) => r.includes(`POST http://127.0.0.1:${tpPort}/collect`))).toBe(true);
      // The beacon is never refused.
      expect(blocked.some((r) => /\/6\b/.test(r))).toBe(false);

      // Side effects: the beacon is listed with its full URL and classified thirdParty; the app's are not.
      const beacons = result.run.sideEffects.filter((e) => e.request.endpoint === tpUrl);
      expect(beacons.length).toBeGreaterThanOrEqual(2);
      expect(beacons.every((e) => e.thirdParty === true)).toBe(true);
      expect(result.run.sideEffects.some((e) => e.request.endpoint === "/6")).toBe(false);
      const track = result.run.sideEffects.find((e) => e.request.endpoint === "/api/track");
      expect(track?.thirdParty).toBeUndefined();
      expect(result.outcome).toBe("succeeded");
    },
    60_000,
  );
});

describe("thirdPartyOrigin / requestEndpoint (#194)", () => {
  const allow = ["https://app.example.com"];
  it("third-party only off the allowed origins' hosts and sites (fail-closed)", () => {
    expect(thirdPartyOrigin("https://m.stripe.com/6", allow)).toBe("https://m.stripe.com");
    expect(thirdPartyOrigin("https://app.example.com/api/x", allow)).toBeNull();
    // A sibling subdomain or another port of an allowed host is the app's own.
    expect(thirdPartyOrigin("https://api.example.com/v1/charge", allow)).toBeNull();
    expect(thirdPartyOrigin("https://app.example.com:8443/x", allow)).toBeNull();
    expect(thirdPartyOrigin("http://127.0.0.1:9/x", ["http://127.0.0.1:3000"])).toBeNull();
    expect(thirdPartyOrigin("http://localhost:9/x", ["http://127.0.0.1:3000"])).toBe("http://localhost:9");
    // Unparseable, non-http(s), or no allowlist: never third-party.
    expect(thirdPartyOrigin("not a url", allow)).toBeNull();
    expect(thirdPartyOrigin("blob:https://m.stripe.com/abc", allow)).toBeNull();
    expect(thirdPartyOrigin("https://m.stripe.com/6", [])).toBeNull();
  });
  it("names an off-origin request with its origin, never its query", () => {
    expect(requestEndpoint("https://m.stripe.com/6?k=secret", allow)).toBe("https://m.stripe.com/6");
    expect(requestEndpoint("https://app.example.com/api/x?token=t", allow)).toBe("/api/x");
  });
});
