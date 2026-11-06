import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";

/**
 * A proof replays real writes against the real app, so one with no reset hook or fixture says so in
 * `--plan` and in its report, with how many of the planned replays can send them.
 */

const ID = "save";
type Run = NonNullable<JourneyVerifySeams["run"]>;
const passed = (async () => ({ outcome: "ok", output: {} })) as unknown as Run;

const WRITE = { delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 } };
const saveClick = { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }, ...WRITE };
const NAV = { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } };

const journeyOf = (steps: readonly unknown[], metadata: Record<string, unknown> = {}): Journey =>
  ({
    metadata: { id: ID, name: "Save", promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00.000Z", ...metadata },
    recording: { version: "1", site: "http://127.0.0.1:9", pages: [{ url: "/", steps }] },
  }) as unknown as Journey;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-no-reset-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-11-05T12:00:00.000Z") }));
  __resetTerminalResultForTests();
});

afterEach(async () => {
  resetClock();
  __resetTerminalResultForTests();
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

const terminal = (): TerminalResultDeps => ({
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
});

async function verify(args: readonly string[]): Promise<string> {
  const out: string[] = [];
  const program = new Command();
  program.configureOutput({ writeOut: (s) => void out.push(s), writeErr: () => undefined });
  const deps = { profiles: new ProfileManager("/unused"), journeysDir: dir, dbPath: join(dir, "no-site-policy.sqlite") };
  registerJourneyVerify(program.command("journey"), program, deps, { run: passed, terminal: terminal() });
  await program.parseAsync(["journey", "verify", ID, ...args], { from: "user" });
  return out.join("");
}

describe("a proof with no reset hook or fixture", () => {
  beforeEach(async () => {
    await new FsJourneyStore(dir).put(journeyOf([NAV, saveClick]));
  });

  // The base, the independence and closing replays send the write. `skip:2` and `block-write:2` are the only write's own mutations.
  const LINE = "no reset hook or fixture: nothing undoes what a replay writes, and 3 of the 5 planned replays can send real writes (relaxed replays, controls and re-runs can add more)\n";

  it("--plan says so", async () => {
    expect(await verify(["--plan"])).toContain(LINE);
  });

  it("--plan --json says so", async () => {
    const body = JSON.parse(await verify(["--plan", "--json"])) as { data: { noReset?: string; summary: { minimumReplays: number; writeReplays: number } } };
    expect(body.data.noReset).toBe(LINE.trim());
    expect(body.data.summary).toMatchObject({ minimumReplays: 5, writeReplays: 3 });
  });

  it("the report says so", async () => {
    expect(await verify(["--mutate"])).toContain(LINE);
  });

  it("the JSON report says so", async () => {
    const body = JSON.parse(await verify(["--mutate", "--json"])) as { data: { noReset?: string } };
    expect(body.data.noReset).toBe(LINE.trim());
  });

  it.each([
    ["--before", ["--before", "true", "--allow-shell-hooks"]],
    ["--after", ["--after", "true", "--allow-shell-hooks"]],
  ])("neither says so with %s", async (_name, flags) => {
    expect(await verify(["--plan", ...flags])).not.toContain("no reset");
    expect(await verify(["--mutate", ...flags])).not.toContain("no reset");
  });
});

describe("what the line counts", () => {
  it("is silent for a Journey that records its fixtures, and --plan does not read the file", async () => {
    await new FsJourneyStore(dir).put(journeyOf([NAV, saveClick], { fixtures: { file: "not-there.json", specHash: "x" } }));
    expect(await verify(["--plan"])).not.toContain("no reset");
  });

  it("says no replay writes for a Journey with no write", async () => {
    const fill = { step: { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: { kind: "valueEquals", target: { label: "Text" }, value: "hello" } } };
    await new FsJourneyStore(dir).put(journeyOf([NAV, fill]));
    expect(await verify(["--plan"])).toMatch(/no reset hook or fixture: nothing undoes what a replay writes, and 0 of the \d+ planned replays can send real writes\n/);
  });

  it("counts a skip of one write while another write stays in the replay", async () => {
    const other = { step: { kind: "click", target: { role: "button", name: "Publish" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Published" } }, delta: { ...WRITE.delta, requests: ["POST /api/publish → 200"] } };
    await new FsJourneyStore(dir).put(journeyOf([NAV, saveClick, other]));
    const body = JSON.parse(await verify(["--plan", "--json"])) as { data: { summary: { minimumReplays: number; writeReplays: number } } };
    expect(body.data.summary.writeReplays).toBe(body.data.summary.minimumReplays);
  });
});
