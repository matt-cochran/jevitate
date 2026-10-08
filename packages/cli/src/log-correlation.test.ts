import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "@jevitate/explore";
import { openServerLogRuntime, parseLogScopeSpecs } from "./log-correlation.js";
import { parseLogDefectSpec, parseLogIgnoreSpec } from "./log-lines.js";
import type { LogSourceSpec } from "./log-sources.js";

/**
 * #169 item 3 — direct (non-served) coverage of `ServerLogRuntime`: `--log-ignore` excludes
 * known-noise lines from correlation and the defect oracle while still counting toward a source's
 * `linesRead` (it still proves the source was tailed), and a `server-log` defect's STORED `route`
 * is templated the same way the fingerprint already was internally.
 *
 * Uses a real `file:` source (tailed from its current end, #142) rather than a served browser
 * mission — cheaper than `server-log-e2e.test.ts` for logic that has nothing to do with the page.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const entry = (url: string): TranscriptEntry => ({
  step: 1,
  op: "click",
  target: 'button "Go"',
  confidence: null,
  chosenBy: "strategy",
  actOk: true,
  url,
  signature: "s1",
  controlCount: 1,
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function openTailedFile(): Promise<{ file: string; spec: LogSourceSpec }> {
  dir = await mkdtemp(join(tmpdir(), "jevitate-log-correlation-"));
  const file = join(dir, "app.log");
  await writeFile(file, ""); // exists before the source opens, so `opened: true` is immediate
  return { file, spec: { kind: "file", path: file, raw: `file:${file}` } };
}

describe("--log-ignore (#169 item 3)", () => {
  it(
    "excludes a matched line from the defect oracle and byLevel/topMessages, but still counts it in linesRead",
    async () => {
      const { file, spec } = await openTailedFile();
      const rt = openServerLogRuntime({
        sources: [spec],
        logDefect: [parseLogDefectSpec("error")],
        logIgnore: [parseLogIgnoreSpec("noisy")],
        secrets: [],
        drainMs: 700,
      });
      expect(rt).toBeDefined();
      await sleep(300); // let the poller confirm the file is open before writing

      const e = entry("http://x.test/api/orgs/123?token=secret");
      rt?.onTranscriptEntry(e, [e]);
      await appendFile(file, "ERROR duplicate key value violates unique constraint\n");
      await appendFile(file, "ERROR noisy background retry tick\n"); // matches --log-ignore
      await appendFile(file, "ERROR duplicate key value violates unique constraint\n");

      const result = await rt!.finish([e]);

      expect(result.summary.sources[0]?.linesRead).toBe(3); // every physical line still counted
      expect(result.summary.ignoredLines).toBe(1);
      expect(result.summary.byLevel.error).toBe(2); // the ignored line is excluded here
      expect(result.summary.topMessages.some((m) => m.message.includes("noisy"))).toBe(false);
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]?.occurrences).toBe(2);
      expect(result.defects[0]?.message).not.toContain("noisy");
      // #421: the structured fields every consumer reads instead of parsing `reason`.
      expect(result.defects[0]).toMatchObject({ kind: "server-log", level: "error", source: spec.raw, firstSeenStep: 1, count: 2 });
    },
    15_000,
  );

  it(
    "also accepts a /regex/ form",
    async () => {
      const { file, spec } = await openTailedFile();
      const rt = openServerLogRuntime({
        sources: [spec],
        logDefect: [parseLogDefectSpec("error")],
        logIgnore: [parseLogIgnoreSpec("/retry tick$/")],
        secrets: [],
        drainMs: 700,
      });
      await sleep(300);

      const e = entry("http://x.test/jobs");
      rt?.onTranscriptEntry(e, [e]);
      await appendFile(file, "ERROR scheduler retry tick\n");
      await appendFile(file, "ERROR unrelated failure\n");

      const result = await rt!.finish([e]);
      expect(result.summary.ignoredLines).toBe(1);
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]?.message).toContain("unrelated failure");
    },
    15_000,
  );
});

describe("server-log defect route templating (#169 item 3)", () => {
  it("the STORED defect.route is templated (host/query dropped, numeric id segment -> :id), same as the fingerprint", async () => {
    const { file, spec } = await openTailedFile();
    const rt = openServerLogRuntime({
      sources: [spec],
      logDefect: [parseLogDefectSpec("error")],
      secrets: [],
      drainMs: 700,
    });
    await sleep(300);

    const e = entry("http://x.test/api/orgs/123?token=secret");
    rt?.onTranscriptEntry(e, [e]);
    await appendFile(file, "ERROR duplicate key value violates unique constraint\n");

    const result = await rt!.finish([e]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.route).toBe("/api/orgs/:id");
    expect(result.defects[0]?.title).toContain("/api/orgs/:id");
    expect(result.defects[0]?.title).not.toContain("token=secret");
    expect(result.defects[0]?.title).not.toContain("x.test");
  });
});

/**
 * #199 — a process-based source (`docker:`/`cmd:`) that jevitate stops itself when the mission ends
 * must not be recorded as a failed source: `close()` sends SIGTERM (via the process group), and many
 * real backends (docker's own `logs -f` CLI included) self-report a nonzero exit code like 143 for
 * that rather than dying to the raw signal. Before the fix, `openProcessSource`'s startup-health-
 * check exit handler (#169) could not tell that exit apart from a source that just died on its own,
 * so a clean mission-end stop discarded the whole `--log-defect` oracle. Uses a real `cmd:` child
 * (no docker needed) whose shell script traps SIGTERM and self-exits 143, mirroring `docker logs -f`.
 */
describe("process-based --log-source stopped at mission end (#199)", () => {
  it("a long-running cmd: source stopped when the mission ends is not a failure, and the --log-defect oracle still runs", async () => {
    const spec: LogSourceSpec = {
      kind: "cmd",
      command: 'trap "exit 143" TERM; i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 0.02; done',
      raw: "cmd:tick-loop",
    };
    const rt = openServerLogRuntime({
      sources: [spec],
      logDefect: [parseLogDefectSpec("error")], // declared, never matches — oracle health must not depend on that
      secrets: [],
      drainMs: 500,
    });
    expect(rt).toBeDefined();
    await sleep(300); // the target is demonstrably active: several lines land before the mission "ends"

    // Mirrors a real mission ending: jevitate stops its own source (finish() -> closeLogSources()).
    const result = await rt!.finish([]);

    expect(result.summary.sources[0]?.opened).toBe(true);
    expect(result.summary.sources[0]?.linesRead).toBeGreaterThan(0);
    expect(result.summary.sources[0]?.error).toBeUndefined();
    expect(result.summary.oracleOk).toBe(true);
    expect(result.summary.oracleReason).toBeUndefined();
  }, 10_000);

  it("a cmd: source that exits on its own before the mission ends is still recorded as a failure", async () => {
    const spec: LogSourceSpec = { kind: "cmd", command: 'echo "starting"; exit 7', raw: "cmd:dies-early" };
    const rt = openServerLogRuntime({
      sources: [spec],
      logDefect: [parseLogDefectSpec("error")],
      secrets: [],
      drainMs: 500,
    });
    expect(rt).toBeDefined();
    await sleep(300); // well past the process's own (near-immediate) self-exit, before finish() ever runs

    const result = await rt!.finish([]);

    expect(result.summary.sources[0]?.error).toMatch(/exited with code 7/);
    expect(result.summary.sources[0]?.error).toContain("the source may not be running");
    expect(result.summary.oracleOk).toBe(false);
    expect(result.summary.oracleReason).toContain("failed to open or read a line");
  }, 10_000);
});

describe("--log-scope (#282): only this run's lines are attributed when runs share a log", () => {
  it(
    "attributes lines matching the scope; the rest count as ignoredLines and never become defects; verify-fix keeps the scope",
    async () => {
      const { file, spec } = await openTailedFile();
      const rt = openServerLogRuntime({
        sources: [spec],
        logDefect: [parseLogDefectSpec("error")],
        logScope: parseLogScopeSpecs(["/tenant=(acme|acme-eu)\\b/"]),
        secrets: [],
        drainMs: 700,
      });
      await sleep(300);
      const e = entry("http://x.test/orders");
      rt?.onTranscriptEntry(e, [e]);
      await appendFile(file, "ERROR tenant=acme order total mismatch\n");
      await appendFile(file, "ERROR tenant=globex payment declined\n"); // a concurrent run's tenant
      await appendFile(file, "WARN tenant=globex slow\n");

      const result = await rt!.finish([e]);
      expect(result.summary.ignoredLines).toBe(2);
      expect(result.summary.correlation).toMatchObject({ outOfScopeLines: 2, foreignLines: 0, idMatchedLines: 0 });
      expect(result.summary.byLevel).toEqual({ error: 1 });
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]?.message).toContain("order total mismatch");
      expect(result.defects[0]?.serverLog.scope).toEqual(["/tenant=(acme|acme-eu)\\b/"]);
      expect(JSON.stringify(result.transcript)).not.toContain("globex");
    },
    15_000,
  );

  it("refuses a bad --log-scope naming the flag", () => {
    expect(() => parseLogScopeSpecs(["/(/"])).toThrow(/--log-scope: invalid regex/);
    expect(() => parseLogScopeSpecs([""])).toThrow(/--log-scope: empty pattern/);
  });
});
