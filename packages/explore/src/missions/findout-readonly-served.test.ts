import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SafetyConfig } from "../safety.js";
import { DEFAULT_ALLOWED_WRITES, goalAsksForChange, pathGlob } from "../read-only.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #157 / #158 on a served pricing page. Allumata dogfood round 2: asked what the Design Partner plan
 * costs, the goal model clicked "Upgrade to Design Partner" (a checkout session reserved one of 250
 * seats) and "Manage subscription", though the answer was on the page; and a correct answer naming
 * "no2fa" was rejected because the "2" inside the word counted as a stated figure.
 */

const BILLING_HTML = `<!doctype html><html><body>
<h1>Billing</h1>
<p>Design Partner: $299/mo · 24 months, then Validate.</p>
<p>Every plan includes 2FA and the v2 API.</p>
<button id="up">Upgrade to Design Partner</button>
<button id="manage">Manage subscription</button>
<button id="details">Show details</button>
<p id="out"></p>
<script>
  const post = (u) => fetch(u, { method: "POST" }).then(() => { document.getElementById("out").textContent = "sent " + u; }, () => {});
  document.getElementById("up").addEventListener("click", () => post("/api/checkout"));
  document.getElementById("manage").addEventListener("click", () => post("/api/portal"));
  // A harmless-looking control that still writes: only the network guard can stop it.
  document.getElementById("details").addEventListener("click", () => post("/api/track"));
</script>
</body></html>`;

/**
 * An authenticated page with a ROTATING refresh token: a timer POSTs /auth/refresh with the current
 * token; the server accepts only the latest one. A refresh that fails signs the page out (to /login).
 * A heartbeat timer POSTs /api/heartbeat. "Show usage" is a read-looking control that POSTs /api/track.
 */
const SESSION_HTML = `<!doctype html><html><body>
<h1>Usage</h1>
<p>Seats used: 12 of 250.</p>
<p id="who">Signed in</p>
<button id="usage">Show usage</button>
<script>
  let token = "t0";
  // One refresh at a time (the next is scheduled once the last rotated the token).
  const refresh = () =>
    fetch("/auth/refresh", { method: "POST", body: token })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("refresh rejected"))))
      .then((t) => { token = t; setTimeout(refresh, 150); }, () => { location.href = "/login"; });
  setTimeout(refresh, 150);
  setInterval(() => { fetch("/api/heartbeat", { method: "POST" }).catch(() => {}); }, 150);
  document.getElementById("usage").addEventListener("click", () => { fetch("/api/track", { method: "POST" }).catch(() => {}); });
</script>
</body></html>`;

let server: Server;
/** The refresh token the server accepts next (rotating). */
let current = "t0";
let refreshes = 0;
let staleRefreshes = 0;
let origin: string;
let writes: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/auth/refresh") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        refreshes += 1;
        if (body !== current) {
          staleRefreshes += 1;
          res.writeHead(401).end();
          return;
        }
        current = `t${refreshes}`;
        res.writeHead(200, { "content-type": "text/plain" }).end(current);
      });
      return;
    }
    if (req.method === "POST") {
      writes.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const url = req.url ?? "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      url.startsWith("/usage") ? SESSION_HTML : url.startsWith("/login") ? "<!doctype html><h1>Sign in</h1>" : BILLING_HTML,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  writes = [];
  current = "t0";
  refreshes = 0;
  staleRefreshes = 0;
});

const GOAL = "Find out: what does the Design Partner plan cost, and for how long? What happens after that period? Report the answer.";

const ANSWER = {
  "goal.answer": {
    answer: "Design Partner costs $299/mo for 24 months, then moves to Validate. It includes 2FA and the v2 API.",
    claims: [
      { claim: "Design Partner costs $299/mo for 24 months, then Validate", quote: "Design Partner: $299/mo · 24 months, then Validate" },
      { claim: "It includes 2FA and the v2 API", quote: "Every plan includes 2FA and the v2 API" },
    ],
  },
};

async function run(
  steps: ScriptedStep[],
  safety?: SafetyConfig,
  opts: { readonly path?: string; readonly goal?: string; readonly gen?: FakeGenerationGateway; readonly waitOpMs?: number } = {},
): Promise<{ result: GoalBasedResult; judge: ScriptedJudge }> {
  const judge = new ScriptedJudge(steps);
  const result = await withSession(
    "findout-readonly-",
    async (session) => {
      const actor = CastActor.named("findout").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: opts.gen ?? new FakeGenerationGateway(ANSWER),
        goal: opts.goal ?? GOAL,
        allowlist: [origin],
        startUrl: `${origin}${opts.path ?? "/settings/billing"}`,
        waitOpMs: opts.waitOpMs ?? 300,
        // The app's timers (a refresh, a heartbeat) are background work for the settle rule.
        settle: { ignoreRequests: ["/auth/refresh", "/api/heartbeat"] },
        bounds: { maxDecisions: 10 },
        ...(safety === undefined ? {} : { safety }),
      });
    },
    origin,
  );
  return { result, judge };
}

describe("a find-out goal is read-only by default (#158) and answers with 2FA/v2 are grounded (#157)", () => {
  it(
    "never clicks Upgrade / Manage subscription, blocks a write a harmless control fires, and still answers from the page",
    async () => {
      // Controls: [0] Upgrade to Design Partner, [1] Manage subscription, [2] Show details.
      const { result, judge } = await run([
        { op: "click", target: "0" },
        { op: "click", target: "1" },
        { op: "click", target: "2" },
        { op: "report" },
      ]);

      // No write ever reached the server.
      expect(writes).toEqual([]);
      // Both flow controls were refused by code, before any interaction — recorded as engine refusals.
      const refusals = result.transcript.filter((e) => e.origin === "engine" && /read-only/.test(e.reason ?? ""));
      expect(refusals.some((e) => e.op === "click" && /Upgrade to Design Partner/.test(e.reason ?? ""))).toBe(true);
      expect(refusals.some((e) => e.op === "click" && /Manage subscription/.test(e.reason ?? ""))).toBe(true);
      // Show details was clicked, but the POST it fired was aborted in the browser and recorded.
      expect(refusals.some((e) => e.strategy === "read-only" && /POST \/api\/track/.test(e.reason ?? ""))).toBe(true);
      // The model was told the goal is read-only, and about each refusal.
      const history = judge.states.at(-1)?.history ?? [];
      expect(history.some((h) => /READ-ONLY/.test(h))).toBe(true);
      expect(history.some((h) => /Upgrade to Design Partner/.test(h) && /read-only/.test(h))).toBe(true);

      // The grounded answer — "2FA" and "v2" are words, not figures (#157).
      expect(result.outcome).toBe("succeeded");
      expect(result.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(result.run.answer?.text).toContain("2FA");
    },
    60_000,
  );

  it(
    "--allow-writes lets the find-out goal write (the #116 safety policy still holds)",
    async () => {
      const { result } = await run([{ op: "click", target: "2" }, { op: "click", target: "0" }, { op: "report" }], { allowWrites: true });

      expect(writes).toEqual(["/api/track"]);
      expect(result.transcript.some((e) => e.strategy === "read-only")).toBe(false);
      // Upgrade is still a paid control the goal does not ask for: refused by #116, not by the read-only guard.
      const upgrade = result.transcript.find((e) => e.op === "click" && /Upgrade/.test(e.reason ?? ""));
      expect(upgrade?.reason).toMatch(/refused by the safety policy/);
      expect(result.outcome).toBe("succeeded");
    },
    60_000,
  );
});

describe("read-only blocks only what an action fires — the app's own writes pass (#158)", () => {
  it(
    "a timer-driven rotating token refresh and a heartbeat go through (session stays valid); a click-triggered POST is aborted",
    async () => {
      const gen = new FakeGenerationGateway({
        "goal.answer": { answer: "12 of 250 seats are used.", claims: [{ claim: "12 of 250 seats are used", quote: "Seats used: 12 of 250" }] },
      });
      // Controls: [0] Show usage. Wait (background only), click (its POST is blocked), wait, report.
      const { result } = await run(
        [{ op: "wait" }, { op: "click", target: "0" }, { op: "wait" }, { op: "report" }],
        undefined,
        { path: "/usage", goal: "Find out how many seats are used.", gen, waitOpMs: 800 },
      );

      // The click's write never reached the server; it is recorded as blocked.
      expect(writes).not.toContain("/api/track");
      expect(result.transcript.some((e) => e.strategy === "read-only" && /POST \/api\/track/.test(e.reason ?? ""))).toBe(true);
      // The refresh was never blocked (not even inside the click's window): the session stayed valid.
      expect(refreshes).toBeGreaterThan(0);
      expect(staleRefreshes).toBe(0);
      expect(new URL(result.run.finalUrl).pathname).toBe("/usage");
      expect(result.transcript.some((e) => /\/auth\/refresh/.test(e.reason ?? ""))).toBe(false);
      // The heartbeat outside the action window passed, listed as a background side effect.
      expect(writes).toContain("/api/heartbeat");
      const bg = result.run.sideEffects.filter((e) => e.background === true);
      expect(bg.some((e) => e.request.endpoint === "/api/heartbeat")).toBe(true);
      expect(result.outcome).toBe("succeeded");
    },
    60_000,
  );

  it("built-in auth-refresh globs and --allow-write globs match paths", () => {
    const g = (glob: string, path: string): boolean => pathGlob(glob).test(path);
    expect(g("**/refresh*", "/auth/refresh")).toBe(true);
    expect(g("**/refresh*", "/api/v1/session/refresh-token")).toBe(true);
    expect(g("**/token*", "/oauth/token")).toBe(true);
    expect(g("**/oauth/**", "/oauth/authorize/callback")).toBe(true);
    expect(g("**/auth/**/refresh*", "/api/auth/session/refresh")).toBe(true);
    expect(g("/api/track", "/api/track")).toBe(true);
    expect(g("/api/*", "/api/a/b")).toBe(false);
    expect(DEFAULT_ALLOWED_WRITES.some((d) => g(d, "/api/checkout"))).toBe(false);
  });
});

describe("goalAsksForChange", () => {
  it("a goal that asks for a change is not read-only; one that only asks about it is", () => {
    expect(goalAsksForChange("Create a new API key named 'ci'")).toBe(true);
    expect(goalAsksForChange("Upgrade to the Pro plan and report the price")).toBe(true);
    expect(goalAsksForChange(GOAL)).toBe(false);
    expect(goalAsksForChange("Find out how to add a teammate")).toBe(false);
    expect(goalAsksForChange("What happens if I delete my workspace?")).toBe(false);
    expect(goalAsksForChange("Find out what the plan is set to and when the quota resets")).toBe(false);
  });
});
