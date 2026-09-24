import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { PageSignalCollector } from "./defect-oracle.js";

let site: { url: string; close(): Promise<void> };
let browser: Browser;
let page: Page;

beforeAll(async () => {
  site = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
  await site.close();
});

// #73: a fetch that reads its response as a STREAM and then aborts itself (connect-web/gRPC-web's
// own pattern — it does not wait for the connection to close on its own) reports `response` (200)
// followed by `requestfailed: net::ERR_ABORTED` for the SAME request — a benign client-side cancel,
// not a network failure. The server holds the connection open past the first chunk so the abort
// genuinely races a still-open request.
const ABORT_AFTER_RESPONSE_PAGE = `<!doctype html><html><body>
  <button id="go" type="button">Go</button>
  <script>
    document.getElementById("go").addEventListener("click", async () => {
      const controller = new AbortController();
      const res = await fetch("/data.json", { signal: controller.signal });
      const reader = res.body.getReader();
      await reader.read(); // the response (200) has already arrived
      controller.abort(); // abort while the server is still holding the connection open
      window.__done = true;
    });
  </script>
</body></html>`;

let abortServer: Server;
let abortOrigin: string;

beforeAll(async () => {
  abortServer = createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/data.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(JSON.stringify({ ok: true }));
      res.on("close", () => undefined); // never end() — held open until the client aborts it
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ABORT_AFTER_RESPONSE_PAGE);
  });
  await new Promise<void>((resolve) => abortServer.listen(0, "127.0.0.1", resolve));
  const addr = abortServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  abortOrigin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => abortServer.close(() => resolve()));
});

describe("PageSignalCollector", () => {
  test("captures a real console.error", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(`${site.url}/login`);
    await page.evaluate(() => console.error("synthetic-boom"));
    await page.waitForTimeout(50);
    const signals = collector.drain();
    expect(signals.some((s) => s.kind === "console-error" && s.detail.includes("synthetic-boom"))).toBe(true);
  });

  test("captures a real HTTP 5xx response", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(`${site.url}/adversarial/boom`).catch(() => undefined); // navigation itself 500s; ignore nav error
    const signals = collector.drain();
    expect(signals.some((s) => s.kind === "http-5xx" && s.status === 500)).toBe(true);
  });

  test("drain() clears the buffer — signals are never double-counted", async () => {
    const collector = new PageSignalCollector(page);
    await page.evaluate(() => console.error("only-once"));
    await page.waitForTimeout(50);
    collector.drain();
    const second = collector.drain();
    expect(second).toEqual([]);
  });

  test("#73: net::ERR_ABORTED after a received response is not a failed-request signal", async () => {
    const p = await browser.newPage();
    try {
      // Proves the repro genuinely exercises the ERR_ABORTED-after-response race (so the assertion
      // below is not vacuously true because nothing failed at all).
      const rawAborts: string[] = [];
      p.on("requestfailed", (r) => rawAborts.push(r.failure()?.errorText ?? ""));
      const collector = new PageSignalCollector(p);
      await p.goto(abortOrigin);
      await p.click("#go");
      await p.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true);
      await p.waitForTimeout(200);
      expect(rawAborts).toContain("net::ERR_ABORTED");
      const signals = collector.drain();
      expect(signals.some((s) => s.kind === "failed-request")).toBe(false);
    } finally {
      await p.close();
    }
  });

  test("#73: a genuine network failure (no response) still gates", async () => {
    const p = await browser.newPage();
    try {
      const collector = new PageSignalCollector(p);
      await p.goto(abortOrigin);
      // No server listening on this port: a real connection failure, never a response.
      await p.evaluate(() => fetch("http://127.0.0.1:1/nope").catch(() => undefined));
      await p.waitForTimeout(200);
      const signals = collector.drain();
      expect(signals.some((s) => s.kind === "failed-request" && !s.detail.includes("ERR_ABORTED"))).toBe(true);
    } finally {
      await p.close();
    }
  });
}, 120_000);
