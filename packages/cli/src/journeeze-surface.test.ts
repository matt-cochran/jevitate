import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram, type CliDeps } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";

/**
 * #464 — the registered surfaces end to end (no network: nothing here resolves a key to send):
 * MCP `publish_to_journeeze` never takes or returns the key and, without one, tells a person to
 * connect; CLI `connect journeeze` refuses without a terminal.
 */

const KEY = "jzu_abcdefghijklmnopqrstuvwxyz234567abcdefgh";
let dir: string;
const saved = { HOME: process.env.HOME, KEY: process.env.JOURNEEZE_UPLOAD_KEY, URL: process.env.JOURNEEZE_URL };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-journeeze-surface-"));
  mkdirSync(join(dir, "catalog"), { recursive: true });
  process.env.HOME = dir; // the saved connection lives under ~/.jevitate — an empty temp HOME here
  delete process.env.JOURNEEZE_UPLOAD_KEY;
  delete process.env.JOURNEEZE_URL;
});
afterAll(() => {
  for (const [k, v] of [["HOME", saved.HOME], ["JOURNEEZE_UPLOAD_KEY", saved.KEY], ["JOURNEEZE_URL", saved.URL]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.JOURNEEZE_UPLOAD_KEY;
  process.exitCode = undefined;
});

function cliDeps(): CliDeps {
  return {
    profiles: new ProfileManager(join(dir, "profiles")),
    dbPath: join(dir, "site.sqlite"),
    journeysDir: join(dir, "journeys"),
    catalogDir: join(dir, "catalog"),
    missionTargetsDir: join(dir, "targets"),
    inboxDir: join(dir, "inbox"),
  } as CliDeps;
}

const publishTool = () =>
  buildMcpTools({ journeysDir: join(dir, "journeys"), pathRoots: [dir], runCli: makeInProcessCliRunner(() => buildProgram(cliDeps())) }).find((t) => t.name === "publish_to_journeeze")!;

describe("MCP publish_to_journeeze", () => {
  it("without a resolvable key: refused, telling a person to run `jevitate connect journeeze`", async () => {
    const res = await publishTool().handler({ dryRun: true });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ error: "refused", message: expect.stringMatching(/jevitate connect journeeze/) });
  });

  it("with the key in the environment, nothing it returns contains the key", async () => {
    process.env.JOURNEEZE_UPLOAD_KEY = KEY;
    const res = await publishTool().handler({ dryRun: true });
    expect(JSON.stringify(res)).not.toContain(KEY.slice(4));
  });

  it("an extra key argument is rejected, never used", async () => {
    const res = await publishTool().handler({ dryRun: true, key: KEY });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ error: "invalid_args" });
  });
});

describe("CLI connect journeeze", () => {
  it("refuses without a terminal (the key is only ever typed by a person)", async () => {
    const out: string[] = [];
    const program = buildProgram(cliDeps());
    const tree = (c: Command): void => {
      c.exitOverride();
      c.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
      c.commands.forEach(tree);
    };
    tree(program);
    try {
      await program.parseAsync(["connect", "journeeze", "--url", "https://app.journeeze.dev", "--json"], { from: "user" });
    } catch (err) {
      if (!(err instanceof CommanderError)) throw err;
    }
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, error: { code: "E_CONNECT", message: expect.stringMatching(/terminal/) } });
  });
});
