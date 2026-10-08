import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  return (await browserProcsWith(marker)).map((p) => p.argv);
}

async function browserPidsWith(marker: string): Promise<number[]> {
  if (process.platform === "linux") return (await browserProcsWith(marker)).map((p) => p.pid);
  return (await processTable()).filter((p) => p.argv.includes(marker) && !p.argv.includes("--type=")).map((p) => p.pid);
}

/**
 * Every process's pid + command line where there is no /proc: `ps` on macOS, CIM on Windows.
 * Lets the crash test SIGKILL/TerminateProcess the real browser on every OS instead of asking it
 * to close over CDP — a polite close can stall on a starved runner, a kill cannot.
 */
async function processTable(): Promise<{ pid: number; argv: string }[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return parseTable(stdout, "\t");
  }
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 });
  return parseTable(stdout.replace(/^\s*(\d+)\s+/gm, "$1\t"), "\t");
}

function parseTable(stdout: string, sep: string): { pid: number; argv: string }[] {
  const rows: { pid: number; argv: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    const pid = Number(line.slice(0, at).trim());
    if (Number.isInteger(pid) && pid > 0) rows.push({ pid, argv: line.slice(at + sep.length) });
  }
  return rows;
}

async function browserProcsWith(marker: string): Promise<{ pid: number; argv: string }[]> {
  const found: { pid: number; argv: string }[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string;
    try {
      argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ");
    } catch {
      continue; // process exited mid-scan
    }
    if (argv.includes(marker) && !argv.includes("--type=")) found.push({ pid: Number(pid), argv });
  }
  return found;
}

const execFileAsync = promisify(execFile);

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
    const marker = `--jevitate-test-marker=${randomUUID()}`;
    const session = await port.open({ ...base, args: [marker] });
    const browserBefore = session.page.context().browser();
    if (browserBefore === null) throw new Error("pooled session has no Browser");
    // A real crash on every OS: kill the browser process (found by its unique argv marker). A CDP
    // `Browser.close` was used off Linux before, but that polite shutdown stalled past 20 s on a
    // CPU-starved Windows runner — a kill can't.
    const pids = await browserPidsWith(marker);
    expect(pids).toHaveLength(1);
    process.kill(pids[0]!, "SIGKILL");
    await expect.poll(() => browserBefore.isConnected(), { timeout: 20_000 }).toBe(false);
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

  test("--viewport / --device (#149) set the context's actual viewport, scale, mobile and UA", async () => {
    const port = new PlaywrightBrowserPort({ pool: realPool() });
    const sized = await port.open({ ...base, viewport: { width: 375, height: 812 } });
    try {
      expect(sized.page.viewportSize()).toEqual({ width: 375, height: 812 });
    } finally {
      await sized.close();
    }
    const device = await port.open({ ...base, device: "iPhone 13" });
    try {
      expect(device.page.viewportSize()).toEqual({ width: 390, height: 664 });
      const ua = await device.page.evaluate(() => navigator.userAgent);
      expect(ua).toContain("iPhone");
      const isMobile = await device.page.evaluate(() => (navigator as unknown as { maxTouchPoints: number }).maxTouchPoints > 0);
      expect(isMobile).toBe(true);
    } finally {
      await device.close();
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
