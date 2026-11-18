import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError, type Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { browserArgWarnings, browserLaunchFromFlags, localDevCertNotice } from "./cli-shared.js";

/** #872 — `--accept-local-dev-cert <origin>`: refusals (exit 64, before any browser) and the launch mapping. */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-devcert-cli-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A port that fails the test if anything tries to open a browser. */
const noBrowser = (): BrowserPort => ({
  open: () => {
    throw new Error("a browser was opened");
  },
});

async function run(argv: string[]): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  const program: Command = buildProgram({
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: { judge: new FakeJudgmentGateway(), gen: new FakeGenerationGateway(), browserPortFactory: noBrowser },
    record: { browserPortFactory: noBrowser },
  });
  const quiet = (c: Command): void => {
    c.exitOverride();
    c.configureOutput({ writeOut: (s) => (stdout += s), writeErr: () => undefined, outputError: () => undefined });
    c.commands.forEach(quiet);
  };
  quiet(program);
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(argv, { from: "user" });
    return { exitCode: Number(process.exitCode ?? 0), stdout };
  } catch (err) {
    if (err instanceof CommanderError) return { exitCode: err.exitCode, stdout };
    throw err;
  } finally {
    process.exitCode = saved;
  }
}

const explore = (origin: string): string[] => [
  "explore", "--accept-local-dev-cert", origin, "--url", "https://localhost:5173/", "--goal", "g",
  "--success", "urlIncludes:/x", "--fake-ai", "--json",
];

describe("--accept-local-dev-cert refusals (usage errors, exit 64, nothing launched)", () => {
  it("explore refuses a public host", async () => {
    const r = await run(explore("https://example.com"));
    expect(r.exitCode).toBe(64);
  });

  it("the refusal names the loopback rule", async () => {
    const r = await run(explore("https://example.com"));
    expect(JSON.parse(r.stdout).error.message).toMatch(/loopback/);
  });

  it("explore refuses a plain-http origin", async () => {
    const r = await run(explore("http://localhost:5173"));
    expect(JSON.parse(r.stdout).error.message).toMatch(/https/);
  });

  it.each([
    [["journey", "run", "j1", "--accept-local-dev-cert", "https://example.com", "--json"]],
    [["verify-fix", "0123456789abcdef", "--accept-local-dev-cert", "https://example.com", "--json"]],
    [["check", "suite.json", "--accept-local-dev-cert", "https://example.com", "--json"]],
  ])("%j refuses it with the loopback rule (the shared flag)", async (argv) => {
    // Exit 64 alone would also be an unknown flag; the message proves the flag exists and refused it.
    const r = await run(argv);
    expect(JSON.parse(r.stdout).error.message).toMatch(/not a loopback host/);
  });
});

describe("browserLaunchFromFlags", () => {
  it("passes the accepted origins to the launch as localDevCertOrigins", () => {
    const launch = browserLaunchFromFlags({ browserArg: [], acceptLocalDevCert: ["https://localhost:5173"] });
    expect(launch?.localDevCertOrigins).toEqual(["https://localhost:5173"]);
  });

  it("no accepted origins → no localDevCertOrigins", () => {
    const launch = browserLaunchFromFlags({ browserArg: ["--lang=de"], acceptLocalDevCert: [] });
    expect(launch !== undefined && "localDevCertOrigins" in launch).toBe(false);
  });
});

describe("browserArgWarnings", () => {
  it("warns when --browser-arg turns certificate checks off for every host", () => {
    expect(browserArgWarnings(["--ignore-certificate-errors"])[0]).toMatch(/--accept-local-dev-cert/);
  });

  it("does not warn for other switches", () => {
    expect(browserArgWarnings(["--lang=de", "--disable-gpu"])).toEqual([]);
  });

  it("does not warn for the pinned (scoped) switch", () => {
    expect(browserArgWarnings(["--ignore-certificate-errors-spki-list=AAA="])).toEqual([]);
  });
});

describe("localDevCertNotice", () => {
  it("names the accepted origin and that only its current key is trusted", () => {
    expect(localDevCertNotice("https://localhost:5173")).toMatch(/https:\/\/localhost:5173.*current key/);
  });
});
