import { describe, expect, test } from "vitest";
import type { chromium } from "playwright";
import {
  BrowserNotInstalledError,
  browserPoolOptionsFromEnv,
  createBrowserPool,
  type PlaywrightBrowserPool,
  DEFAULT_LINUX_CHROMIUM_ARGS,
  PlaywrightBrowserPort,
  explainLaunchFailure,
  resolveLaunchArgs,
} from "./playwright-browser-port.js";

type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;
type PersistentOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** A launcher that captures what the port asked for, then aborts before any browser starts. */
function capturingLauncher(): { launch: typeof chromium.launch; calls: LaunchOptions[] } {
  const calls: LaunchOptions[] = [];
  const launch: typeof chromium.launch = async (options) => {
    calls.push(options ?? {});
    throw new Error("launch intercepted by test");
  };
  return { launch, calls };
}

/** A pool whose admission always sees an idle host, so tests never depend on this machine's load. */
const calmPool = (): PlaywrightBrowserPool =>
  createBrowserPool({
    maxContexts: 2,
    signals: { sample: async () => ({ memAvailableBytes: 8 * 1024 ** 3, source: "fixture:calm" }) },
  });

const base = { headless: true, allowedOrigins: [], baseUrl: "http://127.0.0.1:1" };

describe("resolveLaunchArgs", () => {
  test("the Linux default is exactly --no-sandbox + --disable-dev-shm-usage", () => {
    expect(DEFAULT_LINUX_CHROMIUM_ARGS).toEqual(["--no-sandbox", "--disable-dev-shm-usage"]);
    expect(Object.isFrozen(DEFAULT_LINUX_CHROMIUM_ARGS)).toBe(true);
  });

  test("Linux with no caller args → the defaults", () => {
    expect(resolveLaunchArgs(undefined, "linux")).toEqual(["--no-sandbox", "--disable-dev-shm-usage"]);
  });

  test("Linux caller args EXTEND the defaults (defaults first, order kept, duplicates dropped)", () => {
    expect(resolveLaunchArgs(["--lang=de", "--no-sandbox", "--disable-gpu"], "linux")).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--lang=de",
      "--disable-gpu",
    ]);
  });

  test("non-Linux has no defaults — caller args used as given", () => {
    expect(resolveLaunchArgs(undefined, "darwin")).toEqual([]);
    expect(resolveLaunchArgs(["--lang=de"], "win32")).toEqual(["--lang=de"]);
  });
});

describe("PlaywrightBrowserPort.open launch options (pooled)", () => {
  test("passes executablePath, channel and extended args through to the pooled launch", async () => {
    const { launch, calls } = capturingLauncher();
    const port = new PlaywrightBrowserPort({ launch, platform: "linux", pool: calmPool() });
    await expect(
      port.open({ ...base, executablePath: "/opt/chromium/chrome", channel: "chromium", args: ["--lang=de"] }),
    ).rejects.toThrow("launch intercepted by test");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      headless: true,
      executablePath: "/opt/chromium/chrome",
      channel: "chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=de"],
    });
  });

  test("omitted executablePath/channel are not sent at all (Playwright's pinned Chromium is used)", async () => {
    const { launch, calls } = capturingLauncher();
    const port = new PlaywrightBrowserPort({ launch, platform: "linux", pool: calmPool() });
    await expect(port.open(base)).rejects.toThrow();
    expect("executablePath" in calls[0]!).toBe(false);
    expect("channel" in calls[0]!).toBe(false);
    expect(calls[0]!.args).toEqual([...DEFAULT_LINUX_CHROMIUM_ARGS]);
  });

  test("Windows and macOS launches get NO Linux default switches", async () => {
    for (const platform of ["win32", "darwin"] as const) {
      const { launch, calls } = capturingLauncher();
      const port = new PlaywrightBrowserPort({ launch, platform, pool: calmPool() });
      await expect(port.open(base)).rejects.toThrow();
      expect(calls[0]!.args).toEqual([]);
    }
  });

  test("a failed launch frees the admission slot (no leak at the cap)", async () => {
    const pool = calmPool();
    const { launch } = capturingLauncher();
    const port = new PlaywrightBrowserPort({ launch, platform: "linux", pool });
    await expect(port.open(base)).rejects.toThrow();
    await expect(port.open(base)).rejects.toThrow();
    await expect(port.open(base)).rejects.toThrow();
    expect(pool.inUse).toBe(0);
  });

  test("a missing pinned Chromium surfaces an actionable `npx playwright install chromium` error", async () => {
    const launch: typeof chromium.launch = async () => {
      throw new Error(
        "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1/chrome\n" +
          "╔════╗ Looks like Playwright was just installed or updated.",
      );
    };
    const port = new PlaywrightBrowserPort({ launch, platform: "linux", pool: calmPool() });
    const err = await port.open(base).then(
      () => null,
      (e: unknown) => e,
    );
    if (!(err instanceof BrowserNotInstalledError)) throw new Error(`expected BrowserNotInstalledError, got ${String(err)}`);
    expect(err.message).toContain("npx playwright install chromium");
    expect(err.message).toContain("/home/u/.cache/ms-playwright/chromium-1/chrome");
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("PlaywrightBrowserPort.open persistentProfile (explicit opt-in)", () => {
  test("launches a persistent context on the given dir with the same launch options", async () => {
    const calls: { dir: string; options: PersistentOptions }[] = [];
    const launchPersistentContext: typeof chromium.launchPersistentContext = async (dir, options) => {
      calls.push({ dir, options: options ?? {} });
      throw new Error("persistent launch intercepted");
    };
    const port = new PlaywrightBrowserPort({ launchPersistentContext, platform: "linux", pool: calmPool() });
    await expect(port.open({ ...base, persistentProfile: "/tmp/profile", args: ["--lang=de"] })).rejects.toThrow(
      "persistent launch intercepted",
    );
    expect(calls[0]!.dir).toBe("/tmp/profile");
    expect(calls[0]!.options).toMatchObject({
      headless: true,
      baseURL: "http://127.0.0.1:1",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=de"],
    });
  });

  test("storageState + persistentProfile is rejected (ambiguous state source)", async () => {
    const port = new PlaywrightBrowserPort({ launch: capturingLauncher().launch, platform: "linux", pool: calmPool() });
    await expect(port.open({ ...base, persistentProfile: "/tmp/p", storageState: "/tmp/s.json" })).rejects.toThrow(
      /storageState cannot be combined with persistentProfile/,
    );
  });
});

describe("explainLaunchFailure", () => {
  const missing = new Error("Executable doesn't exist at /x/chrome");

  test("an unrelated failure is returned unchanged (rethrown as-is, never masked)", () => {
    const other = new Error("Target page, context or browser has been closed");
    expect(explainLaunchFailure(other, {})).toBe(other);
  });

  test("a missing --browser-executable names the flag, not an install command", () => {
    const e = explainLaunchFailure(missing, { executablePath: "/x/chrome" });
    if (!(e instanceof BrowserNotInstalledError)) throw new Error("expected BrowserNotInstalledError");
    expect(e.message).toContain("--browser-executable");
  });

  test("a missing channel names the channel's install command", () => {
    const e = explainLaunchFailure(missing, { channel: "chrome" });
    if (!(e instanceof BrowserNotInstalledError)) throw new Error("expected BrowserNotInstalledError");
    expect(e.message).toContain("npx playwright install chrome");
  });
});

describe("browserPoolOptionsFromEnv", () => {
  test("unset → no overrides (cap derived from the host, 5 min admission timeout)", () => {
    expect(browserPoolOptionsFromEnv({})).toEqual({});
  });

  test("valid values are applied", () => {
    expect(browserPoolOptionsFromEnv({ JEVITATE_BROWSER_MAX_CONTEXTS: "3", JEVITATE_ADMISSION_TIMEOUT_MS: "60000" })).toEqual({
      maxContexts: 3,
      admissionTimeoutMs: 60000,
    });
  });

  test("a set-but-invalid value fails fast instead of silently meaning 'default'", () => {
    expect(() => browserPoolOptionsFromEnv({ JEVITATE_BROWSER_MAX_CONTEXTS: "two" })).toThrow(/JEVITATE_BROWSER_MAX_CONTEXTS/);
    expect(() => browserPoolOptionsFromEnv({ JEVITATE_ADMISSION_TIMEOUT_MS: "0" })).toThrow(RangeError);
  });
});
