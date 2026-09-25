import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { startServer } from "@jevitate/example-site";
import { buildProgram } from "./program.js";

/**
 * #142 — backend log correlation, served-fixture acceptance: `apps/example-site`'s
 * `/server-log-mission/*` routes append a WARN and an ERROR line to `$EXAMPLE_SITE_LOG` (the real
 * "Not Authorized for feature X" / "no resolvable active subscription tier" dogfooding cases). A
 * real-browser `jevitate explore --log-source file:<log> --log-defect error` run:
 *  - attaches each line to the step whose click produced it;
 *  - promotes only the ERROR line to a `server-log` defect (the WARN one does not meet the matcher);
 *  - redacts the fixture "secret" embedded in the error line, everywhere it is persisted.
 */

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});
afterEach(() => {
  delete process.env.EXAMPLE_SITE_LOG;
});

/** Plays a fixed sequence in decide()'s candidate-action format: `<op>:<index>`. */
class ScriptedJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly seq: ReadonlyArray<{ op: string; target?: string }>) {}
  async systemOne(): Promise<Record<string, Answer>> {
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)];
    this.#i += 1;
    if (cur === undefined) throw new Error("ScriptedJudge: empty script");
    const value = cur.target !== undefined ? `${cur.op}:${cur.target}` : cur.op;
    return { action: { kind: "choice", value, confidence: 0.9 } };
  }
}

const SECRET = "tok_live_FIXTURE_SECRET_42";

describe("jevitate explore --log-source (#142, served fixture)", () => {
  it(
    "attaches WARN/ERROR lines to the right step, --log-defect error yields one stable-fingerprint defect, and the fixture secret is redacted",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-server-log-out-"));
      const logFile = join(await mkdtemp(join(tmpdir(), "jevitate-server-log-file-")), "app.log");
      process.env.EXAMPLE_SITE_LOG = logFile;

      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "done" }]),
          gen: new FakeGenerationGateway({}),
        },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();

      await program.parseAsync(
        [
          "explore",
          "--url",
          `${site.url}/server-log-mission/page`,
          "--goal",
          "trigger the warn and error signals",
          "--success",
          "textIncludes:[data-testid=status]|error-done",
          "--allow",
          site.url,
          "--secret",
          SECRET,
          "--log-source",
          `file:${logFile}`,
          "--log-defect",
          "error",
          "--server-log-drain-ms",
          "1500",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );

      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data;
      // #142 follow-up: a found server-log defect counts as `defects-found` (exit 1) even though the
      // goal's own success assertion held — never silently "succeeded".
      expect(result.outcome).toBe("defects-found");
      expect(result.exitCode).toBe(1);
      expect(result.transcript.map((e: { op: string | null }) => e.op)).toEqual(["click", "click", "done"]);

      // Evidence: WARN attached to step 1 (the warn button), ERROR to step 2 (the error button).
      const [step1, step2] = result.transcript as Array<{ step: number; serverLogs?: Array<{ level: string; message: string; raw: string }> }>;
      expect(step1?.serverLogs?.map((l) => l.level)).toEqual(["warn"]);
      expect(step1?.serverLogs?.[0]?.message).toContain("Not Authorized for feature AllOrganizations_View");
      expect(step2?.serverLogs?.map((l) => l.level)).toEqual(["error"]);
      expect(step2?.serverLogs?.[0]?.message).toContain("GetActiveRatePlanForOffer failed");

      // The fixture secret never survives into persisted evidence.
      expect(step2?.serverLogs?.[0]?.message).not.toContain(SECRET);
      expect(step2?.serverLogs?.[0]?.raw).not.toContain(SECRET);

      // Result summary: both levels counted, only ERROR promoted to a defect.
      expect(result.serverLogs.byLevel.warn).toBe(1);
      expect(result.serverLogs.byLevel.error).toBe(1);
      expect(result.serverLogs.oracleOk).toBe(true);
      expect(result.serverLogDefects).toHaveLength(1);
      const defect = result.serverLogDefects[0];
      expect(defect.kind).toBe("server-log");
      expect(defect.level).toBe("error");
      expect(defect.message).not.toContain(SECRET);
      expect(defect.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(defect.occurrences).toBe(1);

      // The persisted transcript FILE (not just the returned object) carries the same evidence.
      const persistedTranscript: unknown = JSON.parse(await readFile(result.transcriptPath, "utf8"));
      expect(persistedTranscript).toEqual(result.transcript);

      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "?ok=1 analogue: a run whose log stays clean of the matcher reports no server-log defects",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-server-log-clean-out-"));
      const logFile = join(await mkdtemp(join(tmpdir(), "jevitate-server-log-clean-file-")), "app.log");
      process.env.EXAMPLE_SITE_LOG = logFile;

      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          // Only the WARN button — never the error one — so `--log-defect error` finds nothing.
          judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
          gen: new FakeGenerationGateway({}),
        },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();

      await program.parseAsync(
        [
          "explore",
          "--url",
          `${site.url}/server-log-mission/page`,
          "--goal",
          "trigger only the warn signal",
          "--success",
          "textIncludes:[data-testid=status]|warn-done",
          "--allow",
          site.url,
          "--log-source",
          `file:${logFile}`,
          "--log-defect",
          "error",
          "--server-log-drain-ms",
          "1500",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );

      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data;
      expect(result.serverLogDefects ?? []).toHaveLength(0);
      expect(result.serverLogs.byLevel.warn).toBe(1);
      expect(result.serverLogs.byLevel.error ?? 0).toBe(0);
      expect(result.serverLogs.oracleOk).toBe(true); // the source WAS readable — it just saw no error
      // #142 follow-up: a demonstrably-readable, silent oracle is genuine evidence — stays clean.
      expect(result.outcome).toBe("succeeded");
      expect(result.exitCode).toBe(0);

      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "a dead log source with --log-defect never lets an otherwise-clean run read as clean (#142 exit-code follow-up)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-server-log-dead-out-"));
      // Deliberately never written to: the file never appears during the run or its drain window.
      const logFile = join(await mkdtemp(join(tmpdir(), "jevitate-server-log-dead-file-")), "never-appears.log");

      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          // No click needed: the seed page already satisfies the success check.
          judge: new ScriptedJudge([{ op: "done" }]),
          gen: new FakeGenerationGateway({}),
        },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();

      await program.parseAsync(
        [
          "explore",
          "--url",
          `${site.url}/server-log-mission/page`,
          "--goal",
          "do nothing",
          "--success",
          "urlIncludes:/server-log-mission/page",
          "--allow",
          site.url,
          "--log-source",
          `file:${logFile}`,
          "--log-defect",
          "error",
          "--server-log-drain-ms",
          "300",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );

      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data;
      expect(result.serverLogDefects ?? []).toHaveLength(0);
      expect(result.serverLogs.oracleOk).toBe(false);
      expect(result.serverLogs.sources[0].linesRead).toBe(0);
      // A run this --log-defect oracle never demonstrably watched is inconclusive, not clean.
      expect(result.outcome).toBe("inconclusive");
      expect(result.exitCode).toBe(2);
      expect(result.reason).toMatch(/--log-defect oracle could not run/);

      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "a quiet-but-OPENED log source (file exists, zero lines) also makes an otherwise-clean run inconclusive, with its own distinct reason (#169)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-server-log-quiet-out-"));
      const logFile = join(await mkdtemp(join(tmpdir(), "jevitate-server-log-quiet-file-")), "app.log");
      // Exists BEFORE the source opens (unlike the dead-source case above): `openFileSource` confirms
      // `opened: true` immediately. Nothing in this mission ever appends to it.
      await writeFile(logFile, "");
      process.env.EXAMPLE_SITE_LOG = logFile;

      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          judge: new ScriptedJudge([{ op: "done" }]),
          gen: new FakeGenerationGateway({}),
        },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();

      await program.parseAsync(
        [
          "explore",
          "--url",
          `${site.url}/server-log-mission/page`,
          "--goal",
          "do nothing",
          "--success",
          "urlIncludes:/server-log-mission/page",
          "--allow",
          site.url,
          "--log-source",
          `file:${logFile}`,
          "--log-defect",
          "error",
          "--server-log-drain-ms",
          "300",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );

      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data;
      expect(result.serverLogs.sources[0].opened).toBe(true);
      expect(result.serverLogs.sources[0].linesRead).toBe(0);
      expect(result.serverLogDefects ?? []).toHaveLength(0);
      expect(result.serverLogs.oracleOk).toBe(false);
      expect(result.outcome).toBe("inconclusive");
      expect(result.exitCode).toBe(2);
      // Distinct from the "failed to open" wording above — this source WAS readable, it just never
      // produced a line, so the oracle's health is unknown rather than proven broken.
      expect(result.reason).toBe("log source produced no lines");

      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "--log-quiet-ok keeps a legitimately-quiet source's otherwise-clean run clean (#169)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-server-log-quietok-out-"));
      const logFile = join(await mkdtemp(join(tmpdir(), "jevitate-server-log-quietok-file-")), "app.log");
      await writeFile(logFile, "");
      process.env.EXAMPLE_SITE_LOG = logFile;

      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          judge: new ScriptedJudge([{ op: "done" }]),
          gen: new FakeGenerationGateway({}),
        },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();

      await program.parseAsync(
        [
          "explore",
          "--url",
          `${site.url}/server-log-mission/page`,
          "--goal",
          "do nothing",
          "--success",
          "urlIncludes:/server-log-mission/page",
          "--allow",
          site.url,
          "--log-source",
          `file:${logFile}`,
          "--log-defect",
          "error",
          "--log-quiet-ok",
          `file:${logFile}`,
          "--server-log-drain-ms",
          "300",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );

      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data;
      expect(result.serverLogs.sources[0].quietOk).toBe(true);
      expect(result.serverLogs.sources[0].linesRead).toBe(0);
      expect(result.serverLogs.oracleOk).toBe(true);
      expect(result.outcome).toBe("succeeded");
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBeUndefined();

      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );
});
