import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { TargetDescriptor } from "@jevitate/recording";
import type { StepObserver } from "@jevitate/interpreter";
import { runCheck, type CheckResult, type CheckRunners, type RunCheckOptions } from "./check-api.js";
import { registerCheckCommand } from "./check-cli.js";
import { parseSuite } from "./check-suite.js";

/**
 * #479: `jevitate check` records the app's release label. `--app-version <label>` (else
 * `JEVITATE_APP_VERSION`) is stamped next to `targetBuild` in the result and the SARIF run
 * properties; an invalid label is refused before anything runs, an invalid env value is ignored
 * with a warning.
 */

const TEST_ID: TargetDescriptor = { testId: "pay", testIdAttr: "data-testid" };
const shown = { kind: "visible" as const, target: { role: "heading", name: "Cart" } };

function journey(): Journey {
  return {
    metadata: { id: "pay", name: "Pay", promoted: true, params: [], createdAtIso: "2026-10-09T00:00:00.000Z" },
    recording: {
      version: "1.0.0",
      site: "https://shop.example",
      pages: [{ url: "/cart", steps: [{ stepId: "s-a", step: { kind: "click" as const, target: TEST_ID, expect: shown } }] }],
    },
  };
}

let dir: string;
let fake: FakeClock;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jev-app-version-"));
  fake = new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") });
  installClock(fake);
  await new FsJourneyStore(dir).put(journey());
});
afterEach(() => {
  resetClock();
  rmSync(dir, { recursive: true, force: true });
});

const runner: CheckRunners["journey"] = (async (o: { observer?: StepObserver }) => {
  const steps = journey().recording.pages[0]!.steps;
  for (const [index, recorded] of steps.entries()) {
    await o.observer?.beforeStep?.({ actor: {} as never, index, recorded });
    await fake.advanceBy(100);
    await o.observer?.afterStep?.({ actor: {} as never, index, recorded, outcome: "done" });
  }
  return { outcome: "ok", output: {} };
}) as unknown as CheckRunners["journey"];

const suite = () => parseSuite({ version: 1, name: "s", targets: [{ name: "shop", url: "https://shop.example/cart", journeys: [{ id: "pay" }] }] }, join(dir, "suite.json"));

function check(extra: Partial<RunCheckOptions> = {}, out = "out"): Promise<CheckResult> {
  return runCheck({ suite: suite(), outDir: join(dir, out), journeysDir: dir, projectDir: null, runners: { journey: runner }, ...extra });
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

describe("#479 the check record carries the app version", () => {
  it("the CheckResult stamps appVersion next to targetBuild", async () => {
    expect((await check({ appVersion: "2026.10.1", targetBuild: "abc1234" })).appVersion).toBe("2026.10.1");
  });

  it("check.json carries the app version", async () => {
    expect(readJson((await check({ appVersion: "2026.10.1" })).jsonPath).data.appVersion).toBe("2026.10.1");
  });

  it("the SARIF run properties carry the app version next to targetBuild", async () => {
    const sarif = readJson((await check({ appVersion: "2026.10.1", targetBuild: "abc1234" })).sarifPath);
    expect(sarif.runs[0].properties).toMatchObject({ targetBuild: "abc1234", appVersion: "2026.10.1" });
  });

  it("a check without an app version names none", async () => {
    expect((await check()).appVersion).toBeUndefined();
  });
});

describe("#479 the check CLI resolves the app version", () => {
  const suitePath = () => join(dir, "suite.json");
  const outDir = (out: string) => join(dir, out);

  async function cli(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}, out = "cli"): Promise<{ code: number | undefined; err: string }> {
    writeFileSync(suitePath(), JSON.stringify({ version: 1, name: "s", targets: [{ name: "shop", url: "https://shop.example/cart", journeys: [{ id: "pay" }] }] }));
    const program = new Command();
    program.exitOverride();
    const err: string[] = [];
    program.configureOutput({ writeOut: () => {}, writeErr: (s) => err.push(s) });
    registerCheckCommand(
      program,
      { buildGateways: () => Promise.reject(new Error("no gateways")), journeysDir: dir, catalogDir: join(dir, "no-project"), targetsConfigPath: join(dir, "no-targets.json"), runners: { journey: runner }, env },
      (c) => c,
    );
    process.exitCode = undefined;
    await program.parseAsync(["check", "--suite", suitePath(), "--out", outDir(out), ...argv], { from: "user" });
    const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
    process.exitCode = undefined;
    return { code, err: err.join("") };
  }

  it("--app-version writes the label to check.json", async () => {
    await cli(["--app-version", "2026.10.1"]);
    expect(readJson(join(outDir("cli"), "check.json")).data.appVersion).toBe("2026.10.1");
  });

  it("--app-version with an invalid label is refused (exit 64)", async () => {
    expect((await cli(["--app-version", "bad version"])).code).toBe(64);
  });

  it("an invalid --app-version runs nothing", async () => {
    await cli(["--app-version", "bad version"]);
    expect(existsSync(join(outDir("cli"), "check.json"))).toBe(false);
  });

  it("JEVITATE_APP_VERSION stamps appVersion when the flag is absent", async () => {
    await cli([], { JEVITATE_APP_VERSION: "1.4.0" });
    expect(readJson(join(outDir("cli"), "check.json")).data.appVersion).toBe("1.4.0");
  });

  it("an invalid JEVITATE_APP_VERSION is ignored", async () => {
    await cli([], { JEVITATE_APP_VERSION: "has space" });
    expect(readJson(join(outDir("cli"), "check.json")).data.appVersion).toBeUndefined();
  });

  it("an invalid JEVITATE_APP_VERSION warns on stderr", async () => {
    expect((await cli([], { JEVITATE_APP_VERSION: "has space" })).err).toMatch(/ignoring JEVITATE_APP_VERSION/);
  });

  it("--app-version wins over the environment", async () => {
    await cli(["--app-version", "2026.10.1"], { JEVITATE_APP_VERSION: "1.4.0" });
    expect(readJson(join(outDir("cli"), "check.json")).data.appVersion).toBe("2026.10.1");
  });
});
