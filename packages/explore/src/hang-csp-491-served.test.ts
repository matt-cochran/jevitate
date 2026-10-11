import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { perceive } from "./perceive.js";
import { useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #491 — the busy-indicator wait ran a STRING predicate in the page, which a CSP without
 * `'unsafe-eval'` rejects; the rejection read as "never went away" and produced a false
 * `ui-no-progress` hang at once. A spinner that clears on such a page is no hang.
 */

let server: Server;
let origin: string;

const page = `<!doctype html><html><body>
  <main><button>Save</button><div class="animate-spin" style="width:24px;height:24px"></div></main>
  <script src="/clear.js"></script>
</body></html>`;

const clearScript = `setTimeout(() => document.querySelector(".animate-spin").remove(), 1000);`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const csp = { "content-security-policy": "script-src 'self'" };
    if (path === "/clear.js") return void res.writeHead(200, { "content-type": "text/javascript", ...csp }).end(clearScript);
    if (path === "/stuck") return void res.writeHead(200, { "content-type": "text/html", ...csp }).end(page.replace('<script src="/clear.js"></script>', ""));
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html", ...csp }).end(page);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function hangOn(path: string): Promise<string | null> {
  const port = new PlaywrightBrowserPort();
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  try {
    await session.page.goto(`${origin}${path}`);
    return (await perceive(session.page, { renderWaitMs: 5_000, hangProbeMs: 500 })).hang?.kind ?? null;
  } finally {
    await session.close();
  }
}

describe("#491 — the busy-indicator wait works under a CSP without 'unsafe-eval'", () => {
  it("a spinner that clears after 1s on a CSP page is not a hang", async () => {
    expect(await hangOn("/")).toBeNull();
  }, 60_000);

  it("a spinner that never clears on a CSP page is still a ui-no-progress hang", async () => {
    expect(await hangOn("/stuck")).toBe("ui-no-progress");
  }, 60_000);
});
