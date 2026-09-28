import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import { runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { armedMissionCount } from "./kill-signal.js";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #226 (3): a SIGTERM that lands while Chromium is still starting — seconds on a loaded host — used to
 * find no mission armed, so the CLI exited 143 with no output and no output dir. Every explore runner
 * (goal, coverage, adversarial, feature, usability — all through `launchArmed`) now arms its kill switch BEFORE the browser launch (a signal then writes and prints the partial
 * result), and disarms it when the launch fails.
 */

const URL = "http://127.0.0.1:3000/";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A browser port whose launch is still pending until the test rejects it. */
function slowLaunch(): { factory: () => BrowserPort; launching: Promise<void>; fail: (e: Error) => void } {
  let fail: (e: Error) => void = () => undefined;
  let started: () => void = () => undefined;
  const launching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const port = {
    open: () =>
      new Promise((_, reject) => {
        fail = reject;
        started();
      }),
  } as unknown as BrowserPort;
  return { factory: () => port, launching, fail: (e) => fail(e) };
}

const judge = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
const gen = new FakeGenerationGateway();

const runners: Array<[string, (factory: () => BrowserPort, outDir: string) => Promise<unknown>]> = [
  ["goal", (browserPortFactory, outDir) => runExploration({ url: URL, goal: "x", successAssertion: { kind: "urlIncludes", text: "/x" }, allowlist: [URL], judge, gen, browserPortFactory, outDir })],
  ["coverage", (browserPortFactory, outDir) => runCoverageMission({ url: URL, allowlist: [URL], judge, gen, browserPortFactory, outDir })],
  [
    "adversarial",
    (browserPortFactory, outDir) =>
      runAdversarialCliMission({ seedUrl: URL, allowlist: [URL], strategies: ["exercise-controls"], judgment: judge, generation: gen, browserPortFactory, outDir }),
  ],
  [
    "feature",
    (browserPortFactory, outDir) =>
      runFeatureCliMission({ seedUrl: URL, allowlist: [URL], capability: "x", routeGlobs: ["/**"], judge, gen, browserPortFactory, outDir } as Parameters<typeof runFeatureCliMission>[0]),
  ],
  [
    "usability",
    (browserPortFactory, outDir) =>
      runUsabilityMission({ url: URL, job: "look around", allowlist: [URL], appContext: { appClass: "consumer", job: "look around" }, judge, gen, browserPortFactory, outDir }),
  ],
];

describe("#226 — the kill switch is armed while the browser launches", () => {
  for (const [name, run] of runners) {
    it(`${name}: armed before the launch resolves; disarmed when the launch fails`, async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-arm-early-"));
      dirs.push(outDir);
      const launch = slowLaunch();
      const before = armedMissionCount();
      const pending = run(launch.factory, outDir);
      pending.catch(() => undefined);
      await launch.launching;
      expect(armedMissionCount()).toBe(before + 1);
      launch.fail(new Error("chromium failed to launch"));
      await expect(pending).rejects.toThrow("chromium failed to launch");
      expect(armedMissionCount()).toBe(before);
    });
  }
});
