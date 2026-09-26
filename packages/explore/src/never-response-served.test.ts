import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec, type InvariantSpec } from "@jevitate/recording";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge } from "./testkit.js";

/**
 * #195 part 3 — `never: { response: { url, status } }` on the mission's OWN captured traffic: a role
 * that gets a guaranteed 403 from the billing API on every page is a hard, pinned defect whose
 * evidence is the request itself (method, full URL, status, step). Served fixture + real Chromium.
 */

let billingStatus = 403;
let server: Server;
let other: Server;
let origin: string;
let otherOrigin: string;

const APP = (): string => `<!doctype html><html><body><main>
  <h1>Workspace</h1>
  <p id="plan">loading</p>
  <button type="button" id="usage">Usage</button>
  <script>
    fetch("/api/v1/tool/billing/summary?ws=7").then((r) => { document.getElementById("plan").textContent = "plan " + r.status; });
    // A 403 on a path the invariant does not name, and one from ANOTHER origin on a matching path.
    fetch("/api/v1/profile").catch(() => {});
    fetch(${JSON.stringify("__OTHER__")} + "/api/v1/tool/billing/summary").catch(() => {});
    document.getElementById("usage").onclick = () => {
      fetch("/api/v1/tool/billing/usage").then((r) => { document.getElementById("plan").textContent = "usage " + r.status; });
    };
  </script></main></body></html>`;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP().replace("__OTHER__", otherOrigin));
      return;
    }
    if (path.startsWith("/api/v1/tool/billing/")) {
      res.writeHead(billingStatus, { "content-type": "application/json" }).end(JSON.stringify({ ok: billingStatus < 400 }));
      return;
    }
    if (path === "/api/v1/profile") {
      res.writeHead(403, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  other = createServer((_req, res) => {
    res.writeHead(403, { "content-type": "application/json", "access-control-allow-origin": "*" }).end("{}");
  });
  origin = await listen(server);
  otherOrigin = await listen(other);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
});
beforeEach(() => {
  billingStatus = 403;
});

const port = new PlaywrightBrowserPort();

const spec = (url: string, status: string): InvariantSpec =>
  validateInvariantSpec({ invariants: [{ id: "no-billing-403", never: { response: { url, status } } }] }, { allowlist: [origin], baseUrl: `${origin}/app` });

async function mission(invariants: InvariantSpec) {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("viewer").whoCan(new BrowseTheWeb(session, [origin]));
  try {
    return await runGoalBasedMission({
      actor,
      judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
      gen: new FakeGenerationGateway(),
      goal: "open usage",
      allowlist: [origin],
      startUrl: `${origin}/app`,
      oracleTimeoutMs: 300,
      waitOpMs: 300,
      bounds: { maxDecisions: 6 },
      invariants,
    });
  } finally {
    await session.close();
  }
}

describe("never.response on the mission's own traffic (#195)", () => {
  it(
    "a billing 403 is a defect whose evidence is the request: method, full URL, status and step",
    async () => {
      const r = await mission(spec("/api/v1/tool/billing/**", "403"));
      expect(r.outcome).toBe("defects-found");
      const defects = r.invariantDefects ?? [];
      expect(defects.length).toBeGreaterThanOrEqual(1);
      // One finding per route (id + route fingerprint); the page load's 403 is the first occurrence,
      // the click's 403 on the same page a second one.
      expect(defects).toHaveLength(1);
      const d = defects[0]!;
      expect(d.occurrences).toBe(2);
      expect(d.invariant).toMatchObject({ id: "no-billing-403", kind: "never" });
      // The request is the evidence: method, the FULL URL (query included), status and step.
      expect(d.invariant.evidence).toEqual([`GET ${origin}/api/v1/tool/billing/summary?ws=7 → 403 (step 0: page load)`]);
      expect(d.invariant.responses).toEqual([{ method: "GET", url: `${origin}/api/v1/tool/billing/summary?ws=7`, status: 403, step: 0 }]);
      // Never the 403 on a path the glob does not name, nor one from another (unauthorized) origin.
      const text = JSON.stringify(d);
      expect(text).not.toContain("/api/v1/profile");
      expect(text).not.toContain(otherOrigin);
      expect(r.reason).toMatch(/invariant no-billing-403 violated/);
    },
    60_000,
  );

  it(
    "an invariant on the action's request fires at that step (method-narrowed)",
    async () => {
      const r = await mission(
        validateInvariantSpec(
          { invariants: [{ id: "no-usage-403", never: { response: { url: "/api/v1/tool/billing/usage", status: 403, method: "get" } } }] },
          { allowlist: [origin], baseUrl: `${origin}/app` },
        ),
      );
      expect(r.outcome).toBe("defects-found");
      const [d] = r.invariantDefects ?? [];
      expect(d?.invariant.evidence).toEqual([`GET ${origin}/api/v1/tool/billing/usage → 403 (step 1: click "Usage")`]);
      expect(d?.invariant.responses).toEqual([{ method: "GET", url: `${origin}/api/v1/tool/billing/usage`, status: 403, step: 1 }]);
      expect(d?.repro.recordingStepIndex).toBeGreaterThanOrEqual(0);
    },
    60_000,
  );

  it(
    "a status class (4xx) matches too",
    async () => {
      const r = await mission(spec("/api/v1/tool/billing/*", "4xx"));
      expect(r.outcome).toBe("defects-found");
      expect((r.invariantDefects ?? []).flatMap((d) => d.invariant.evidence).join("\n")).toMatch(/billing\/summary\?ws=7 → 403/);
    },
    60_000,
  );

  it(
    "negative: billing answering 200, the invariant holds (a 403 elsewhere is not its business)",
    async () => {
      billingStatus = 200;
      const r = await mission(spec("/api/v1/tool/billing/**", "403"));
      expect(r.invariantDefects ?? []).toEqual([]);
      expect(r.outcome).not.toBe("defects-found");
      const report = (r.invariants ?? []).find((i) => i.id === "no-billing-403");
      expect(report?.violated).toBe(0);
      expect(report?.held).toBeGreaterThan(0);
    },
    60_000,
  );
});
