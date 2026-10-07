import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { isAdvisoryConsoleError, PageSignalCollector } from "./defect-oracle.js";

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

// #405: the page's own AbortController cancelling a request that never received a response. A
// superseded type-ahead/search READ is benign; an aborted WRITE still gates (it may have reached the
// server). The server holds both routes open and never responds.
const PAGE_INITIATED_ABORT = `<!doctype html><html><body>
  <button id="read" type="button">Read</button>
  <button id="write" type="button">Write</button>
  <script>
    window.__ctrl = null;
    window.__settled = false;
    function start(url, opts) {
      const c = new AbortController();
      window.__ctrl = c;
      window.__settled = false;
      fetch(url, Object.assign({ signal: c.signal }, opts))
        .catch(() => undefined)
        .finally(() => { window.__settled = true; });
    }
    document.getElementById("read").addEventListener("click", () => start("/api/search?q=a"));
    document.getElementById("write").addEventListener("click", () => start("/api/items", { method: "POST", body: "x" }));
  </script>
</body></html>`;

let abortServer: Server;
let abortOrigin: string;

beforeAll(async () => {
  abortServer = createServer((req, res) => {
    switch ((req.url ?? "").split("?")[0]) {
      case "/data.json":
        res.writeHead(200, { "content-type": "application/json" });
        res.write(JSON.stringify({ ok: true }));
        res.on("close", () => undefined); // never end() — held open until the client aborts it
        return;
      case "/api/search":
      case "/api/items":
        // #405: hold the request open and never respond, so the client's abort races a still-pending
        // request for which NO response was received.
        return;
      case "/aborts":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE_INITIATED_ABORT);
        return;
      default:
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ABORT_AFTER_RESPONSE_PAGE);
    }
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

  test("#208: with the run's allowlist, a THIRD-PARTY 5xx is not a signal — a first-party one still is", async () => {
    const tp = createServer((_req, res) => {
      res.writeHead(503, { "access-control-allow-origin": "*" }).end("down");
    });
    await new Promise<void>((resolve) => tp.listen(0, "127.0.0.1", resolve));
    const tpPort = (tp.address() as AddressInfo).port;
    try {
      const scoped = new PageSignalCollector(page, Date.now, [abortOrigin]);
      const unscoped = new PageSignalCollector(page);
      await page.goto(`${abortOrigin}/`);
      // Another host (localhost vs 127.0.0.1) is another site: a third party (#194).
      await page.evaluate((u) => fetch(u, { method: "POST", mode: "no-cors", body: "x" }).catch(() => undefined), `http://localhost:${tpPort}/beacon`);
      // The app's own host on another port is first-party.
      await page.evaluate((u) => fetch(u, { mode: "no-cors" }).catch(() => undefined), `http://127.0.0.1:${tpPort}/api`);
      await page.waitForTimeout(100);
      const scopedSignals = scoped.drain().filter((s) => s.kind === "http-5xx");
      expect(scopedSignals.map((s) => s.url)).toEqual([`http://127.0.0.1:${tpPort}/api`]);
      // Without an allowlist every origin counts (the pre-#208 behaviour).
      expect(unscoped.drain().filter((s) => s.kind === "http-5xx")).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => tp.close(() => resolve()));
    }
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

  test("#405: an aborted type-ahead READ with no response is not a failed-request signal", async () => {
    const p = await browser.newPage();
    try {
      const collector = new PageSignalCollector(p);
      await p.goto(`${abortOrigin}/aborts`);
      const issued = p.waitForRequest(/\/api\/search/);
      await p.click("#read");
      await issued;
      await p.evaluate(() => (window as unknown as { __ctrl: AbortController | null }).__ctrl!.abort());
      await p.waitForFunction(() => (window as unknown as { __settled?: boolean }).__settled === true);
      await p.waitForTimeout(200);
      expect(collector.drain().some((s) => s.kind === "failed-request")).toBe(false);
    } finally {
      await p.close();
    }
  });

  test("#405: an aborted WRITE with no response still produces a failed-request signal", async () => {
    const p = await browser.newPage();
    try {
      const collector = new PageSignalCollector(p);
      await p.goto(`${abortOrigin}/aborts`);
      const issued = p.waitForRequest(/\/api\/items/);
      await p.click("#write");
      await issued;
      await p.evaluate(() => (window as unknown as { __ctrl: AbortController | null }).__ctrl!.abort());
      await p.waitForFunction(() => (window as unknown as { __settled?: boolean }).__settled === true);
      await p.waitForTimeout(200);
      expect(collector.drain().some((s) => s.kind === "failed-request")).toBe(true);
    } finally {
      await p.close();
    }
  });
}, 120_000);

// #88: correlating a console-error line with the captured network response it followed — 5xx is
// still a defect, 4xx is advisory (reported, never a defect), and no captured response at all
// (never a request) leaves the console error a defect, as before.
const CORRELATION_PAGE = `<!doctype html><html><body>
  <button id="e403" type="button">403</button>
  <button id="e500" type="button">500</button>
  <button id="none" type="button">None</button>
  <script>
    document.getElementById("e403").addEventListener("click", async () => {
      const r = await fetch("/api/billing");
      console.error("ManageBillingToolApi.request failed: {message: Response returned an error code", r.status);
    });
    document.getElementById("e500").addEventListener("click", async () => {
      const r = await fetch("/api/boom");
      console.error("ManageProfileToolApi.request failed: {message: server error", r.status);
    });
    document.getElementById("none").addEventListener("click", () => {
      console.error("synthetic-standalone-error, no request behind it");
    });
  </script>
</body></html>`;

let corrServer: Server;
let corrOrigin: string;

describe("#88 — a console error correlated with a captured network response", () => {
  beforeAll(async () => {
    corrServer = createServer((req, res) => {
      switch ((req.url ?? "").split("?")[0]) {
        case "/api/billing":
          res.writeHead(403, { "content-type": "application/json" }).end("{}");
          return;
        case "/api/boom":
          res.writeHead(500, { "content-type": "application/json" }).end("{}");
          return;
        default:
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CORRELATION_PAGE);
      }
    });
    await new Promise<void>((resolve) => corrServer.listen(0, "127.0.0.1", resolve));
    const addr = corrServer.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    corrOrigin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => corrServer.close(() => resolve()));
  });

  test("a console error after a 403 is advisory, not a defect", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(corrOrigin);
    await page.click("#e403");
    await page.waitForTimeout(200);
    const signals = collector.drain();
    const err = signals.find((s) => s.kind === "console-error" && s.detail.includes("ManageBillingToolApi"));
    expect(err).toBeDefined();
    expect(err !== undefined && isAdvisoryConsoleError(err)).toBe(true);
    expect(err?.kind === "console-error" ? err.correlatedStatus : undefined).toBe(403);
  });

  test("a console error after a 500 is a defect (never advisory) — and the 500 itself gates too", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(corrOrigin);
    await page.click("#e500");
    await page.waitForTimeout(200);
    const signals = collector.drain();
    const err = signals.find((s) => s.kind === "console-error" && s.detail.includes("ManageProfileToolApi"));
    expect(err).toBeDefined();
    expect(err !== undefined && isAdvisoryConsoleError(err)).toBe(false);
    expect(signals.some((s) => s.kind === "http-5xx" && s.status === 500)).toBe(true);
  });

  test("a console error with no request behind it stays a defect (uncorrelated)", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(corrOrigin);
    // Past the correlation window since the page's own (unrelated) navigation response: this error
    // genuinely has no request near it, not just none caused by the click.
    await page.waitForTimeout(2_200);
    await page.click("#none");
    await page.waitForTimeout(200);
    const signals = collector.drain();
    const err = signals.find((s) => s.kind === "console-error" && s.detail.includes("synthetic-standalone-error"));
    expect(err).toBeDefined();
    expect(err !== undefined && isAdvisoryConsoleError(err)).toBe(false);
    expect(err?.kind === "console-error" ? err.correlatedStatus : undefined).toBeUndefined();
  });
}, 120_000);
