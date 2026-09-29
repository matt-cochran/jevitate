import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monitorFor } from "./page-monitor.js";
import { evaluateNetworkCheck } from "./success-checks.js";
import { withSession } from "./testkit.js";

/**
 * #73: connect-web/gRPC-web (and plain `fetch`) clients abort their own request once the body is
 * read — Chromium reports `response` (200), then `requestfailed: net::ERR_ABORTED` for the SAME
 * request. The monitor must keep the status it already received, not discard it because the
 * request's own end event was an abort.
 */

// gRPC-web/connect-web reads its response as a STREAM (frames, then trailers) and cancels the
// underlying fetch once it has what it needs — it does not wait for the connection to close on its
// own. The server here holds the connection open past the first chunk so the abort genuinely races
// a still-open request, exactly like Chromium reports it in the field (#73).
const PAGE = `<!doctype html><html><body>
  <button id="go" type="button">Go</button>
  <script>
    document.getElementById("go").addEventListener("click", async () => {
      const controller = new AbortController();
      const res = await fetch("/data.json", { signal: controller.signal });
      const reader = res.body.getReader();
      await reader.read(); // the response (200) has already arrived — one chunk read
      controller.abort(); // abort while the server is still holding the connection open
      window.__done = true;
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/data.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(JSON.stringify({ ok: true }));
      // Hold the connection open (never call end()) until the client aborts it or the socket closes.
      res.on("close", () => undefined);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PageMonitor — response then requestfailed (#73)", () => {
  it("keeps the received status when requestfailed (net::ERR_ABORTED) follows response", async () => {
    await withSession(
      "page-monitor-abort-",
      async (session) => {
        const monitor = monitorFor(session.page);
        const capture = monitor.startCapture();
        await session.page.goto(origin);
        const since = Date.now();
        await session.page.click("#go");
        await session.page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true);
        // Give the requestfailed event a moment to arrive after the response.
        await session.page.waitForTimeout(200);

        const completed = monitor.completedSince(since).find((r) => r.url.includes("/data.json"));
        expect(completed).toBeDefined();
        expect(completed?.status).toBe(200);
        expect(completed?.failed).toBe(true);
        expect(completed?.abortedAfterResponse).toBe(true);

        const captured = capture.requests().find((r) => r.path === "/data.json");
        expect(captured).toBeDefined();
        expect(captured?.status).toBe(200);
        expect(captured?.abortedAfterResponse).toBe(true);
      },
      origin,
    );
  });

  it("responseStatus:GET /data.json=2xx passes despite the post-response abort", async () => {
    await withSession(
      "page-monitor-abort-check-",
      async (session) => {
        const monitor = monitorFor(session.page);
        const capture = monitor.startCapture();
        await session.page.goto(origin);
        await session.page.click("#go");
        await session.page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true);
        await session.page.waitForTimeout(200);

        const result = evaluateNetworkCheck(
          { kind: "responseStatus", method: "GET", pathGlob: "/data.json", status: { class: 2 } },
          capture.requests(),
        );
        expect(result.passed).toBe(true);
      },
      origin,
    );
  });
});
