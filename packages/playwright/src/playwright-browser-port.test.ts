import { afterAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserCrashedError } from "./browser-pool.js";
import { PlaywrightBrowserPort, createBrowserPool, type PlaywrightBrowserPool } from "./playwright-browser-port.js";
import { createResourceSignals } from "./select-resource-signals.js";

/**
 * Real-Chromium smoke for the pooled port — the CI OS-matrix job runs this
 * file on Linux, Windows and macOS. Each test owns a pool on this platform's
 * REAL resource signals, so admission runs for real too.
 */

const pools: PlaywrightBrowserPool[] = [];
function realPool(): PlaywrightBrowserPool {
  const pool = createBrowserPool({ signals: createResourceSignals(), maxContexts: 2 });
  pools.push(pool);
  return pool;
}
afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

const base = { headless: true, allowedOrigins: [], baseUrl: "about:blank" };

/** Browser-process (not renderer) argvs carrying `marker`; Linux /proc only. */
async function browserArgvsWith(marker: string): Promise<string[]> {
  const found: string[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string;
    try {
      argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ");
    } catch {
      continue; // process exited mid-scan
    }
    if (argv.includes(marker) && !argv.includes("--type=")) found.push(argv);
  }
  return found;
}

describe("pooled PlaywrightBrowserPort (real Chromium)", () => {
  test("two sessions = two isolated contexts on ONE browser; admission sample is recorded", async () => {
    const port = new PlaywrightBrowserPort({ pool: realPool() });
    const marker = `--jevitate-test-marker=${randomUUID()}`;
    const a = await port.open({ ...base, args: [marker] });
    const b = await port.open({ ...base, args: [marker] });
    try {
      // The CI smoke's evidence line: which signal source admitted the contexts on this OS.
      console.log(`[pool-smoke] ${process.platform} admission: ${JSON.stringify(a.admission)}`);
      expect(a.admission?.sample.source).toMatch(/^(linux|wsl2|darwin|win32):/);
      expect(a.page.context()).not.toBe(b.page.context());
      expect(a.page.context().browser()).toBe(b.page.context().browser());
      await a.page.setContent("<h1>hello</h1>");
      expect(await a.page.locator("h1").textContent()).toBe("hello");
      await a.page.context().addCookies([{ name: "sid", value: "a", url: "http://127.0.0.1:1/" }]);
      expect(await b.page.context().cookies()).toEqual([]);
      if (process.platform === "linux") {
        const argvs = await browserArgvsWith(marker);
        expect(argvs).toHaveLength(1);
        expect(argvs[0]).toContain("--no-sandbox");
        expect(argvs[0]).toContain("--disable-dev-shm-usage");
      }
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  test("storageState round-trip carries auth cookies into a fresh context", async () => {
    const port = new PlaywrightBrowserPort({ pool: realPool() });
    const dir = await mkdtemp(join(tmpdir(), "jevitate-state-"));
    const file = join(dir, "state.json");
    try {
      const first = await port.open(base);
      try {
        await first.page.context().addCookies([{ name: "auth", value: "token-1", url: "http://127.0.0.1:1/" }]);
        await first.saveStorageState(file);
      } finally {
        await first.close();
      }
      const second = await port.open({ ...base, storageState: file });
      try {
        const cookies = await second.page.context().cookies("http://127.0.0.1:1/");
        expect(cookies.map((c) => [c.name, c.value])).toEqual([["auth", "token-1"]]);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("browser crash fails the live session loudly and the next session relaunches", async () => {
    const port = new PlaywrightBrowserPort({ pool: realPool() });
    const session = await port.open(base);
    const browserBefore = session.page.context().browser();
    const cdp = await session.page.context().newCDPSession(session.page);
    // Browser.crash kills the browser process itself — a real crash on every OS.
    // The command can never be answered (the process is gone): it is not awaited,
    // and its eventual rejection is observed, not left unhandled.
    const crashCommand = cdp.send("Browser.crash");
    crashCommand.catch(() => undefined);
    await expect.poll(() => browserBefore?.isConnected(), { timeout: 20_000 }).toBe(false);
    await expect(session.close()).rejects.toBeInstanceOf(BrowserCrashedError);
    const next = await port.open(base);
    try {
      expect(next.page.context().browser()).not.toBe(browserBefore);
      await next.page.setContent("<p>alive</p>");
      expect(await next.page.locator("p").textContent()).toBe("alive");
    } finally {
      await next.close();
    }
  }, 60_000);
});

describe("persistentProfile opt-in (real Chromium)", () => {
  test("opens a persistent context on the given profile dir, outside the pool", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "jevitate-pw-"));
    const port = new PlaywrightBrowserPort({ pool: realPool() });
    const session = await port.open({ ...base, persistentProfile: profileDir });
    try {
      expect(session.admission).toBeUndefined();
      await session.page.setContent("<h1>persisted</h1>");
      expect(await session.page.locator("h1").textContent()).toBe("persisted");
    } finally {
      await session.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 60_000);
});
