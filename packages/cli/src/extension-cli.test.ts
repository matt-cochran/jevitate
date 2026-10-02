import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError, type Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { extensionOrigin, readUnpackedExtension, type BrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { allowWithExtensions, assertExtensionTargetLoaded, assertSameExtensionBuild, ExtensionMismatchError, extensionsStamp } from "./browser-run-options.js";
import { browserLaunchFromFlags } from "./cli-shared.js";
import { McpArgError, optExtensions } from "./mcp-args.js";

/** #256 — `--extension <dir>`: refusals (exit 64, before any browser) and the allowlist/recording rules. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "playwright", "test-fixtures", "extension-mv3");
const OTHER_ID = "abcdefghijklmnopabcdefghijklmnop";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-ext-cli-"));
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "file.txt"), "x");
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

describe("--extension refusals (usage errors, exit 64, nothing launched)", () => {
  it.each([
    ["a missing directory", () => join(dir, "nope"), /extension directory not found/],
    ["a file", () => join(dir, "file.txt"), /got a file/],
    ["a directory without manifest.json", () => join(dir, "empty"), /no manifest\.json/],
  ])("explore refuses %s", async (_what, path, message) => {
    const r = await run(["explore", "--extension", path(), "--url", "http://127.0.0.1:9/", "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(JSON.parse(r.stdout).error.message).toMatch(message);
  });

  it("journey run, verify-fix and check refuse a bad directory the same way (the shared flag)", async () => {
    for (const argv of [
      ["journey", "run", "j1", "--extension", join(dir, "empty"), "--json"],
      ["verify-fix", "0123456789abcdef", "--extension", join(dir, "empty"), "--json"],
      ["check", join(dir, "suite.json"), "--extension", join(dir, "empty"), "--json"],
    ]) {
      const r = await run(argv);
      expect(r.exitCode, argv.join(" ")).toBe(64);
      expect(JSON.parse(r.stdout).error.message).toMatch(/no manifest\.json/);
    }
  });

  it("explore refuses a chrome-extension:// URL of an extension it does not load, naming the loaded ones", async () => {
    const r = await run(["explore", "--extension", FIXTURE, "--url", `chrome-extension://${OTHER_ID}/sidepanel.html`, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--json"]);
    expect(r.exitCode).toBe(64);
    const err = JSON.parse(r.stdout).error;
    expect(err.code).toBe("E_EXPLORE_ARGS");
    expect(err.message).toContain(`loaded: Jevitate Fixture Extension → ${extensionOrigin(readUnpackedExtension(FIXTURE).id)}/`);
  });

  it("record refuses a chrome-extension:// URL with no --extension", async () => {
    const r = await run(["record", "--url", `chrome-extension://${OTHER_ID}/popup.html`, "--json"]);
    expect(r.exitCode).toBe(64);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "E_RECORD_ARGS" });
    expect(JSON.parse(r.stdout).error.message).toMatch(/load it with --extension <dir>/);
  });
});

describe("loaded extensions: allowlist, target check and Recording stamp", () => {
  const ext = readUnpackedExtension(FIXTURE);
  const browser = browserLaunchFromFlags({ browserArg: [], extension: [ext] });
  const EXT = extensionOrigin(ext.id);

  it("allows ONLY the loaded ids, on top of the default or the explicit --allow", () => {
    expect(allowWithExtensions("http://127.0.0.1:3000/a", [], browser)).toEqual(["http://127.0.0.1:3000", EXT]);
    expect(allowWithExtensions("http://127.0.0.1:3000/a", ["https://api.test"], browser)).toEqual(["https://api.test", EXT]);
    expect(allowWithExtensions(`${EXT}/sidepanel.html`, [], browser)).toEqual([EXT]);
    expect(allowWithExtensions("http://127.0.0.1:3000/a", [], undefined)).toEqual([]);
  });

  it("a chrome-extension:// target must be a loaded extension's; any other URL passes", () => {
    expect(() => assertExtensionTargetLoaded(`${EXT}/sidepanel.html`, browser)).not.toThrow();
    expect(() => assertExtensionTargetLoaded("http://127.0.0.1:3000/", undefined)).not.toThrow();
    expect(() => assertExtensionTargetLoaded(`chrome-extension://${OTHER_ID}/x.html`, browser)).toThrow(ExtensionMismatchError);
    expect(() => assertExtensionTargetLoaded("chrome-extension://bad/x.html", browser)).toThrow(ExtensionMismatchError);
  });

  it("stamps id/name/version (never the local path) and compares builds", () => {
    expect(extensionsStamp(browser)).toEqual({ extensions: [{ id: ext.id, name: "Jevitate Fixture Extension", version: "1.2.3" }] });
    expect(extensionsStamp(undefined)).toEqual({});
    const recorded = extensionsStamp(browser).extensions;
    expect(() => assertSameExtensionBuild(recorded, browser, "x")).not.toThrow();
    expect(() => assertSameExtensionBuild(recorded, undefined, "x")).toThrow(/recorded with extensions .* but this run loads none/);
    expect(() => assertSameExtensionBuild(undefined, browser, "x")).toThrow(/recorded with extensions none/);
  });
});

describe("MCP extension argument (#255 confinement)", () => {
  it("confines each directory to the allowed roots and checks its manifest", () => {
    expect(optExtensions({ extension: [FIXTURE] }, [dirname(FIXTURE)])?.map((e) => e.name)).toEqual(["Jevitate Fixture Extension"]);
    expect(() => optExtensions({ extension: [FIXTURE] }, [dir])).toThrow(/resolves outside the paths an MCP tool may use/);
    expect(() => optExtensions({ extension: [join(dir, "empty")] }, [dir])).toThrow(/no manifest\.json/);
    expect(() => optExtensions({ extension: "x" }, [dir])).toThrow(McpArgError);
    expect(optExtensions({}, [dir])).toBeUndefined();
  });
});
