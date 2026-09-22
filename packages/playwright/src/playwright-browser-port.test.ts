import { afterAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { PlaywrightBrowserPort } from "./playwright-browser-port.js";

/** The argv (space-joined) of the browser process launched on `profileDir`; throws if none. */
async function browserCommandLineFor(profileDir: string): Promise<string> {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string;
    try {
      argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ");
    } catch {
      continue; // process exited mid-scan
    }
    if (argv.includes(`--user-data-dir=${profileDir}`) && !argv.includes("--type=")) return argv;
  }
  throw new Error(`no browser process found for profile ${profileDir}`);
}

const port = new PlaywrightBrowserPort();

test("opens a persistent context and navigates to a data: URL", async () => {
  const profileDir = await mkdtemp(join(tmpdir(), "jevitate-pw-"));
  const session = await port.open({ profileDir, headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    await session.page.setContent("<h1>hello</h1>");
    expect(await session.page.locator("h1").textContent()).toBe("hello");
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}, 60_000);

// Preflight G1: a REAL headless Chromium launch through the port with NO caller
// args must start and apply the Linux defaults (the WSL/container baseline).
test.runIf(process.platform === "linux")(
  "real launch on Linux applies DEFAULT_LINUX_CHROMIUM_ARGS to the browser command line",
  async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "jevitate-pw-"));
    const session = await port.open({ profileDir, headless: true, allowedOrigins: [], baseUrl: "about:blank" });
    try {
      // Headless shell refuses chrome://version, so read the launched browser's
      // real argv from /proc: the process whose --user-data-dir is our profile.
      const commandLine = await browserCommandLineFor(profileDir);
      expect(commandLine).toContain("--no-sandbox");
      expect(commandLine).toContain("--disable-dev-shm-usage");
    } finally {
      await session.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  },
  60_000,
);
