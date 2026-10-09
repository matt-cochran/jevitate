import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { installHealProbeGuard } from "./heal-probe-guard.js";
import { useSkippingTime, withSession } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #453 review: the heal probe's write guard has NO exemptions (an auth-refresh-looking path, a
 * credential-free third party), guards popups and WebSocket sends at the context level, and refuses
 * to guard a page a service worker is registered for.
 */

const received: string[] = [];
let wsFrames = 0;
const sockets: { destroy(): void }[] = [];

const PAGE = `<!doctype html><html><body><h1>Probe</h1></body></html>`;
const POPUP = `<!doctype html><html><body><script>fetch("/api/popup-write", { method: "POST" });</script></body></html>`;
const SW_PAGE = `<!doctype html><html><body><h1>SW</h1></body></html>`;

let server: Server;
let origin: string;
let thirdParty: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "OPTIONS") received.push(`${req.method} ${req.url}`);
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") return void res.writeHead(204, { "access-control-allow-methods": "POST", "access-control-allow-headers": "*" }).end();
    if (req.url === "/popup") return void res.writeHead(200, { "content-type": "text/html" }).end(POPUP);
    if (req.url === "/sw.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end("self.addEventListener('fetch', () => {});");
    if (req.url === "/sw") return void res.writeHead(200, { "content-type": "text/html" }).end(SW_PAGE);
    res.writeHead(req.method === "GET" ? 200 : 204, { "content-type": "text/html" }).end(req.method === "GET" ? PAGE : "");
  });
  // A minimal WebSocket endpoint: completes the handshake and counts every frame it receives.
  server.on("upgrade", (req, socket) => {
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", () => void wsFrames++);
    socket.on("error", () => undefined);
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  thirdParty = `http://localhost:${port}`;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("heal probe guard (#453 review, served)", () => {
  it("blocks a POST to an auth-refresh-looking path the read-only guard exempts, and it never reaches the server", async () => {
    await withSession(
      "heal-guard-token",
      async (session) => {
        await session.page.goto(origin);
        const g = await installHealProbeGuard(session.page);
        await g.guard.armAt(1);
        await session.page.evaluate(() => fetch("/api/token", { method: "POST" }).catch(() => undefined));
        const blocked = await g.guard.disarm();
        await g.dispose();
        expect({ blocked: blocked.map((b) => `${b.method} ${new URL(b.url).pathname}`), received: received.filter((r) => r.includes("/api/token")) }).toEqual({ blocked: ["POST /api/token"], received: [] });
      },
      origin,
    );
  }, 120_000);

  it("blocks a credential-free POST to a third-party origin", async () => {
    await withSession(
      "heal-guard-third-party",
      async (session) => {
        await session.page.goto(origin);
        const g = await installHealProbeGuard(session.page);
        await g.guard.armAt(1);
        await session.page.evaluate((u) => fetch(`${u}/beacon`, { method: "POST" }).catch(() => undefined), thirdParty);
        const blocked = await g.guard.disarm();
        await g.dispose();
        expect(blocked.map((b) => b.url)).toEqual([`${thirdParty}/beacon`]);
      },
      origin,
    );
  }, 120_000);

  it("blocks a write a popup the probe opened sends", async () => {
    await withSession(
      "heal-guard-popup",
      async (session) => {
        await session.page.goto(origin);
        const g = await installHealProbeGuard(session.page);
        await g.guard.armAt(1);
        const popup = session.page.context().waitForEvent("page");
        await session.page.evaluate(() => void window.open("/popup"));
        await (await popup).waitForLoadState("load");
        const blocked = await g.guard.disarm();
        await g.dispose();
        expect(blocked.map((b) => `${b.method} ${new URL(b.url).pathname}`)).toContain("POST /api/popup-write");
      },
      origin,
    );
  }, 120_000);

  it("drops a WebSocket frame the page sends while a probe is armed and reports it", async () => {
    await withSession(
      "heal-guard-ws",
      async (session) => {
        // Installed before the page loads (as a run does): its sockets are proxied from the start.
        const g = await installHealProbeGuard(session.page);
        await session.page.goto(origin);
        const wsUrl = origin.replace("http", "ws");
        // BROWSER CODE
        await session.page.evaluate(
          (u) =>
            new Promise<void>((resolve) => {
              const ws = new WebSocket(u);
              (window as unknown as { __ws: WebSocket }).__ws = ws;
              ws.onopen = () => resolve();
            }),
          `${wsUrl}/live`,
        );
        const before = wsFrames;
        await g.guard.armAt(1);
        await session.page.evaluate(() => (window as unknown as { __ws: WebSocket }).__ws.send("delete everything"));
        const blocked = await g.guard.disarm();
        await g.dispose();
        expect({ blocked: blocked.map((b) => b.method), framesReceived: wsFrames - before }).toEqual({ blocked: ["WEBSOCKET"], framesReceived: 0 });
      },
      origin,
    );
  }, 120_000);

  it("refuses to guard a page a service worker is registered for", async () => {
    await withSession(
      "heal-guard-sw",
      async (session) => {
        await session.page.goto(`${origin}/sw`);
        const g = await installHealProbeGuard(session.page);
        // BROWSER CODE
        await session.page.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js");
          await navigator.serviceWorker.ready;
        });
        const why = await g.guard.unguardable!();
        await g.dispose();
        expect(why).toMatch(/service worker/);
      },
      origin,
    );
  }, 120_000);
});
