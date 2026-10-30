import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { monitorFor } from "./page-monitor.js";
import { perceive } from "./perceive.js";
import { classifyRequest, isDevServerAssetRead } from "./timing.js";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, useSkippingTime, withSession } from "./testkit.js";

// #745: Node and page time skip idle waits (a held request's ceiling); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #745 — the opt-in dev-server (Vite/HMR) settle policy. It discounts only requests CLASSIFIED as
 * `asset` (`GET`/`HEAD` scripts, styles, images and Vite modules), so a non-asset write keeps
 * settling waiting and stays tracked, and a configured API prefix still wins over a Vite-shaped
 * path (`/api/src/App.tsx` is `api`, never discounted).
 */

const open: ServerResponse[] = [];
const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    switch (path) {
      case "/dev":
        // A Vite-style cold load: an HMR WebSocket and pending module/image asset requests, all
        // started by an inline script so they never block the page's `load` event. No structural DOM
        // mutation after load.
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(
            `<button type="button">Go</button><script>addEventListener("load", () => { new WebSocket("ws://" + location.host + "/hmr"); fetch("/src/lazy.ts"); fetch("/@vite/client"); (new Image()).src = "/assets/logo.png"; });</script>`,
          ),
        );
        return;
      case "/write":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(
            `<button type="button">Save</button><script>fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada" }) });</script>`,
          ),
        );
        return;
      case "/api-dev":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<button type="button">Go</button><script>fetch("/api/src/module.ts");</script>`),
        );
        return;
      case "/src/lazy.ts":
      case "/@vite/client":
      case "/assets/logo.png":
      case "/api/save":
      case "/api/src/module.ts":
        open.push(res); // never answered — in flight for the whole settle wait
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of open) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Load `path` and run one dev-server-policy settle wait inside the session. */
async function settleUnderPolicy(path: string, ignoreRequest: (r: { url: string; method: string; resourceType: string }) => boolean) {
  return withSession(
    "settle-dev-server-",
    async (session) => {
      const monitor = monitorFor(session.page);
      await monitor.instrument();
      await session.page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(300);
      return monitor.waitSettled({ quietMs: 100, ceilingMs: 1_000, ignoreRequest });
    },
    origin,
  );
}

describe("#745 dev-server asset classification", () => {
  it("classifies an API-prefixed Vite-shaped path as api", () => {
    expect(classifyRequest({ url: "http://app.test/api/src/App.tsx", resourceType: "script" }, ["/api/"])).toBe("api");
  });

  it("discounts a Vite module read as a dev-server asset", () => {
    expect(isDevServerAssetRead({ url: "http://app.test/src/App.tsx", method: "GET", resourceType: "script" })).toBe(true);
  });

  it("never discounts a write, even to a Vite-shaped path", () => {
    expect(isDevServerAssetRead({ url: "http://app.test/src/save.ts", method: "POST", resourceType: "fetch" })).toBe(false);
  });

  it("does not discount an API-prefixed Vite-shaped read", () => {
    expect(isDevServerAssetRead({ url: "http://app.test/api/src/App.tsx", method: "GET", resourceType: "script" }, ["/api/"])).toBe(false);
  });
});

describe("#745 served dev-server settle", () => {
  it("settles while a Vite HMR socket and module churn are in flight", async () => {
    const result = await settleUnderPolicy("/dev", isDevServerAssetRead);
    expect(result.settled).toBe(true);
  });

  it("keeps waiting for a pending non-asset write under the dev-server policy", async () => {
    const result = await settleUnderPolicy("/write", isDevServerAssetRead);
    expect(result.settled).toBe(false);
  });

  it("still tracks a pending non-asset write under the dev-server policy", async () => {
    const result = await settleUnderPolicy("/write", isDevServerAssetRead);
    expect(result.pending.some((r) => r.method === "POST")).toBe(true);
  });

  it("keeps waiting for an API-prefixed Vite-shaped read", async () => {
    const result = await settleUnderPolicy("/api-dev", (r) => isDevServerAssetRead(r, ["/api/"]));
    expect(result.settled).toBe(false);
  });

  it("settles a perception on an HMR page under settle.devServer", async () => {
    const settled = await withSession(
      "settle-dev-server-perceive-",
      async (session) => {
        const monitor = monitorFor(session.page);
        await monitor.instrument();
        await session.page.goto(`${origin}/dev`, { waitUntil: "domcontentloaded" });
        const p = await perceive(session.page, { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 1_000, settleConfig: { devServer: true } });
        return p.settle.settled;
      },
      origin,
    );
    expect(settled).toBe(true);
  });

  it("applies settle.devServer through the monitor's own configure", async () => {
    const settled = await withSession(
      "settle-dev-server-configure-",
      async (session) => {
        const monitor = monitorFor(session.page);
        await monitor.instrument();
        await session.page.goto(`${origin}/dev`, { waitUntil: "domcontentloaded" });
        await session.page.waitForTimeout(300);
        monitor.configure({ devServer: true });
        const result = await monitor.waitSettled({ quietMs: 100, ceilingMs: 1_000 });
        return result.settled;
      },
      origin,
    );
    expect(settled).toBe(true);
  });

  it("settles the real goal-loop step on an HMR page under settle.devServer", async () => {
    const result = await withSession(
      "settle-dev-server-loop-",
      async (session) => {
        const actor = CastActor.named("ds").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "wait" }]),
          gen: new FakeGenerationGateway(),
          goal: "finish",
          allowlist: [origin],
          startUrl: `${origin}/dev`,
          successAssertion: { kind: "visible", target: { text: "Done" } },
          settle: { devServer: true },
          timingConfig: { apiPrefixes: ["/api/"] },
          // Bound the run after the first two decisions, so the first step's own timing (settled on
          // the seed) is the observable, not the goal outcome.
          bounds: { maxDecisions: 2 },
          stallMs: 300,
          oracleTimeoutMs: 100,
          renderWaitMs: 4_000,
          requestBoundMs: 3_000,
          hangProbeMs: 1_000,
        });
      },
      origin,
    );
    expect(result.transcript[0]?.timing?.settled).toBe(true);
  });
});
