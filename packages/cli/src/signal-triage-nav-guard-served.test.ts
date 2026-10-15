import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clock } from "@jevitate/domain";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { observeBrowserSignals, type RawBrowserSignal } from "./signal-triage.js";

useSkippingTime({ per: "all" });

/**
 * #521: the navigation guard answers an off-allowlist page navigation 204, and Chromium still emits
 * one `requestfailed` net::ERR_ABORTED for it. Log triage records no error-level line for it.
 */

let app: Server;
let other: Server;
let APP = "";
let OTHER = "";

beforeAll(async () => {
  other = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>Other</h1>"));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  OTHER = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  app = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<a id="leave" href="${OTHER}/elsewhere">Leave</a>`));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  APP = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all([app, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe("#521 — a guard-blocked navigation in log triage (real Chromium)", () => {
  it("records no error-level requestfailed signal for it", async () => {
    const session = await new PlaywrightBrowserPort({ liveness: false }).open({ headless: true, allowedOrigins: [APP], baseUrl: APP, blockOffAllowlistNavigation: true });
    const sink: RawBrowserSignal[] = [];
    try {
      observeBrowserSignals(session.page, sink, () => clock.now(), () => undefined);
      await session.page.goto(`${APP}/home`);
      const aborted = session.page.waitForEvent("requestfailed");
      await session.page.click("#leave");
      await aborted;
    } finally {
      await session.close();
    }
    expect(sink.filter((s) => s.level === "error")).toEqual([]);
  });
});
