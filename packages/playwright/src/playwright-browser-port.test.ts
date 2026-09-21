import { afterAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightBrowserPort } from "./playwright-browser-port.js";

const port = new PlaywrightBrowserPort();

test("opens a persistent context and navigates to a data: URL", async () => {
  const profileDir = await mkdtemp(join(tmpdir(), "doit-pw-"));
  const session = await port.open({ profileDir, headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    await session.page.setContent("<h1>hello</h1>");
    expect(await session.page.locator("h1").textContent()).toBe("hello");
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}, 60_000);
