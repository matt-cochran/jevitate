import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { visibleBusyIndicator, visibleBusyIndicatorContainer } from "./hang.js";
import { useSkippingTime } from "./testkit.js";

// #304: page time skips idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #419 — react-toastify renders a toast's auto-close countdown as a `role="progressbar"` with an
 * `aria-label` of "notification timer" and no `aria-valuenow`. That is a timer, not a busy
 * indicator: a focus-paused toast must not read as a stuck progressbar and produce a false
 * `ui-no-progress` hang. Timers/countdowns inside a notification container are excluded, and only
 * for the indeterminate-progressbar selector — `aria-busy` and spinners are untouched.
 */

let server: Server;
let origin: string;

const toastPage = `<!doctype html><html><body>
  <div class="Toastify__toast" role="alert">
    <div class="Toastify__progress-bar" role="progressbar" aria-label="notification timer" style="width:120px;height:4px"></div>
  </div>
</body></html>`;

const plainPage = `<!doctype html><html><body>
  <main><div role="progressbar" aria-label="Loading" style="width:24px;height:24px"></div></main>
</body></html>`;

const countdownPage = `<!doctype html><html><body>
  <div role="progressbar" aria-label="countdown" style="width:120px;height:4px"></div>
</body></html>`;

const busyStatusPage = `<!doctype html><html><body>
  <div role="status"><div aria-busy="true" style="width:24px;height:24px">Working…</div></div>
</body></html>`;

const loadingStatusPage = `<!doctype html><html><body>
  <div role="status" aria-live="polite"><div role="progressbar" aria-label="Loading results" style="width:24px;height:24px"></div></div>
</body></html>`;

const routes: Record<string, string> = {
  "/loading-status": loadingStatusPage,
  "/toast": toastPage,
  "/plain": plainPage,
  "/countdown": countdownPage,
  "/busy-status": busyStatusPage,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const body = routes[path];
    if (body !== undefined) {
      res.writeHead(200, { "content-type": "text/html" }).end(body);
      return;
    }
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

const port = new PlaywrightBrowserPort();

async function indicatorOn(path: string, probe: () => string | null = visibleBusyIndicator): Promise<string | null> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  try {
    await session.page.goto(`${origin}${path}`);
    return await session.page.evaluate(probe);
  } finally {
    await session.close();
  }
}

describe("#419 — a toast countdown progressbar is not a busy indicator", () => {
  it("a toast's indeterminate progressbar (aria-label 'notification timer') is not a busy indicator", async () => {
    expect(await indicatorOn("/toast")).toBeNull();
  }, 30_000);

  it("a bare indeterminate progressbar in <main> is still a busy indicator", async () => {
    expect(await indicatorOn("/plain")).not.toBeNull();
  }, 30_000);

  it("an indeterminate progressbar labelled 'countdown' outside any container is excluded", async () => {
    expect(await indicatorOn("/countdown")).toBeNull();
  }, 30_000);

  it("a 'Loading' progressbar inside a role=status live region is still a busy indicator", async () => {
    expect(await indicatorOn("/loading-status")).not.toBeNull();
  }, 30_000);

  it("aria-busy='true' inside a status region is still a busy indicator (exclusion is progressbar-only)", async () => {
    expect(await indicatorOn("/busy-status")).not.toBeNull();
  }, 30_000);
});

describe("#419 — a stuck busy indicator's container is named as evidence", () => {
  it("names the main landmark around a bare progressbar", async () => {
    expect(await indicatorOn("/plain", visibleBusyIndicatorContainer)).toBe("role=main");
  }, 30_000);

  it("names nothing when the only progressbar is an excluded toast timer", async () => {
    expect(await indicatorOn("/toast", visibleBusyIndicatorContainer)).toBeNull();
  }, 30_000);
});
