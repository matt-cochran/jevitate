import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { verifyRecordPath } from "./journey-review-store.js";
import { secretForms } from "@jevitate/ai-core";
import { NATIVE_REPORT_RETENTION, carriesSecretValue, writeVerifyNativeReport } from "./journey-verify-evidence-file.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";

/**
 * #818: the proof's full redacted report is persisted atomically, beside its canonical receipt and
 * bound to it by hash, BEFORE stdout is written, so a transport that dies after the proof (SSH exit 255,
 * EPIPE) loses nothing that cost replays. A secret parameter never reaches the file.
 */

const ID = "save";
const SECRET = "hunter2-planted-secret";
type Run = NonNullable<JourneyVerifySeams["run"]>;
// The base fails quoting the page, which shows the secret: the reason must be redacted everywhere it lands.
const quotesSecret = (async () => ({ outcome: "quarantined", reason: `step 2: expected "Saved", page showed "token ${SECRET}"`, output: {} })) as unknown as Run;

const WRITE = { delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 } };
const steps = [
  { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
  { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "count", target: { css: "body" }, min: 0 } } },
  { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }, ...WRITE },
];
const journey = {
  metadata: { id: ID, name: "Save", promoted: false, params: ["password"], createdAtIso: "2026-11-05T00:00:00.000Z" },
  recording: { version: "1", site: "http://127.0.0.1:9", pages: [{ url: "/", steps }] },
} as unknown as Journey;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-native-report-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-11-09T12:00:00.000Z") }));
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

async function verify(writeOut: (s: string) => void, stderr: string[] = [], run: Run = quotesSecret): Promise<void> {
  const program = new Command();
  program.configureOutput({ writeOut, writeErr: (s) => void stderr.push(s) });
  const deps = { profiles: new ProfileManager("/unused"), journeysDir: dir, dbPath: join(dir, "no-site-policy.sqlite") };
  registerJourneyVerify(program.command("journey"), program, deps, { run, terminal: terminal() });
  await program.parseAsync(["journey", "verify", ID, "--mutate", "--param", `password=${SECRET}`, "--json"], { from: "user" });
}

interface Receipt { verdict: string; nativeReport?: { path: string; sha256: string }; nativeReportError?: string }
const receipt = (): Receipt => JSON.parse(readFileSync(verifyRecordPath(dir, ID), "utf8")) as Receipt;

describe("#818 the native report is persisted before stdout", () => {
  it("survives a stdout that dies (EPIPE): the receipt names it by path and hash, and it is the exact report", async () => {
    let attempted = "";
    await verify((s) => {
      attempted += s;
      // By the time anything reaches stdout, the report is already on disk and bound to the receipt.
      const r = receipt();
      expect(r.nativeReport).toBeDefined();
      expect(existsSync(resolve(dirname(verifyRecordPath(dir, ID)), r.nativeReport!.path))).toBe(true);
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    }).catch(() => undefined);
    expect(attempted).not.toBe("");
    const r = receipt();
    const file = resolve(dirname(verifyRecordPath(dir, ID)), r.nativeReport!.path);
    const bytes = readFileSync(file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.nativeReport!.sha256);
    const persisted = JSON.parse(bytes.toString("utf8")) as {
      kind: string;
      engine: { version: string };
      journeyId: string;
      journeyHash: string;
      proofHash: string;
      report: { verdict: string; journeyHash: string; base: { outcome: string; reason?: string }; mutations: unknown[]; assertions: unknown[] };
    };
    expect(persisted).toMatchObject({ kind: "journey-verify-native-report", journeyId: ID });
    expect(typeof persisted.engine.version).toBe("string");
    expect(persisted.report.verdict).toBe(r.verdict);
    expect(persisted.journeyHash).toBe(persisted.report.journeyHash);
    expect(persisted.proofHash).toMatch(/^[0-9a-f]{64}$/);
    // The expensive evidence is all there: the base, every mutation and every assertion, as stdout would have had them.
    const stdout = JSON.parse(attempted) as { data: Record<string, unknown> & { nativeReport: { path: string; sha256: string } } };
    // The CLI adds its own stamp and notes around the report; the report itself is what was persisted.
    const { nativeReport, engine: _engine, noReset: _noReset, fixtureDrift: _drift, ...emitted } = stdout.data;
    expect(nativeReport).toEqual({ path: file, sha256: r.nativeReport!.sha256 });
    expect(persisted.report).toEqual(emitted);
    // Private: the file is 0600 in a 0700 directory.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("#816: the receipt names the engine that recorded the proof (version and commit, no build time)", async () => {
    await verify(() => undefined).catch(() => undefined);
    const engine = (receipt() as Receipt & { engine?: Record<string, unknown> }).engine;
    expect(Object.keys(engine ?? {}).sort()).toEqual(["commit", "version"]);
    expect(typeof engine?.version).toBe("string");
    expect(typeof engine?.commit).toBe("string");
  });

  it("is redacted: a planted secret parameter appears in neither the file nor the receipt nor stdout", async () => {
    let out = "";
    await verify((s) => void (out += s));
    const r = receipt();
    const file = resolve(dirname(verifyRecordPath(dir, ID)), r.nativeReport!.path);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("page showed"); // the diagnostic itself is kept
    expect(text).not.toContain(SECRET);
    expect(readFileSync(verifyRecordPath(dir, ID), "utf8")).not.toContain(SECRET);
    expect(out).not.toContain(SECRET);
  });

  it("a failed persistence never claims retrievable evidence: no path in the receipt, the reason instead, and a warning", async () => {
    // The reports directory cannot be created: a plain file stands where it goes.
    const reports = join(dirname(verifyRecordPath(dir, ID)), "reports");
    mkdirSync(dirname(reports), { recursive: true });
    writeFileSync(reports, "not a directory");
    const stderr: string[] = [];
    let out = "";
    await verify((s) => void (out += s), stderr);
    const r = receipt();
    expect(r.nativeReport).toBeUndefined();
    expect(r.nativeReportError).toMatch(/native report could not be written/);
    expect((JSON.parse(out) as { data: { nativeReport?: unknown; nativeReportError?: string } }).data).toMatchObject({ nativeReportError: r.nativeReportError });
    expect(stderr.join("")).toMatch(/native report could not be written/);
  });
});

describe("#818 writeVerifyNativeReport", () => {
  const envelope = (n: number) => ({ kind: "journey-verify-native-report", n });

  it("never overwrites a different run's report at the same path, and keeps a bounded number per Journey", () => {
    const reports = join(dir, "r");
    const first = writeVerifyNativeReport(reports, "2026-11-09T12-00-00-000Z", envelope(0));
    expect("path" in first).toBe(true);
    // The same bytes again are the same report: idempotent, same path.
    expect(writeVerifyNativeReport(reports, "2026-11-09T12-00-00-000Z", envelope(0))).toEqual(first);
    for (let i = 1; i <= NATIVE_REPORT_RETENTION + 3; i++) writeVerifyNativeReport(reports, `2026-11-09T12-00-${String(i).padStart(2, "0")}-000Z`, envelope(i));
    const kept = readdirSync(reports).filter((f) => f.endsWith(".json"));
    expect(kept).toHaveLength(NATIVE_REPORT_RETENTION);
    // The newest are kept, the oldest pruned; no temporary file is left behind.
    expect(kept.some((f) => f.startsWith("2026-11-09T12-00-00-000Z"))).toBe(false);
    expect(readdirSync(reports).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("returns why it could not write, and never throws", () => {
    const blocked = join(dir, "blocked");
    mkdirSync(blocked, { mode: 0o500 });
    chmodSync(blocked, 0o500);
    const r = writeVerifyNativeReport(join(blocked, "inner"), "2026-11-09T12-00-00-000Z", envelope(0));
    chmodSync(blocked, 0o700);
    expect(r).toEqual({ error: expect.stringMatching(/native report could not be written/) as unknown as string });
  });
});

describe("independent check M6: the native report is redacted for every secret the run knows, in every encoding", () => {
  // A fixture's or an extracted credential, never a parameter: the replay reports it as one of its secrets.
  const RUN_SECRET = "MARKER_FX*tok (x)!";
  const forms = (v: string): string[] => [...secretForms(v), ...secretForms(v).map((f) => JSON.stringify(f).slice(1, -1))];
  const quotesEverything = (async (_opts: unknown, mutation?: { onRunSecrets?: (s: readonly string[]) => void }) => {
    mutation?.onRunSecrets?.([RUN_SECRET]);
    const lowerStrict = encodeURIComponent(SECRET).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    return { outcome: "quarantined", reason: `step 2: page showed ${RUN_SECRET}, went to /m?t=${encodeURIComponent(RUN_SECRET).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)} and /p?pw=${lowerStrict}`, output: {} };
  }) as unknown as Run;

  it("a fixture or extracted secret, and a parameter's lowercase-hex URL form, reach neither the file, the receipt nor stdout", async () => {
    let out = "";
    await verify((s) => void (out += s), [], quotesEverything);
    const r = receipt();
    expect(r.nativeReport).toBeDefined();
    const text = readFileSync(resolve(dirname(verifyRecordPath(dir, ID)), r.nativeReport!.path), "utf8");
    expect(text).toContain("page showed");
    for (const f of [...forms(RUN_SECRET), ...forms(SECRET)]) {
      expect(text).not.toContain(f);
      expect(readFileSync(verifyRecordPath(dir, ID), "utf8")).not.toContain(f);
      expect(out).not.toContain(f);
    }
  });

  it("the withhold guard finds a secret in any URL or JSON form", () => {
    const strict = encodeURIComponent(RUN_SECRET).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    for (const text of [RUN_SECRET, strict, strict.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), new URLSearchParams([["", RUN_SECRET]]).toString().slice(1), JSON.stringify({ v: 'a"b\\c' })]) {
      expect(carriesSecretValue(`{"r":"${text}"}`, [RUN_SECRET, 'a"b\\c']), text).toBe(true);
    }
    expect(carriesSecretValue('{"outcome":"ok","n":1}', ["MARKER_absent"])).toBe(false);
  });
});

describe("independent check (low): a symlinked reports directory is never written through", () => {
  it("refuses a .verify/reports that is a symbolic link, and writes nothing where it points", async () => {
    const verifyDir = dirname(verifyRecordPath(dir, ID));
    mkdirSync(verifyDir, { recursive: true });
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(verifyDir, "reports"));
    await verify(() => undefined);
    const r = receipt();
    expect(r.nativeReport).toBeUndefined();
    expect(r.nativeReportError).toMatch(/native report could not be written/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("writeVerifyNativeReport refuses any symlinked component under its root", () => {
    const rootDir = join(dir, "root");
    mkdirSync(rootDir);
    const elsewhere = join(dir, "elsewhere2");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(rootDir, "reports"));
    const res = writeVerifyNativeReport(join(rootDir, "reports", ID), "2026-11-09T12-00-00-000Z", { n: 0 }, rootDir);
    expect(res).toEqual({ error: expect.stringMatching(/native report could not be written/) as unknown as string });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
