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
}, 120_000);
