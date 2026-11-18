import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "./playwright-browser-port.js";

/**
 * #872 — in real Chromium, `localDevCertOrigins` accepts exactly the pinned dev server's
 * self-signed certificate: another server with a different self-signed certificate still fails.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../test-fixtures/local-dev-cert/${name}`, import.meta.url)), "utf8");

async function serve(key: string, cert: string, body: string): Promise<{ server: Server; origin: string }> {
  const server = createServer({ key: fixture(key), cert: fixture(cert) }, (_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<h1>${body}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const base = { headless: true, allowedOrigins: [], baseUrl: "about:blank" };

describe("#872 accepting a local dev certificate in real Chromium", () => {
  let dev: { server: Server; origin: string };
  let other: { server: Server; origin: string };

  beforeAll(async () => {
    dev = await serve("key.pem", "cert.pem", "dev");
    other = await serve("other-key.pem", "other-cert.pem", "other");
  });

  afterAll(async () => {
    for (const s of [dev, other]) await new Promise<void>((resolve) => s.server.close(() => resolve()));
  });

  it("loads the pinned dev server", async () => {
    const session = await new PlaywrightBrowserPort().open({ ...base, localDevCertOrigins: [dev.origin] });
    try {
      await session.page.goto(dev.origin);
      expect(await session.page.textContent("h1")).toBe("dev");
    } finally {
      await session.close();
    }
  });

  it("still refuses another self-signed server in the same session", async () => {
    const session = await new PlaywrightBrowserPort().open({ ...base, localDevCertOrigins: [dev.origin] });
    try {
      await expect(session.page.goto(other.origin)).rejects.toThrow(/ERR_CERT_AUTHORITY_INVALID/);
    } finally {
      await session.close();
    }
  });

  it("without the option the dev server is refused, as before", async () => {
    const session = await new PlaywrightBrowserPort().open(base);
    try {
      await expect(session.page.goto(dev.origin)).rejects.toThrow(/ERR_CERT_AUTHORITY_INVALID/);
    } finally {
      await session.close();
    }
  });
});
