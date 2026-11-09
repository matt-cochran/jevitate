import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import type { CliDeps } from "./cli-shared.js";
import { CLI_TOOL_SPECS } from "./mcp-cli-tools.js";

/**
 * #827: `journey readiness --mode replay|prove` takes a secret parameter from the environment, as `journey
 * verify` does: `--secret-field` on the CLI, and the target's targets.json `secretFields` for its
 * `--env`/`--base-url` (the only route over MCP). The value never appears in the receipt.
 */

const SITE = "https://app.example";
const SECRET = "tok-value-827";
let root: string;
let journeysDir: string;
let targetsFile: string;

const invite: Journey = {
  metadata: { id: "invite", name: "Accept invite", promoted: false, params: ["inviteToken"], parameters: [{ name: "inviteToken", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z" },
  recording: { version: "1", site: SITE, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/invite/${inviteToken}", expect: { kind: "visible", target: { role: "heading", name: "Welcome" } } } }] }] },
} as unknown as Journey;

beforeEach(async () => {
  installClock(new FakeClock({ startMs: Date.UTC(2026, 10, 9) }));
  root = await mkdtemp(join(tmpdir(), "jev-827-readiness-"));
  journeysDir = join(root, ".jevitate", "journeys");
  targetsFile = join(root, "targets.json");
  await mkdir(journeysDir, { recursive: true });
  await writeFile(targetsFile, JSON.stringify({}));
  await new FsJourneyStore(journeysDir).put(invite);
});

afterEach(async () => {
  resetClock();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

async function readiness(extra: readonly string[]): Promise<{ out: string; json: any }> {
  const lines: string[] = [];
  const deps: CliDeps = {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    catalogDir: join(root, ".jevitate"),
    // No browser opens in this test: the replay's browser refuses at once (the receipt is then inconclusive).
    explore: { targetsConfigPath: targetsFile, env: { TOK: SECRET }, localConfig: {}, browserPortFactory: () => { throw new Error("no browser in this test"); } },
  } as unknown as CliDeps;
  const program = buildProgram(deps);
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["journey", "readiness", "invite", "--mode", "replay", "--base-url", SITE, ...extra, "--json"], { from: "user" });
  const out = lines.join("");
  return { out, json: JSON.parse(out.slice(out.indexOf("{"))) };
}

describe("#827 journey readiness secret route", () => {
  it("without one, the secret parameter is refused by name before any browser", async () => {
    const { json } = await readiness([]);
    expect(json.error).toMatchObject({ code: "E_READINESS_PARAMS" });
    expect(json.error.message).toContain("inviteToken");
  });

  it("--secret-field binds it from the environment, and targets.json for the --base-url does too; the value is never shown", async () => {
    const flagged = await readiness(["--secret-field", "param=inviteToken=env:TOK"]);
    expect(flagged.json.ok).toBe(true);
    expect(flagged.out).not.toContain(SECRET);
    await writeFile(targetsFile, JSON.stringify({ [SITE]: { secretFields: ["param=inviteToken=env:TOK"] } }));
    const targeted = await readiness([]);
    expect(targeted.json.ok).toBe(true);
    expect(targeted.out).not.toContain(SECRET);
  });

  it("a malformed binding is refused as a usage error, and MCP never takes the flag from a request", async () => {
    expect((await readiness(["--secret-field", "nonsense"])).json.error).toMatchObject({ code: "E_READINESS_ARGS" });
    const tool = CLI_TOOL_SPECS.find((t) => t.name === "journey_readiness")!;
    expect(Object.keys((tool.command as { omitted: Record<string, string> }).omitted)).toContain("--secret-field");
  });
});
