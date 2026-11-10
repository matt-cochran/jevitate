import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCheckCommand } from "./check-cli.js";
import { trustDrift } from "./check-trust.js";

/** 0.30.0 #799: `check --require-trust` against a temp git repo (identity through env vars only; no git config). */

let repo: string;
let file: string;
let out: string[];
let err: string[];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
const write = (envs: unknown): void => writeFileSync(file, JSON.stringify(envs));

async function run(args: string[]): Promise<number> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  registerCheckCommand(program, { buildGateways: async () => ({}) as never, journeysDir: join(repo, "journeys"), environmentsFile: file }, (c) => c);
  process.exitCode = undefined;
  await program.parseAsync(["node", "jevitate", "check", "--suite", join(repo, "suite.json"), ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "jev-check-trust-"));
  file = join(repo, "environments.json");
  out = [];
  err = [];
  writeFileSync(join(repo, "suite.json"), JSON.stringify({ version: 1, name: "s", targets: [{ name: "shop", url: "https://shop.example/cart", missions: [] }] }));
  git("init", "-q");
  write({ staging: { baseUrl: "https://staging.example.test", trust: "production" }, dev: { baseUrl: "https://dev.example.test" } });
  git("add", "environments.json");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "envs");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check --require-trust", () => {
  it("a trust edited in the working tree exits 1 naming the environment; after commit it exits 0", async () => {
    write({ staging: { baseUrl: "https://staging.example.test", trust: "test" }, dev: { baseUrl: "https://dev.example.test" } });
    expect(await run(["--require-trust", "--json", "--out", join(repo, "out-refused")])).toBe(1);
    const text = out.join("");
    expect(text).toContain("staging");
    expect(text).toContain("E_TRUST_DRIFT");
    expect(text).not.toContain('"dev"');

    git("add", "environments.json");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "trust");
    expect(await trustDrift(file)).toEqual([]);
    out = [];
    expect(await run(["--require-trust", "--json", "--out", join(repo, "out")])).toBe(0);
    expect(out.join("")).not.toContain("E_TRUST_DRIFT");
  });

  it("a trust added to an environment, or a whole new environment with one, is a drift too", async () => {
    write({ staging: { baseUrl: "https://staging.example.test", trust: "production" }, dev: { baseUrl: "https://dev.example.test", trust: "test" } });
    expect(await trustDrift(file)).toEqual([{ environment: "dev", committed: undefined, working: "test" }]);
    write({ staging: { baseUrl: "https://staging.example.test" }, dev: { baseUrl: "https://dev.example.test" } });
    expect(await trustDrift(file)).toEqual([{ environment: "staging", committed: "production", working: undefined }]);
  });

  it("an edit that leaves every trust alone is not a drift", async () => {
    write({ staging: { baseUrl: "https://staging.example.test", trust: "production", allow: ["https://x.example.test"] }, dev: { baseUrl: "https://dev2.example.test" } });
    expect(await trustDrift(file)).toEqual([]);
  });

  it("outside a git work tree it refuses by name instead of passing", async () => {
    const bare = mkdtempSync(join(tmpdir(), "jev-check-trust-nogit-"));
    try {
      const f = join(bare, "environments.json");
      writeFileSync(f, JSON.stringify({ a: { baseUrl: "https://a.example.test", trust: "test" } }));
      await expect(trustDrift(f, async () => { throw new Error("not a repository"); })).rejects.toThrow(/git work tree/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
