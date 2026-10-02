import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { readUnpackedExtension, extensionOrigin, ExtensionLoadError } from "./extensions.js";
import { PlaywrightBrowserPort } from "./playwright-browser-port.js";

/**
 * #256 — real Chromium loads an unpacked MV3 extension and a session drives its pages. Headless
 * runs use the full Chromium build in new-headless mode (`channel: "chromium"`): the headless
 * shell cannot load extensions. Skipped ONLY when that build is not installed
 * (`npx playwright install chromium`).
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "extension-mv3");
const FULL_CHROMIUM = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const base = { headless: true, allowedOrigins: [], baseUrl: "about:blank" };

describe.skipIf(!FULL_CHROMIUM)("unpacked extensions in real Chromium (headless, new headless mode)", () => {
  const ext = readUnpackedExtension(FIXTURE);

  it.each(["sidepanel.html", "popup.html"])(
    "opens the extension's %s as a page in the session and a click writes chrome.storage",
    async (page) => {
      const session = await new PlaywrightBrowserPort({ liveness: false }).open({ ...base, extensions: [ext] });
      try {
        expect(session.extensions?.map((e) => e.id)).toEqual([ext.id]);
        await session.page.goto(`${extensionOrigin(ext.id)}/${page}`);
        await session.page.getByRole("button", { name: "I consent" }).click();
        await expect.poll(() => session.page.getByRole("status").textContent()).toBe("consent given");
        const stored = await session.page.evaluate(async () => (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome.storage.local.get("consent"));
        expect(stored).toEqual({ consent: "given" });
        // The page model the agent acts on includes the extension page's DOM.
        expect(await session.page.locator("body").ariaSnapshot()).toContain('button "I consent"');
      } finally {
        await session.close();
      }
    },
    60_000,
  );

  it("the id computed before launch is the id Chromium gave the extension (its service worker's origin)", async () => {
    const session = await new PlaywrightBrowserPort({ liveness: false }).open({ ...base, extensions: [ext] });
    try {
      const page = session.page;
      const workers = page.context().serviceWorkers();
      const sw = workers[0] ?? (await page.context().waitForEvent("serviceworker", { timeout: 10_000 }));
      expect(sw.url()).toBe(`${extensionOrigin(ext.id)}/sw.js`);
    } finally {
      await session.close();
    }
  }, 60_000);

  it("a pre-launch id that drifted from Chromium's is named as such (the id the browser really used)", async () => {
    const drifted = { ...ext, id: "a".repeat(32) };
    const err = await new PlaywrightBrowserPort({ liveness: false }).open({ ...base, extensions: [drifted] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExtensionLoadError);
    expect((err as Error).message).toContain(`loaded an extension under id ${ext.id}`);
  }, 60_000);

  it("applies a storageState to the extension session's throwaway profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-ext-state-"));
    try {
      const state = join(dir, "state.json");
      await writeFile(state, JSON.stringify({ cookies: [{ name: "sid", value: "s1", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }));
      const session = await new PlaywrightBrowserPort({ liveness: false }).open({ ...base, extensions: [ext], storageState: state });
      try {
        const cookies = await session.page.context().cookies("http://127.0.0.1/");
        expect(cookies.map((c) => c.name)).toContain("sid");
      } finally {
        await session.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a browser that ignores --load-extension fails with ExtensionLoadError, not mid-run", async () => {
    // The headless shell cannot load extensions: forcing it shows the typed, explained failure.
    const revisionDir = dirname(dirname(chromium.executablePath())).replace(/chromium-(\d+)$/, "chromium_headless_shell-$1");
    const headlessShell = join(revisionDir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (process.platform !== "linux" || !existsSync(headlessShell)) return; // no headless shell here: nothing to show
    const err = await new PlaywrightBrowserPort({ liveness: false }).open({ ...base, extensions: [ext], executablePath: headlessShell }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionLoadError);
    expect(String((err as Error).message)).toMatch(/did not load the extension/);
  }, 60_000);
});
