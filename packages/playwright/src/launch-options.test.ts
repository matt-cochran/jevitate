import { describe, expect, test } from "vitest";
import type { chromium } from "playwright";
import {
  BrowserNotInstalledError,
  DEFAULT_LINUX_CHROMIUM_ARGS,
  PlaywrightBrowserPort,
  explainLaunchFailure,
  resolveLaunchArgs,
} from "./playwright-browser-port.js";

type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** A launcher that captures what the port asked for, then aborts before any browser starts. */
function capturingLauncher(): { launch: typeof chromium.launchPersistentContext; calls: { dir: string; options: LaunchOptions }[] } {
  const calls: { dir: string; options: LaunchOptions }[] = [];
  const launch: typeof chromium.launchPersistentContext = async (dir, options) => {
    calls.push({ dir, options: options ?? {} });
    throw new Error("launch intercepted by test");
  };
  return { launch, calls };
}

const base = { profileDir: "/tmp/profile", headless: true, allowedOrigins: [], baseUrl: "http://127.0.0.1:1" };

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

describe("PlaywrightBrowserPort.open launch options", () => {
  test("passes executablePath, channel and extended args through to the launcher", async () => {
    const { launch, calls } = capturingLauncher();
    const port = new PlaywrightBrowserPort({ launchPersistentContext: launch, platform: "linux" });
    await expect(
      port.open({ ...base, executablePath: "/opt/chromium/chrome", channel: "chromium", args: ["--lang=de"] }),
    ).rejects.toThrow("launch intercepted by test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.dir).toBe("/tmp/profile");
    expect(calls[0]!.options).toMatchObject({
      headless: true,
      baseURL: "http://127.0.0.1:1",
      executablePath: "/opt/chromium/chrome",
      channel: "chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=de"],
    });
  });

  test("omitted executablePath/channel are not sent at all (Playwright's pinned Chromium is used)", async () => {
    const { launch, calls } = capturingLauncher();
    const port = new PlaywrightBrowserPort({ launchPersistentContext: launch, platform: "linux" });
    await expect(port.open(base)).rejects.toThrow();
    expect("executablePath" in calls[0]!.options).toBe(false);
    expect("channel" in calls[0]!.options).toBe(false);
    expect(calls[0]!.options.args).toEqual([...DEFAULT_LINUX_CHROMIUM_ARGS]);
  });

  test("a missing pinned Chromium surfaces an actionable `npx playwright install chromium` error", async () => {
    const launch: typeof chromium.launchPersistentContext = async () => {
      throw new Error(
        "browserType.launchPersistentContext: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1/chrome\n" +
          "╔════╗ Looks like Playwright was just installed or updated.",
      );
    };
    const port = new PlaywrightBrowserPort({ launchPersistentContext: launch, platform: "linux" });
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
