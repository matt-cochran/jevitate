import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { chromium } from "playwright";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import { PlaywrightBrowserPort, createBrowserPool, type BrowserPort, type OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { formatMissionHuman, formatVerifyFixHuman } from "./cli-output.js";
import { browserRunFromFlags } from "./cli-shared.js";
import {
  HEADED_DEFAULT_SLOW_MO_MS,
  HeadedWithoutDisplayError,
  assertHeadedDisplay,
  demoOverlayOf,
  runVideoDir,
  sessionLaunchOptions,
} from "./browser-run-options.js";

/**
 * #245 demo mode — the CLI/browser plumbing: `--headed` / `JEVITATE_HEADED=1`, `--slow-mo`,
 * `--record-video` and `--no-overlay` resolve in ONE place (`browser-run-options.ts`) and reach
 * every runner's browser launch; headless stays the default; bad input is a usage error (64).
 */

const DISPLAY_ENV = { DISPLAY: ":0" };
const URL0 = "http://127.0.0.1:3000/login";

describe("the one resolution (browser-run-options)", () => {
  it("no demo options: headless, no slowMo, no video", () => {
    expect(sessionLaunchOptions(undefined)).toEqual({ headless: true });
    expect(sessionLaunchOptions({ executablePath: "/c", args: ["--x"] })).toEqual({ executablePath: "/c", args: ["--x"], headless: true });
  });

  it("headed: a visible window, slowMo defaults to 250 unless given; demo-only fields never reach the port", () => {
    expect(sessionLaunchOptions({ headed: true })).toEqual({ headless: false, slowMo: HEADED_DEFAULT_SLOW_MO_MS });
    expect(HEADED_DEFAULT_SLOW_MO_MS).toBe(250);
    expect(sessionLaunchOptions({ headed: true, slowMo: 0 })).toEqual({ headless: false, slowMo: 0 });
    expect(sessionLaunchOptions({ slowMo: 40, recordVideo: {}, overlay: false }, "/v")).toEqual({ headless: true, slowMo: 40, recordVideo: { dir: "/v" } });
  });

  it("overlay: shown on a headed run unless --no-overlay; never headless", () => {
    expect(demoOverlayOf(undefined)).toBe(false);
    expect(demoOverlayOf({ headed: true })).toBe(true);
    expect(demoOverlayOf({ headed: true, overlay: false })).toBe(false);
    expect(demoOverlayOf({ recordVideo: {} })).toBe(false);
  });

  it("videos go in a per-run folder beside the run's artifact, or under --record-video <dir>", () => {
    expect(runVideoDir(undefined, "/out/explore-1.json")).toBeUndefined();
    expect(runVideoDir({ recordVideo: {} }, "/out/explore-1.json")).toBe("/out/explore-1.videos");
    expect(runVideoDir({ recordVideo: { dir: "/demo" } }, "/out/explore-1.json")).toBe("/demo/explore-1.videos");
  });

  it("headed without a display is refused on Linux only; JEVITATE_HEADED=1 turns headed on", () => {
    expect(() => assertHeadedDisplay(true, {}, "linux")).toThrow(HeadedWithoutDisplayError);
    expect(() => assertHeadedDisplay(true, {}, "linux")).toThrow(/--record-video/);
    expect(() => assertHeadedDisplay(true, { WAYLAND_DISPLAY: "wayland-0" }, "linux")).not.toThrow();
    expect(() => assertHeadedDisplay(true, {}, "darwin")).not.toThrow();
    expect(() => assertHeadedDisplay(false, {}, "linux")).not.toThrow();
    expect(browserRunFromFlags({ browserArg: [] }, { JEVITATE_HEADED: "1", DISPLAY: ":0" }, "linux")).toEqual({ headed: true });
    expect(browserRunFromFlags({ browserArg: [] }, {}, "linux")).toBeUndefined();
    expect(() => browserRunFromFlags({ browserArg: [], headed: true }, {}, "linux")).toThrow(HeadedWithoutDisplayError);
  });

  it("the human summaries list the videos", () => {
    expect(formatMissionHuman({ missionOutcome: "clean", strategy: "coverage", videoPaths: ["/v/a.webm"] })).toContain("/v/a.webm");
    expect(formatVerifyFixHuman({ verdict: "fixed", fingerprint: "fp", videoPaths: ["/v/b.webm"] }, {})).toContain("/v/b.webm");
  });
});

type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

/** The real port with Playwright's launch intercepted (the `browser-launch-flags.test.ts` seam). */
function captureLaunch(env: Record<string, string | undefined> = DISPLAY_ENV) {
  const launches: LaunchOptions[] = [];
  const launch: typeof chromium.launch = async (options) => {
    launches.push(options ?? {});
    throw new Error("launch intercepted by test");
  };
  const pool = createBrowserPool({
    maxContexts: 1,
    signals: { sample: async () => ({ memAvailableBytes: 8 * 1024 ** 3, source: "fixture:calm" }) },
  });
  const lines: string[] = [];
  const errs: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: {
      judge: new FakeJudgmentGateway({}),
      gen: new FakeGenerationGateway(),
      env,
      browserPortFactory: () => new PlaywrightBrowserPort({ launch, platform: "linux", pool }),
    },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => errs.push(s) });
  // Every (sub)command throws instead of exiting, so a commander refusal's exit code is observable.
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  return { program, lines, errs, launches };
}

/** A capturing fake port: records every `open`, never opens a browser. */
function captureOpens(env: Record<string, string | undefined> = DISPLAY_ENV) {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      throw new Error("open intercepted by test");
    },
  };
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused-in-these-tests"), explore: { browserPortFactory: () => port, env } });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  program.exitOverride();
  return { program, lines, opens };
}

const STRATEGIES: { name: string; argv: string[] }[] = [
  { name: "goal", argv: ["explore", "--url", URL0, "--goal", "g", "--success", "urlIncludes:/x"] },
  { name: "coverage", argv: ["explore", "--strategy", "coverage", "--url", URL0] },
  { name: "exploratory", argv: ["explore", "--strategy", "exploratory", "--url", URL0] },
  { name: "adversarial", argv: ["explore", "--strategy", "adversarial", "--url", URL0] },
  { name: "feature", argv: ["explore", "--feature", "login", "--url", URL0] },
  { name: "usability", argv: ["explore", "--strategy", "usability", "--url", URL0, "--goal", "g", "--app-class", "admin"] },
];

describe("--headed / --slow-mo reach every explore strategy's chromium launch", () => {
  for (const s of STRATEGIES) {
    it(`${s.name}: --headed → a visible window at the default slowMo; --slow-mo overrides; default stays headless`, async () => {
      const headed = captureLaunch();
      await headed.program.parseAsync([...s.argv, "--headed", "--json"], { from: "user" });
      expect(headed.launches).toHaveLength(1);
      expect(headed.launches[0]).toMatchObject({ headless: false, slowMo: 250 });

      const slow = captureLaunch();
      await slow.program.parseAsync([...s.argv, "--headed", "--slow-mo", "40", "--json"], { from: "user" });
      expect(slow.launches[0]).toMatchObject({ headless: false, slowMo: 40 });

      const env = captureLaunch({ ...DISPLAY_ENV, JEVITATE_HEADED: "1" });
      await env.program.parseAsync([...s.argv, "--json"], { from: "user" });
      expect(env.launches[0]).toMatchObject({ headless: false, slowMo: 250 });

      const plain = captureLaunch();
      await plain.program.parseAsync([...s.argv, "--json"], { from: "user" });
      expect(plain.launches[0]).toMatchObject({ headless: true });
      expect("slowMo" in plain.launches[0]!).toBe(false);
    });
  }

  it("a headed multi-window run (--repeat) warns on stderr but is not refused", async () => {
    const { program, errs, launches } = captureLaunch();
    await program.parseAsync([...STRATEGIES[0]!.argv, "--headed", "--repeat", "2", "--json"], { from: "user" });
    expect(errs.join("")).toMatch(/warning: --headed with --repeat\/--persona opens several browser windows/);
    expect(launches.length).toBeGreaterThan(0);
    expect(launches[0]).toMatchObject({ headless: false });
  });
});

describe("demo-mode usage errors (exit 64), before any browser opens", () => {
  it("an invalid --slow-mo is refused", async () => {
    for (const bad of ["-1", "abc", "2.5"]) {
      const { program, launches } = captureLaunch();
      let code: number | undefined;
      try {
        await program.parseAsync([...STRATEGIES[0]!.argv, "--slow-mo", bad, "--json"], { from: "user" });
      } catch (e) {
        code = (e as { exitCode?: number }).exitCode;
      }
      expect(code ?? process.exitCode, bad).toBe(64);
      process.exitCode = undefined;
      expect(launches).toHaveLength(0);
    }
  });

  it("--headed without a display is refused with a hint at --record-video", async () => {
    const { program, lines, launches } = captureLaunch({});
    await program.parseAsync([...STRATEGIES[1]!.argv, "--headed", "--json"], { from: "user" });
    const env = JSON.parse(lines.join("")) as { ok: boolean; error: { code: string; message: string } };
    expect(env).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(env.error.message).toMatch(/DISPLAY.*--record-video/s);
    expect(process.exitCode).toBe(64);
    process.exitCode = undefined;
    expect(launches).toHaveLength(0);
  });
});

describe("--headed / --slow-mo / --record-video reach journey run, verify-fix and regression replay", () => {
  it("journey run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-demo-journey-"));
    try {
      await new JourneyRegistry(new FsJourneyStore(dir)).put({
        metadata: { id: "settings", name: "settings", promoted: true, params: [], createdAtIso: "2026-09-24T00:00:00Z" },
        recording: { version: "1", site: "https://example.test", pages: [] },
      } as never);
      const { program, opens } = captureOpens();
      await program.parseAsync(["journey", "run", "settings", "--dir", dir, "--headed", "--record-video", join(dir, "v"), "--json"], { from: "user" });
      expect(opens[0]).toMatchObject({ headless: false, slowMo: 250 });
      expect(opens[0]!.recordVideo?.dir).toMatch(new RegExp(`^${join(dir, "v")}/journey-settings-.*\\.videos$`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verify-fix (every replay session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-demo-verify-"));
    try {
      const resultPath = join(dir, "run.result.json");
      writeFileSync(
        resultPath,
        JSON.stringify({
          result: {
            target: { seedUrl: "https://example.test/", allowlist: ["https://example.test"] },
            recording: { version: "1", site: "https://example.test", pages: [{ url: "https://example.test/", steps: [] }] },
            defects: [{ fingerprint: "fp1", kind: "console-error", repro: { recordingStepIndex: 0 } }],
          },
        }),
      );
      const { program, opens } = captureOpens();
      await program.parseAsync(["verify-fix", "fp1", "--result", resultPath, "--headed", "--slow-mo", "10", "--replays", "1", "--json"], { from: "user" });
      expect(opens.length).toBeGreaterThan(0);
      for (const o of opens) expect(o).toMatchObject({ headless: false, slowMo: 10 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });

  it("regression run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-demo-regressions-"));
    try {
      const recording = {
        version: "1",
        site: "https://example.test",
        pages: [{ url: "https://example.test/", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/never" } } }] }],
      };
      writeFileSync(join(dir, "r1.recording.json"), JSON.stringify(recording));
      writeFileSync(
        join(dir, "r1.meta.json"),
        JSON.stringify({ id: "r1", capturedAtIso: "2026-09-25T00:00:00Z", fingerprint: { stepSignature: "x" }, reproduction: { attempts: 3, reproducedCount: 3, rate: 1 } }),
      );
      const { program, opens } = captureOpens();
      await program.parseAsync(["regression", "run", "r1", "--dir", dir, "--headed", "--json"], { from: "user" });
      expect(opens.length).toBeGreaterThan(0);
      expect(opens[0]).toMatchObject({ headless: false, slowMo: 250 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });
});
