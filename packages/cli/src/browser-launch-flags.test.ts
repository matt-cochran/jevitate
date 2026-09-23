import { describe, expect, it } from "vitest";
import type { chromium } from "playwright";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, createBrowserPool } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

/**
 * The `--browser-*` flags must survive the whole thread
 *   commander → program action → run*Mission → PlaywrightBrowserPort.open → chromium launch
 * without being dropped anywhere. The real port is used; only Playwright's
 * `chromium.launch` (the pooled launch) is replaced by a capturing launcher
 * that aborts before any browser starts, and admission sees a calm fixture
 * host so the test never depends on this machine's load.
 */
function capture(): { program: ReturnType<typeof buildProgram>; lines: string[]; launches: LaunchOptions[] } {
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
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: {
      judge: new FakeJudgmentGateway({}),
      gen: new FakeGenerationGateway(),
      browserPortFactory: () => new PlaywrightBrowserPort({ launch, platform: "linux", pool }),
    },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, launches };
}

const FLAGS = [
  "--browser-executable",
  "/opt/chromium/chrome",
  "--browser-channel",
  "chromium",
  "--browser-arg",
  "--lang=de",
  "--browser-arg",
  "--disable-gpu",
];

const EXPECTED = {
  executablePath: "/opt/chromium/chrome",
  channel: "chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=de", "--disable-gpu"],
};

const URL = "http://127.0.0.1:3000/login";

describe("--browser-* flags reach PlaywrightBrowserPort's chromium launch", () => {
  const cases: { name: string; argv: string[] }[] = [
    { name: "explore (goal)", argv: ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x"] },
    { name: "explore --strategy coverage", argv: ["explore", "--strategy", "coverage", "--url", URL] },
    { name: "explore --strategy adversarial", argv: ["explore", "--strategy", "adversarial", "--url", URL] },
    {
      name: "explore --strategy usability",
      argv: ["explore", "--strategy", "usability", "--url", URL, "--goal", "g", "--app-class", "admin"],
    },
    {
      name: "explore-author-journey",
      argv: ["explore-author-journey", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--id", "j", "--name", "J"],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: executable/channel/args are all threaded through`, async () => {
      const { program, lines, launches } = capture();
      await program.parseAsync([...c.argv, ...FLAGS, "--json"], { from: "user" });
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject(EXPECTED);
      // The intercepted launch surfaces as a run failure, never a silent success.
      expect(JSON.parse(lines.join(""))).toMatchObject({ ok: false });
      expect(lines.join("")).toContain("launch intercepted by test");
    });
  }

  it("with no --browser-* flags the launch carries only the Linux defaults", async () => {
    const { program, launches } = capture();
    await program.parseAsync(["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--json"], {
      from: "user",
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]!.args).toEqual(["--no-sandbox", "--disable-dev-shm-usage"]);
    expect("executablePath" in launches[0]!).toBe(false);
    expect("channel" in launches[0]!).toBe(false);
  });
});
