import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { RunEvidenceSchema } from "@jevitate/adjudicator";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { logsDirFor } from "./project-dir.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";

/** #812 / design §2.3: `journey verify` leaves `evidence.json` in its run's log folder, schema-valid and value-free. */

const ID = "save";
const SECRET = "MARKER_SECRET_hunter2-eyJhbGciOi";
type Run = NonNullable<JourneyVerifySeams["run"]>;
const passed = (async () => ({ outcome: "ok", output: {} })) as unknown as Run;

const journey: Journey = {
  metadata: { id: ID, name: "Save", promoted: false, params: ["token"], createdAtIso: "2026-11-05T00:00:00.000Z", mutationPairs: [{ check: "step:1", mustFailWhen: "skip:1" }] },
  recording: {
    version: "1",
    site: "http://127.0.0.1:9",
    pages: [{ url: "/", steps: [{ step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }, delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 } }] }],
  },
} as unknown as Journey;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-verify-evidence-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-11-05T12:00:00.000Z") }));
  __resetTerminalResultForTests();
  await new FsJourneyStore(dir).put(journey);
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

describe("journey verify writes evidence.json into its run's log folder", () => {
  it("writes a schema-valid record that holds no secret", async () => {
    const err: string[] = [];
    const program = new Command();
    program.configureOutput({ writeOut: () => undefined, writeErr: (s) => void err.push(s) });
    const deps = { profiles: new ProfileManager("/unused"), journeysDir: dir, dbPath: join(dir, "no-site-policy.sqlite") };
    registerJourneyVerify(program.command("journey"), program, deps, { run: passed, terminal: terminal() });
    await program.parseAsync(["journey", "verify", ID, "--mutate", "--param", `token=${SECRET}`], { from: "user" });

    const logs = logsDirFor();
    const folders = readdirSync(logs).filter((n) => n.startsWith(`journey-verify-${ID}-`) && statSync(join(logs, n)).isDirectory());
    expect(folders, err.join("")).toHaveLength(1);
    const file = join(logs, folders[0]!, "evidence.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
    const text = readFileSync(file, "utf8");
    const record = RunEvidenceSchema.parse(JSON.parse(text));
    expect(record.mutation?.replays.length).toBeGreaterThan(0);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/MARKER_|Bearer |eyJ|\?[a-z]+=/);
  });
});
