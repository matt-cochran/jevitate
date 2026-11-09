import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidenceSchema } from "@jevitate/adjudicator";
import { ProfileManager } from "@jevitate/daemon";
import type { Journey } from "@jevitate/journey";
import { FsJourneyCallQueueStore } from "@jevitate/missions";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * 0.30.0 #797 served acceptance (d-queue-journeys-b): `jevitate journey queue <id>` writes a queued
 * Journey call, and `jevitate mission run` drains it against a real served app (a real Chromium) through
 * the same gate as run_journey; the run's evidence.json says channel `queue`. A secret-named param is
 * refused by name before anything is written: E_SECRET_PARAM_IN_QUEUE, exit 64.
 */

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let queueDir: string;
let targetsDir: string;
let logs: string;
let targetsFile: string;
let environmentsFile: string;

const notesJourney = (): Journey =>
  ({
    metadata: { id: "notes", name: "notes", promoted: false, params: [], parameters: [{ name: "note", description: "a note" }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "fill", target: { testId: "note" }, value: { var: "note" }, expect: { kind: "visible", target: { testId: "note" } } } },
          ],
        },
      ],
    },
  }) as unknown as Journey;

/** Promoted with a current approval a person made at a terminal. */
const approved = (j: Journey): Journey =>
  ({
    ...j,
    metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } },
  }) as Journey;

function cliProgram(lines: string[], catalogDir?: string) {
  const program = buildProgram({
    ...(catalogDir === undefined ? {} : { catalogDir }),
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    environmentsFile,
    missions: { queueDir },
    logs: { autoPrune: false, logsRoot: logs },
    // A real Chromium (the browser project's pooled one).
    explore: { targetsConfigPath: targetsFile, browserPortFactory: () => new PlaywrightBrowserPort() },
  } as Parameters<typeof buildProgram>[0]);
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  program.exitOverride();
  return program;
}

async function cli(args: string[], catalogDir?: string): Promise<{ body: Record<string, unknown>; exitCode: number }> {
  const lines: string[] = [];
  process.exitCode = 0;
  await cliProgram(lines, catalogDir).parseAsync(args, { from: "user" });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { body: JSON.parse(lines.join("")) as Record<string, unknown>, exitCode };
}

const queueEntries = (): string[] => (existsSync(queueDir) ? readdirSync(queueDir, { recursive: true }).map(String).sort() : []);

function evidenceFiles(): string[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((date) =>
    readdirSync(join(logs, date))
      .filter((f) => f.startsWith("journey-evidence-") && statSync(join(logs, date, f)).isDirectory())
      .map((f) => join(logs, date, f, EVIDENCE_FILE))
      .filter((f) => existsSync(f)),
  );
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><main><h1>Notes</h1><input data-testid=note aria-label=Note></main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-797-served-"));
  journeysDir = join(root, "journeys");
  queueDir = join(root, "queue");
  targetsDir = join(root, "targets");
  logs = join(root, "logs");
  mkdirSync(journeysDir, { recursive: true });
  // The operator declares the served app a test target (trust from human-written files only).
  targetsFile = join(root, "targets.json");
  writeFileSync(targetsFile, JSON.stringify({ [origin]: { trust: "test" } }));
  // No environments file: the trust comes from targets.json alone.
  environmentsFile = join(root, "environments.json");
  writeFileSync(join(journeysDir, "notes.json"), JSON.stringify(approved(notesJourney())));
});

beforeEach(() => {
  // The run record (and so evidence.json) is on, as in a real run; the suite turns it off by default.
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("#797 a queued Journey call, end to end on a served app", () => {
  it("`journey queue login --param password=x` exits 64 with E_SECRET_PARAM_IN_QUEUE and the queue directory is unchanged", async () => {
    const before = queueEntries();
    const r = await cli(["journey", "queue", "login", "--param", "password=x", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.body).toMatchObject({ ok: false, error: { code: "E_SECRET_PARAM_IN_QUEUE" } });
    expect(JSON.stringify(r.body)).toContain("password");
    expect(JSON.stringify(r.body)).not.toMatch(/password=x|"x"/);
    expect(queueEntries()).toEqual(before);
  });

  it("refuses a param the Journey declares secret, by name, with nothing written", async () => {
    const secretNote = approved({ ...notesJourney(), metadata: { ...notesJourney().metadata, id: "secret-note", name: "secret-note", parameters: [{ name: "note", description: "a note", secret: true }] } } as Journey);
    writeFileSync(join(journeysDir, "secret-note.json"), JSON.stringify(secretNote));
    const before = queueEntries();
    const r = await cli(["journey", "queue", "secret-note", "--param", "note=hello", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.body).toMatchObject({ ok: false, error: { code: "E_SECRET_PARAM_IN_QUEUE" } });
    expect(queueEntries()).toEqual(before);
  });

  it("a queued promoted Journey runs `ok` when `mission run` drains it, and its evidence.json has run.channel 'queue'", async () => {
    const queued = await cli(["journey", "queue", "notes", "--param", "note=hello", "--json"]);
    expect(queued.exitCode).toBe(0);
    const data = queued.body.data as { callId: string; status: string; journey: { id: string; hash: string } };
    expect(data).toMatchObject({ status: "queued", journey: { id: "notes", hash: journeyReviewHash(notesJourney()) } });
    const stored = await new FsJourneyCallQueueStore(queueDir).get(data.callId);
    expect(stored?.call).toEqual({ kind: "journey", journey: data.journey, params: { note: "hello" }, requestedAt: stored?.enqueuedAtIso });

    const drained = await cli(["mission", "run", "--targets-dir", targetsDir, "--json"]);
    // GAPS 21 (#800, owner decision 3): the Journey links no job, so its done check reads unverified/no-check,
    // and an unverified pass exits 2 under the default doneCheckPolicy `require`, as `journey run` does.
    // GAPS 23: `mission run` counts its drained Journey calls' exit codes (worst wins).
    expect(drained.exitCode).toBe(2);
    expect((drained.body.data as { journeys?: unknown[] }).journeys).toEqual([{ callId: data.callId, journey: "notes", status: "done", outcome: "ok", exitCode: 2, runId: expect.any(String), job: { attainment: "unverified", basis: "no-check" } }]);
    expect(await new FsJourneyCallQueueStore(queueDir).get(data.callId)).toMatchObject({ status: "done", outcome: "ok", exitCode: 2, job: { attainment: "unverified", basis: "no-check" } });

    const files = evidenceFiles();
    expect(files).toHaveLength(1);
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(files[0]!, "utf8")));
    expect(evidence.run.channel).toBe("queue");
    // The evidence names the Journey by its content hash (journeyContentHash); the call binds to its review hash.
    expect(evidence.subject.journey?.id).toBe("notes");
    expect(evidence.steps.every((s) => s.outcome === "ok")).toBe(true);
    // GAPS 19: `mission result <callId>` (MCP get_mission_result) returns the stored record: outcome, exit
    // code and the run's id, which names its evidence directory.
    const result = await cli(["mission", "result", data.callId, "--json"]);
    expect(result.exitCode).toBe(2);
    const runDir = files[0]!.split("/").at(-2)!;
    expect(result.body.data).toMatchObject({ id: data.callId, callId: data.callId, kind: "journey", journey: data.journey, outcome: "ok", exitCode: 2, job: { attainment: "unverified", basis: "no-check" }, runId: runDir.replace(/^journey-evidence-/, "") });
    // A drained call is never run twice.
    const again = await cli(["mission", "run", "--targets-dir", targetsDir, "--json"]);
    expect((again.body.data as { journeys?: unknown[] }).journeys).toBeUndefined();
  });

  it("a call whose Journey changed since it was queued is recorded failed E_JOURNEY_APPROVAL_STALE, and nothing ran", async () => {
    const queued = await cli(["journey", "queue", "notes", "--param", "note=again", "--json"]);
    const { callId } = queued.body.data as { callId: string };
    // The Journey changes (and is re-approved) after the call was queued.
    const changed = approved({ ...notesJourney(), metadata: { ...notesJourney().metadata, description: "changed" } } as Journey);
    writeFileSync(join(journeysDir, "notes.json"), JSON.stringify(changed));
    const evidenceBefore = evidenceFiles().length;
    try {
      const drained = await cli(["mission", "run", "--targets-dir", targetsDir, "--json"]);
      expect(drained.exitCode).toBe(2);
      expect((drained.body.data as { journeys?: unknown[] }).journeys).toEqual([expect.objectContaining({ callId, status: "failed", code: "E_JOURNEY_APPROVAL_STALE" })]);
      // GAPS 19: the refusal code is what `mission result` reports, exiting 2 (it proves nothing).
      const result = await cli(["mission", "result", callId, "--json"]);
      expect(result.exitCode).toBe(2);
      expect(result.body.data).toMatchObject({ callId, kind: "journey", status: "failed", code: "E_JOURNEY_APPROVAL_STALE", isError: true });
      // The refusal happened before any browser: the run record may say so, but no step ran.
      for (const f of evidenceFiles().slice(evidenceBefore)) {
        expect(RunEvidenceSchema.parse(JSON.parse(readFileSync(f, "utf8"))).steps.filter((s) => s.outcome === "ok")).toEqual([]);
      }
    } finally {
      writeFileSync(join(journeysDir, "notes.json"), JSON.stringify(approved(notesJourney())));
    }
  });

  it("GAPS 23: the drain reads the job done check from a non-default project (advisory there: exit 0)", async () => {
    const project = join(root, "elsewhere", ".jevitate");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "project.json"), JSON.stringify({ doneCheckPolicy: "advisory" }));
    const queued = await cli(["journey", "queue", "notes", "--param", "note=elsewhere", "--json"], project);
    const { callId } = queued.body.data as { callId: string };
    const drained = await cli(["mission", "run", "--targets-dir", targetsDir, "--json"], project);
    expect((drained.body.data as { journeys?: unknown[] }).journeys).toEqual([expect.objectContaining({ callId, status: "done", outcome: "ok", exitCode: 0, job: { attainment: "unverified", basis: "no-check" } })]);
    expect(drained.exitCode).toBe(0);
  });
});
