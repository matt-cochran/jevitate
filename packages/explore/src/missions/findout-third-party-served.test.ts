import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { requestEndpoint, thirdPartyOrigin } from "../authorized-targets.js";
import type { SafetyConfig } from "../safety.js";
import { FirstPartyOrigins, hasApiCredentials } from "../third-party.js";
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
/** App backends on ANOTHER site (Supabase / Firestore / API Gateway-like), reached as localhost:<port>. */
let bearer: Backend;
let apikey: Backend;
let seen: Backend;

interface Backend {
  readonly server: Server;
  readonly port: number;
  /** Every request it received: `METHOD /path`. */
  readonly got: string[];
}

/** A permissive-CORS API server (answers the preflight a credential header triggers). */
async function backend(): Promise<Backend> {
  const got: string[] = [];
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "authorization, apikey, content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    got.push(`${req.method ?? ""} ${req.url ?? ""}`);
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, got };
}

const pageHtml = (): string => `<!doctype html><html><body>
<h1>Plans</h1>
<p>Pro: $49/mo.</p>
<button id="details">Show details</button>
<p id="out"></p>
<script>
  // Stripe.js-style fraud beacon: an off-origin, no-cors POST — on a timer and again on any click.
  const beacon = () => fetch("http://localhost:${tpPort}/6", { method: "POST", mode: "no-cors", body: "sig" }).catch(() => {});
  setTimeout(beacon, 200);
  // The app reads its own backend (another site) with a bearer token at load: that origin is the app's.
  fetch("http://localhost:${seen.port}/user", { headers: { authorization: "Bearer t0k" } }).catch(() => {});
  const post = (u, headers) => fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }).catch(() => {});
  document.getElementById("details").addEventListener("click", () => {
    beacon();
    // The app's own write (must still be blocked) and a write to the app's host on another port.
    fetch("/api/track", { method: "POST" }).catch(() => {});
    fetch("http://127.0.0.1:${tpPort}/collect", { method: "POST", mode: "no-cors", body: "x" }).catch(() => {});
    // The app's writes to backends on another site: credentialed, or to a backend seen credentialed.
    post("http://localhost:${bearer.port}/rest/v1/notes", { authorization: "Bearer t0k" });
    post("http://localhost:${apikey.port}/rest/v1/notes", { apikey: "anon-key" });
    post("http://localhost:${seen.port}/auth/v1/signup", {});
    document.getElementById("out").textContent = "details shown";
  });
</script>
</body></html>`;

beforeAll(async () => {
  [bearer, apikey, seen] = await Promise.all([backend(), backend(), backend()]);
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
  for (const b of [bearer, apikey, seen]) await new Promise<void>((resolve) => b.server.close(() => resolve()));
});
beforeEach(() => {
  appWrites = [];
  tpWrites = [];
  for (const b of [bearer, apikey, seen]) b.got.length = 0;
});

async function run(steps: ScriptedStep[], safety?: SafetyConfig): Promise<GoalBasedResult> {
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
        ...(safety === undefined ? {} : { safety }),
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
      // The click's beacon is listed against the step (the load-time one may predate the first mark).
      expect(beacons.some((e) => e.control === "Show details" && e.background === undefined)).toBe(true);
      expect(beacons.every((e) => e.thirdParty === true)).toBe(true);
      expect(result.run.sideEffects.some((e) => e.request.endpoint === "/6")).toBe(false);
      const track = result.run.sideEffects.find((e) => e.request.endpoint === "/api/track");
      expect(track?.thirdParty).toBeUndefined();
      expect(result.outcome).toBe("succeeded");
    },
    60_000,
  );

  it(
    "an app backend on another site is the app's: credentialed writes (Authorization, apikey) and an unauthenticated write to a backend seen credentialed are blocked",
    async () => {
      const result = await run([{ op: "wait" }, { op: "click", target: "0" }, { op: "wait" }, { op: "report" }]);

      // The credentialed read at load went through (a read); none of the backend writes did.
      expect(seen.got).toContain("GET /user");
      expect(bearer.got.filter((g) => g.startsWith("POST"))).toEqual([]);
      expect(apikey.got.filter((g) => g.startsWith("POST"))).toEqual([]);
      expect(seen.got.filter((g) => g.startsWith("POST"))).toEqual([]);
      const blocked = result.transcript.filter((e) => e.strategy === "read-only").map((e) => e.reason ?? "");
      const all = blocked.join("\n");
      // Named origin + path, with the hint how to declare or exempt it.
      expect(all).toContain(`POST http://localhost:${bearer.port}/rest/v1/notes`);
      expect(all).toContain(`POST http://localhost:${apikey.port}/rest/v1/notes`);
      expect(all).toContain(`POST http://localhost:${seen.port}/auth/v1/signup`);
      expect(all).toMatch(/add it to --allow/);
      expect(all).toContain(`--allow-write "http://localhost:${bearer.port}/<path glob>"`);
      // The credential-free beacon still passed, and only it is thirdParty.
      expect(tpWrites.filter((w) => w.endsWith("/6")).length).toBeGreaterThanOrEqual(2);
      const tpEffects = result.run.sideEffects.filter((e) => e.thirdParty === true);
      expect(tpEffects.length).toBeGreaterThan(0);
      expect(tpEffects.every((e) => e.request.endpoint === `http://localhost:${tpPort}/6`)).toBe(true);
    },
    60_000,
  );

  it(
    "an origin-qualified --allow-write glob lets that backend's write through deliberately",
    async () => {
      await run([{ op: "click", target: "0" }, { op: "wait" }, { op: "report" }], {
        allowWriteRequests: [`http://localhost:${apikey.port}/rest/**`],
      });
      expect(apikey.got).toContain("POST /rest/v1/notes");
      // Only that origin: the same path on the other backend is still blocked.
      expect(bearer.got.filter((g) => g.startsWith("POST"))).toEqual([]);
    },
    60_000,
  );
});

describe("FirstPartyOrigins (#194)", () => {
  const allow = ["https://app.example.com"];
  it("off-site and credential-free is third-party; credentials, or an origin seen credentialed, make it the app's", () => {
    const fp = new FirstPartyOrigins(allow);
    expect(fp.thirdParty("https://m.stripe.com/6", {})).toBe("https://m.stripe.com");
    expect(fp.thirdParty("https://abc.supabase.co/rest/v1/x", { authorization: "Bearer x" })).toBeNull();
    // Seen with credentials once: its unauthenticated writes are first-party too.
    expect(fp.thirdParty("https://abc.supabase.co/auth/v1/signup", {})).toBeNull();
    expect(fp.thirdParty("https://abc.supabase.co/auth/v1/signup")).toBeNull();
    expect(fp.thirdParty("https://xyz.execute-api.us-east-1.amazonaws.com/prod/x", { "X-Api-Key": "k" })).toBeNull();
    expect(fp.thirdParty("https://firestore.googleapis.com/v1/x", { "x-goog-api-key": "k" })).toBeNull();
    expect(fp.thirdParty("https://h.hasura.app/v1/graphql", { "x-hasura-admin-secret": "s" })).toBeNull();
    expect(fp.thirdParty("https://app.example.com/api", {})).toBeNull();
  });
  it("hasApiCredentials matches the credential header families case-insensitively", () => {
    expect(hasApiCredentials({ Authorization: "Bearer x" })).toBe(true);
    expect(hasApiCredentials({ apikey: "k" })).toBe(true);
    expect(hasApiCredentials({ "x-firebase-appcheck": "t" })).toBe(true);
    expect(hasApiCredentials({ "x-supabase-api-version": "1" })).toBe(true);
    expect(hasApiCredentials({ "content-type": "text/plain", accept: "*/*" })).toBe(false);
  });
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
