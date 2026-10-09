import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

/** #450: the Chromium build Playwright pins for this jevitate, and where it lives on disk. */

/** One browser family jevitate launches, with its pinned revision and install directory prefix. */
export interface PinnedBrowser {
  name: "chromium" | "chromium-headless-shell";
  revision: string;
  /** Directory-name prefix in the browsers dir: `<dirPrefix>-<revision>`. */
  dirPrefix: string;
  browserVersion?: string;
}

/** installed = the pinned revision is present; missing = nothing for this family; other-revisions-only = only other revisions exist. */
export type InstallState = "installed" | "missing" | "other-revisions-only";

export interface PinnedBrowserStatus {
  browser: PinnedBrowser["name"];
  revision: string;
  state: InstallState;
  /** Other revisions found in the browsers dir (never touched by install-browser). */
  otherRevisions: string[];
}

export interface PinnedBrowserReport {
  browsersDir: string;
  /** The path Playwright reports for the pinned Chromium executable. */
  executablePath: string;
  browsers: PinnedBrowserStatus[];
  ok: boolean;
  fix: string | null;
  /** A shell line a project script can use to share this browsers dir. */
  exportLine: string;
}

export const INSTALL_COMMAND = "jevitate install-browser";

const DIR_PREFIX: Record<PinnedBrowser["name"], string> = {
  chromium: "chromium",
  "chromium-headless-shell": "chromium_headless_shell",
};

/** The require function rooted at the `playwright` package jevitate depends on. */
function playwrightRequire(): NodeRequire {
  return createRequire(createRequire(import.meta.url).resolve("playwright/package.json"));
}

/** The pinned Chromium + headless-shell revisions, read from the installed playwright-core's browsers.json. */
export function pinnedBrowsers(): PinnedBrowser[] {
  const core = playwrightRequire().resolve("playwright-core/package.json");
  const manifest = createRequire(core)("./browsers.json") as { browsers: Array<{ name: string; revision: string; browserVersion?: string }> };
  const out: PinnedBrowser[] = [];
  for (const name of ["chromium", "chromium-headless-shell"] as const) {
    const e = manifest.browsers.find((b) => b.name === name);
    if (e === undefined) continue;
    out.push({ name, revision: e.revision, dirPrefix: DIR_PREFIX[name], ...(e.browserVersion === undefined ? {} : { browserVersion: e.browserVersion }) });
  }
  return out;
}

/** The browsers directory Playwright uses: PLAYWRIGHT_BROWSERS_PATH, else the per-OS default cache. */
export function browsersDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const fromEnv = env.PLAYWRIGHT_BROWSERS_PATH;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (fromEnv === "0") return join(dirname(playwrightRequire().resolve("playwright-core/package.json")), ".local-browsers");
    return fromEnv;
  }
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

export interface BrowserFs {
  readdir(dir: string): string[];
}
const realFs: BrowserFs = { readdir: (d) => (existsSync(d) ? readdirSync(d) : []) };

/** Classifies each pinned browser against the directories present in `dir`. */
export function classifyInstalled(pinned: PinnedBrowser[], dir: string, fs: BrowserFs = realFs): PinnedBrowserStatus[] {
  const entries = fs.readdir(dir);
  return pinned.map((p) => {
    const prefix = `${p.dirPrefix}-`;
    const revs = entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length));
    const state: InstallState = revs.includes(p.revision) ? "installed" : revs.length > 0 ? "other-revisions-only" : "missing";
    return { browser: p.name, revision: p.revision, state, otherRevisions: revs.filter((r) => r !== p.revision).sort() };
  });
}

export interface PinnedBrowserDeps {
  env?: NodeJS.ProcessEnv;
  fs?: BrowserFs;
  pinned?: PinnedBrowser[];
  executablePath?: () => string;
}

/** Pinned revisions vs what is installed, the browsers dir, the executable path and the fix command. */
export function pinnedBrowserReport(deps: PinnedBrowserDeps = {}): PinnedBrowserReport {
  const env = deps.env ?? process.env;
  const dir = browsersDir(env);
  const browsers = classifyInstalled(deps.pinned ?? pinnedBrowsers(), dir, deps.fs);
  const ok = browsers.every((b) => b.state === "installed");
  return {
    browsersDir: dir,
    executablePath: (deps.executablePath ?? (() => chromium.executablePath()))(),
    browsers,
    ok,
    fix: ok ? null : INSTALL_COMMAND,
    exportLine: `export PLAYWRIGHT_BROWSERS_PATH=${JSON.stringify(dir)}`,
  };
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => { on(event: "exit" | "error", cb: (arg: never) => void): unknown };

/** The command line and environment `install-browser` runs. */
export function installPlan(opts: { withDeps?: boolean; env?: NodeJS.ProcessEnv }): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return {
    command: process.execPath,
    args: [cli, "install", ...(opts.withDeps === true ? ["--with-deps"] : []), "chromium"],
    // SKIP_BROWSER_GC: installing never removes other revisions other projects still use.
    env: { ...(opts.env ?? process.env), PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
  };
}

/** Runs the playwright CLI jevitate depends on; resolves with its exit code. */
export function installBrowser(opts: { withDeps?: boolean; env?: NodeJS.ProcessEnv; spawn?: SpawnFn } = {}): Promise<number> {
  const plan = installPlan(opts);
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { stdio: "inherit", env: plan.env });
    child.on("error", ((e: Error) => reject(e)) as (arg: never) => void);
    child.on("exit", ((code: number | null) => resolve(code ?? 1)) as (arg: never) => void);
  });
}
