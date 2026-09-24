#!/usr/bin/env node
// capture.mjs — capture per-screen UX evidence (controls via explore's snapshot + visible text)
// for a list of targets, into a corpus JSON the quality harness replays. Read-only against the
// target apps. Usage: node capture.mjs <targets.json> <out-corpus.json> [--shots <dir>]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { snapshot } from "@jevitate/explore";

const [targetsPath, outPath, ...rest] = process.argv.slice(2);
const shotsDir = rest[0] === "--shots" ? rest[1] : undefined;
if (!targetsPath || !outPath) throw new Error("usage: capture.mjs <targets.json> <out.json> [--shots dir]");
const targets = JSON.parse(await readFile(targetsPath, "utf8"));
if (shotsDir) await mkdir(shotsDir, { recursive: true });

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const scrub = (s) => s.replace(JWT, "[token]").replace(EMAIL, "[email]");

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const screens = [];
try {
  for (const t of targets) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(t.storageState ? { storageState: t.storageState } : {}),
    });
    const page = await context.newPage();
    try {
      await page.goto(t.url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      for (const step of t.steps ?? []) {
        if (step.fill) await page.getByLabel(step.fill.label).first().fill(step.fill.value);
        if (step.click) await page.getByText(step.click, { exact: false }).first().click({ timeout: 8000 });
        if (step.clickRole) await page.getByRole(step.clickRole.role, { name: step.clickRole.name }).first().click({ timeout: 8000 });
        if (step.press) await page.keyboard.press(step.press);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(step.waitMs ?? 800);
      }
      await page.waitForTimeout(t.settleMs ?? 1200);
      const snap = await snapshot(page, { maxCandidates: 80 });
      const visibleText = await page.evaluate(() => document.body?.innerText ?? "");
      const controls = snap.controls.map((c) => ({
        index: c.index, role: c.role, name: scrub(c.name), tag: c.tag, inputType: c.inputType, enabled: c.enabled, summary: scrub(c.summary),
      }));
      screens.push({
        app: t.app, id: t.id, split: t.split, url: page.url().replace(/etok_[0-9a-f]+/, "etok_TOKEN"), job: t.job, appClass: t.appClass,
        controls, visibleText: scrub(visibleText).slice(0, 12000),
      });
      if (shotsDir) await page.screenshot({ path: join(shotsDir, `${t.app}--${t.id}.png`), fullPage: true });
      process.stderr.write(`captured ${t.app}/${t.id}: ${controls.length} controls, ${visibleText.length} chars\n`);
    } catch (err) {
      process.stderr.write(`FAILED ${t.app}/${t.id}: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(outPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), screens }, null, 2)}\n`);
