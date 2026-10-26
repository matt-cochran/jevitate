import { clock } from "@jevitate/domain";
import type { Browser } from "playwright";
import { afterAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);

/** Browser-process (not renderer) argvs carrying `marker`; Linux /proc only. */
async function browserArgvsWith(marker: string): Promise<string[]> {
  return (await browserProcsWith(marker)).map((p) => p.argv);
}

/**
 * The pid of `browser`'s own process, asked over CDP (`SystemInfo.getProcessInfo`) on the pipe the
 * port already holds — one short RPC on every OS. #475: the Windows path used to enumerate every
 * process's command line through PowerShell + `Get-CimInstance Win32_Process`, an unbounded child
 * process that can take tens of seconds on a CPU-starved runner (the 60 s test timeout it hit).
 */
async function browserPid(browser: Browser): Promise<number> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
    const own = processInfo.filter((p) => p.type === "browser");
    if (own.length !== 1) throw new Error(`SystemInfo.getProcessInfo reported ${own.length} browser processes: ${JSON.stringify(processInfo)}`);
    return own[0]!.id;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Force a browser crash. Windows Chromium survives a single-PID kill through child processes, so kill its process tree. */
async function killBrowser(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  process.kill(pid, "SIGKILL");
}

/**
 * Named, bounded steps for a real-time test (#475). Each step races its own deadline; a step that
 * fails or stalls throws naming itself and the timing of every step so far, so a CI timeout says
 * WHICH step stalled instead of a bare "Test timed out". `timings()` is logged on success too.
 */
function boundedSteps(): { step<T>(label: string, boundMs: number, work: () => Promise<T>): Promise<T>; timings(): string } {
  const done: string[] = [];
  const timings = (): string => (done.length === 0 ? "(none)" : done.join(", "));
  return {
    timings,
    async step(label, boundMs, work) {
      const started = clock.now();
      let timer: ReturnType<typeof clock.setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = clock.setTimeout(() => reject(new Error(`did not finish within its ${boundMs}ms bound`)), boundMs);
      });
      try {
        const value = await Promise.race([work(), deadline]);
        done.push(`${label}=${clock.now() - started}ms`);
        return value;
      } catch (err) {
        const elapsed = clock.now() - started;
        const before = timings();
        done.push(`${label}=FAILED@${elapsed}ms`);
        throw new Error(`step "${label}" failed after ${elapsed}ms (bound ${boundMs}ms); earlier steps: ${before}. Cause: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      } finally {
        if (timer !== undefined) clock.clearTimeout(timer);
      }
    },
  };
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

/**
 * A real crash and a real relaunch only exist in real time (AGENTS.md #304: launch/teardown stay
 * on the real clock). Every step has its own bound, and the bounds sum to less than the test
 * timeout, so a stall on a starved runner fails naming its step with all step timings (#475).
 */
describe("[realtime] pooled PlaywrightBrowserPort crash + relaunch (real Chromium)", () => {
  test("browser crash fails the live session loudly and the next session relaunches", async () => {
    const { step, timings } = boundedSteps();
    const port = new PlaywrightBrowserPort({ pool: realPool() });
    const marker = `--jevitate-test-marker=${randomUUID()}`;
    const session = await step("open session", 30_000, () => port.open({ ...base, args: [marker] }));
    const browserBefore = session.page.context().browser();
    if (browserBefore === null) throw new Error("pooled session has no Browser");
    // A real crash on every OS: kill the browser process/tree. A CDP `Browser.close` was used off Linux
    // before, but that polite shutdown stalled past 20 s on a CPU-starved Windows runner.
    const pid = await step("find browser pid (CDP)", 15_000, () => browserPid(browserBefore));
    if (process.platform === "linux") {
      // Cross-check the CDP pid against /proc: the argv-marked browser process is that very pid.
      expect((await browserProcsWith(marker)).map((p) => p.pid)).toEqual([pid]);
    }
    await step("kill + observe disconnect", 20_000, async () => {
      await killBrowser(pid);
      await expect.poll(() => browserBefore.isConnected(), { timeout: 18_000 }).toBe(false);
    });
    await step("crashed session.close() rejects", 10_000, () => expect(session.close()).rejects.toBeInstanceOf(BrowserCrashedError));
    const next = await step("relaunch (port.open)", 30_000, () => port.open(base));
    try {
      await step("use relaunched page", 15_000, async () => {
        expect(next.page.context().browser()).not.toBe(browserBefore);
        await next.page.setContent("<p>alive</p>");
        expect(await next.page.locator("p").textContent()).toBe("alive");
      });
    } finally {
      await step("next.close()", 15_000, () => next.close());
    }
    console.log(`[crash-smoke] ${process.platform} steps: ${timings()}`);
  }, 150_000);
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
