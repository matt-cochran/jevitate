import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { Command } from "commander";
import { forwardedArgv, lastEnvelope } from "./multi-run-cli.js";

/** `explore --repeat/--persona` wiring: flags validated first, each run re-invokes `explore`. */
function capture(): { program: ReturnType<typeof buildProgram>; lines: string[]; opens: OpenOptions[] } {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      throw new Error("open intercepted by test");
    },
  };
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => port },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  program.exitOverride();
  return { program, lines, opens };
}

const URL = "http://127.0.0.1:3000/app";
const dir = mkdtempSync(join(tmpdir(), "jev-multi-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("explore --repeat / --persona CLI", () => {
  it("rejects bad multi-run flags before any browser opens", async () => {
    const { program, lines, opens } = capture();
    await program.parseAsync(["explore", "--strategy", "coverage", "--url", URL, "--repeat", "2", "--min-agreement", "3", "--json"], { from: "user" });
    expect(JSON.parse(lines.join(""))).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(opens).toHaveLength(0);
    process.exitCode = 0;
  });

  it("a run's command-level failure stops the multi-run instead of repeating it N times", async () => {
    const { program, lines, opens } = capture();
    // goal strategy without --goal/--success: the first run's own validation fails.
    await program.parseAsync(["explore", "--url", URL, "--repeat", "3", "--out", join(dir, "aborted"), "--json"], { from: "user" });
    expect(JSON.parse(lines.join(""))).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(opens).toHaveLength(0);
    process.exitCode = 0;
  });

  it("forwards the mission's own flags to every run, sequentially, each with its own --out", async () => {
    const { program, lines, opens } = capture();
    const out = join(dir, "forwarded");
    await program.parseAsync(
      ["explore", "--strategy", "coverage", "--url", URL, "--max-actions", "3", "--browser-channel", "chrome", "--repeat", "2", "--out", out, "--json"],
      { from: "user" },
    ).catch(() => undefined);
    const env = JSON.parse(lines.join("")) as { ok: boolean; data: { cells: Array<{ runs: unknown[] }> } };
    expect(env.ok).toBe(true);
    expect(env.data.cells[0]!.runs).toHaveLength(2);
    expect(opens).toHaveLength(2);
    process.exitCode = 0;
  });

  it("#290: a bare optional-value flag is forwarded bare, never as the value \"true\"", async () => {
    const cmd = new Command("explore")
      .exitOverride()
      .option("--screenshots [mode]")
      .option("--record-video [dir]")
      .option("--url <url>")
      .action(() => undefined);
    await cmd.parseAsync(["--screenshots", "--record-video", "--url", URL], { from: "user" });
    expect(forwardedArgv(cmd)).toEqual(["--screenshots", "--record-video", "--url", URL]);
    const explicit = new Command("explore").exitOverride().option("--screenshots [mode]").action(() => undefined);
    await explicit.parseAsync(["--screenshots", "steps"], { from: "user" });
    expect(forwardedArgv(explicit)).toEqual(["--screenshots", "steps"]);
  });

  it("#290: bare --record-video in a multi-run records into each run's own directory, never ./true", async () => {
    const { program, opens } = capture();
    const out = join(dir, "bare-video");
    await program.parseAsync(
      ["explore", "--strategy", "coverage", "--url", URL, "--max-actions", "1", "--record-video", "--screenshots", "--repeat", "2", "--out", out, "--json"],
      { from: "user" },
    ).catch(() => undefined);
    expect(opens).toHaveLength(2);
    const dirs = opens.map((o) => o.recordVideo?.dir);
    for (const d of dirs) {
      expect(d).toBeDefined();
      expect(d!.startsWith(out)).toBe(true);
      expect(d).not.toMatch(/(^|[\\/])true([\\/]|$)/);
    }
    expect(new Set(dirs).size).toBe(2);
    process.exitCode = 0;
  });

  it("reads the last envelope a run wrote", () => {
    expect(lastEnvelope(['{"v":1,"ok":true,"data":1}\n'])).toEqual({ v: 1, ok: true, data: 1 });
    expect(lastEnvelope(["noise\n"])).toMatchObject({ ok: false });
  });
});
