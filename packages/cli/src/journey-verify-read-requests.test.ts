import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";

/**
 * #763 — `journey verify` honours the target's `safety.readRequests`, as `journey lint` and `journey
 * review` do: a POST the target declares read-only is no write, so the proof neither skips nor blocks it.
 */

const ORIGIN = "https://example.test";
const READ_ONLY_POST = "/api/v1/tool/crm-companies/query";
const ID = "companies";

const journey: Journey = {
  metadata: { id: ID, name: "Open companies", promoted: false, params: [], createdAtIso: "2026-11-04T00:00:00Z" },
  recording: {
    version: "1.0.0",
    site: ORIGIN,
    pages: [
      {
        url: "/companies",
        steps: [
          {
            step: { kind: "click", target: { testId: "companies" }, expect: { kind: "textIncludes", target: { role: "heading" }, text: "Companies" } },
            delta: { verdict: "relevant-change", why: "query rendered companies", changes: ["Companies heading"], requests: [`POST ${READ_ONLY_POST} → 200`], overheadMs: 1 },
          },
        ],
      },
    ],
  },
};

let root: string;
let journeysDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-763-verify-"));
  journeysDir = join(root, "journeys");
  await new FsJourneyStore(journeysDir).put(journey);
  installClock(new FakeClock({ startMs: Date.parse("2026-11-04T12:00:00.000Z") }));
  __resetTerminalResultForTests();
});

afterEach(async () => {
  resetClock();
  __resetTerminalResultForTests();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

async function targetsFile(content: string): Promise<string> {
  const file = join(root, "targets.json");
  await writeFile(file, content);
  return file;
}

const READS = JSON.stringify({ [ORIGIN]: { safety: { readRequests: [READ_ONLY_POST] } } });

async function plan(targets: string): Promise<{ ok: boolean; data?: { mutations: { id: string }[] }; error?: { code: string } }> {
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir, explore: { targetsConfigPath: targets } });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  await program.parseAsync(["journey", "verify", ID, "--plan", "--dir", journeysDir, "--json"], { from: "user" });
  return JSON.parse(lines.join("")) as never;
}

test("--plan plans no write mutation for a POST the target declares a read", async () => {
  const report = await plan(await targetsFile(READS));
  // No block-write: only the click's own checked UI effect keeps its skip (#811).
  expect(report.data?.mutations.map((m) => m.id)).toEqual(["skip:1"]);
});

test("--plan still plans them with no such target", async () => {
  const report = await plan(await targetsFile(JSON.stringify({ "https://other.test": { safety: { readRequests: [READ_ONLY_POST] } } })));
  expect(report.data?.mutations.map((m) => m.id)).toEqual(["skip:1", "block-write:1"]);
});

test("--plan refuses an invalid targets file as lint and review do", async () => {
  const report = await plan(await targetsFile("{ not json"));
  expect(report).toMatchObject({ ok: false, error: { code: "E_TARGET_CONFIG" } });
});

type Run = NonNullable<JourneyVerifySeams["run"]>;

async function mutate(targets: string): Promise<{ ok: boolean; data?: { mutations: { id: string }[] }; error?: { code: string } }> {
  const lines: string[] = [];
  const terminal: TerminalResultDeps = {
    exit: () => undefined,
    terminateBrowsers: () => undefined,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    writeResult: (path) => path,
    engine: () => ({ version: "0.0.0-test" }) as ReturnType<TerminalResultDeps["engine"]>,
    onFatalError: () => () => undefined,
    onProcessExit: () => () => undefined,
    installKillSwitch: () => undefined,
    sharedProcess: () => false,
  };
  const program = new Command();
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  const deps = { profiles: new ProfileManager("/unused"), journeysDir, dbPath: join(root, "no-site-policy.sqlite"), explore: { targetsConfigPath: targets } };
  const run = (async () => ({ outcome: "ok", output: {} })) as unknown as Run;
  registerJourneyVerify(program.command("journey"), program, deps as never, { run, terminal });
  await program.parseAsync(["journey", "verify", ID, "--mutate", "--json", "--dir", journeysDir], { from: "user" });
  return JSON.parse(lines.join("")) as never;
}

test("--mutate runs no write mutation for a POST the target declares a read", async () => {
  const report = await mutate(await targetsFile(READS));
  // No block-write: only the click's own checked UI effect keeps its skip (#811).
  expect(report.data?.mutations.map((m) => m.id)).toEqual(["skip:1"]);
});

test("--mutate refuses an invalid targets file before any replay", async () => {
  const report = await mutate(await targetsFile("{ not json"));
  expect(report).toMatchObject({ ok: false, error: { code: "E_TARGET_CONFIG" } });
});
