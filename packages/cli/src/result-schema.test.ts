import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import {
  CLI_ADVERSARIAL_STRATEGIES,
  parseSuccessSpec,
  runAdversarialCliMission,
  runCoverageMission,
  runExploration,
  runFeatureCliMission,
  type AdversarialCliMissionResult,
  type FeatureCliMissionResult,
  type RunCoverageMissionResult,
  type RunExplorationResult,
  type ServerLogOptions,
} from "./explore-api.js";
import { runUsabilityMission, type RunUsabilityMissionResult } from "./ux-api.js";
import { buildProgram } from "./program.js";
import {
  MISSION_RESULT_SCHEMA_VERSION,
  MissionResultSchema,
  PersistedMissionResultSchema,
  type MissionResultCore,
} from "./result-schema.js";

/**
 * #195 part 5 — ONE versioned result schema across strategies. Every strategy's REAL result (a
 * served page, real Chromium, deterministic fakes for the model) — as returned, as printed by
 * `--json`, and as persisted in `<stem>.result.json` — validates against `MissionResultSchema`,
 * and fills the common fields the same way: a backend-log defect is in `defects` on every
 * strategy (not only in `serverLogDefects`), and the Recording(s) are always `recordingPaths[]`.
 */

// Compile-time: every strategy's result type carries the common fields (a runner that stops filling one fails to build).
expectTypeOf<RunExplorationResult>().toMatchTypeOf<MissionResultCore>();
expectTypeOf<RunCoverageMissionResult>().toMatchTypeOf<MissionResultCore>();
expectTypeOf<AdversarialCliMissionResult>().toMatchTypeOf<MissionResultCore>();
expectTypeOf<FeatureCliMissionResult>().toMatchTypeOf<MissionResultCore>();
expectTypeOf<RunUsabilityMissionResult>().toMatchTypeOf<MissionResultCore>();

const PAGE = `<!doctype html><html><body><main>
  <h1>Settings</h1>
  <p data-testid="status">idle</p>
  <button type="button" id="save">Save settings</button>
  <script>
    document.getElementById("save").onclick = async () => {
      await fetch("/api/save", { method: "POST" });
      document.querySelector("[data-testid=status]").textContent = "saved";
    };
  </script></main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
let logFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevitate-result-schema-"));
  logFile = join(dir, "app.log");
  await writeFile(logFile, "");
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/settings") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    if (path === "/api/save") {
      // The backend fails on every save: a `server-log` defect under `--log-defect error`.
      appendFileSync(logFile, `${JSON.stringify({ level: "error", time: new Date().toISOString(), message: "SaveSettings failed: settings store timeout" })}\n`);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Answers every question with its FIRST option (the page's only control), never flagging anything. */
const firstOptionJudge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
      else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.9 };
    }
    return out;
  },
};

/** Plays `click:0` then `done` (the goal loop's candidate-action format). */
function clickThenDone(): JudgmentPort {
  let i = 0;
  return {
    async systemOne() {
      const value = i++ === 0 ? "click:0" : "done";
      return { action: { kind: "choice", value, confidence: 0.9 } };
    },
  };
}

const serverLog = (): ServerLogOptions => ({
  sources: [{ kind: "file", path: logFile, raw: `file:${logFile}` }],
  logDefect: [{ kind: "level", level: "error", raw: "error" }],
  drainMs: 1000,
});

/** Validates a result three ways — as returned, as JSON, and as persisted — and returns the parsed core. */
function assertConforms(result: unknown, strategy: string): ReturnType<typeof MissionResultSchema.parse> {
  const json: unknown = JSON.parse(JSON.stringify(result));
  const parsed = MissionResultSchema.safeParse(json);
  expect(parsed.success, `${strategy}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)}`).toBe(true);
  const core = MissionResultSchema.parse(json);
  expect(core.schemaVersion).toBe(MISSION_RESULT_SCHEMA_VERSION);
  expect(core.strategy).toBe(strategy);
  const file: unknown = JSON.parse(readFileSync(core.resultPath, "utf8"));
  const persisted = PersistedMissionResultSchema.safeParse(file);
  expect(persisted.success, `${strategy} (persisted): ${persisted.success ? "" : JSON.stringify(persisted.error.issues, null, 2)}`).toBe(true);
  expect(persisted.success && persisted.data.result.strategy).toBe(strategy);
  expect(persisted.success && persisted.data.result.resultPath).toBe(core.resultPath);
  return core;
}

/** The backend-log defect is in `defects` (#195) — and the deprecated alias is exactly its server-log subset. */
function assertServerLogDefectInDefects(result: { defects: ReadonlyArray<{ kind: string; fingerprint: string }>; serverLogDefects?: ReadonlyArray<{ fingerprint: string }> }): void {
  const serverLogOnes = result.defects.filter((d) => d.kind === "server-log");
  expect(serverLogOnes.length).toBeGreaterThan(0);
  expect((result.serverLogDefects ?? []).map((d) => d.fingerprint)).toEqual(serverLogOnes.map((d) => d.fingerprint));
}

const url = (): string => `${origin}/settings`;
const out = async (name: string): Promise<string> => mkdtemp(join(dir, `${name}-`));

describe("one result schema across strategies (#195 part 5)", () => {
  it(
    "goal: conforms, and its server-log defect is in defects",
    async () => {
      const r = await runExploration({
        url: url(),
        goal: "save the settings",
        allowlist: [origin],
        judge: clickThenDone(),
        gen: new FakeGenerationGateway({}),
        successChecks: [parseSuccessSpec("textIncludes:[data-testid=status]|saved")],
        bounds: { maxActions: 2, maxDecisions: 3 },
        outDir: await out("goal"),
        serverLog: serverLog(),
      });
      const core = assertConforms(r, "goal");
      expect(core.missionOutcome).toBe("defects-found");
      expect(core.recordingPaths).toEqual([r.recordingPath]);
      assertServerLogDefectInDefects(r);
    },
    180_000,
  );

  it(
    "coverage and exploratory: conform, and the server-log defect is in defects",
    async () => {
      for (const strategy of ["coverage", "exploratory"] as const) {
        const r = await runCoverageMission({
          url: url(),
          allowlist: [origin],
          judge: firstOptionJudge,
          gen: new FakeGenerationGateway({}),
          strategy,
          bounds: { maxActions: 3, maxDecisions: 4 },
          outDir: await out(strategy),
          serverLog: serverLog(),
        });
        assertConforms(r, strategy);
        assertServerLogDefectInDefects(r);
      }
    },
    300_000,
  );

  it(
    "adversarial: conforms, one recording in recordingPaths, every defect (incl. server-log) in defects",
    async () => {
      const r = await runAdversarialCliMission({
        seedUrl: url(),
        allowlist: [origin],
        strategies: CLI_ADVERSARIAL_STRATEGIES,
        judgment: firstOptionJudge,
        generation: new FakeGenerationGateway({}),
        bounds: { maxActions: 4, maxDecisions: 4 },
        outDir: await out("adversarial"),
        serverLog: serverLog(),
      });
      const core = assertConforms(r, "adversarial");
      expect(core.recordingPaths).toEqual([r.recordingPath]);
      assertServerLogDefectInDefects(r);
    },
    240_000,
  );

  it(
    "feature: conforms, and the server-log defect is in defects",
    async () => {
      const r = await runFeatureCliMission({
        seedUrl: url(),
        allowlist: [origin],
        capability: "save settings",
        routeGlobs: ["/settings"],
        bounds: { maxActions: 3 },
        outDir: await out("feature"),
        serverLog: serverLog(),
      });
      assertConforms(r, "feature");
      assertServerLogDefectInDefects(r);
    },
    180_000,
  );

  it(
    "usability: conforms; its server-log defect is in defects, marked advisory, and never gates the outcome",
    async () => {
      const r = await runUsabilityMission({
        url: url(),
        job: "save the settings",
        allowlist: [origin],
        appContext: { appClass: "consumer", job: "save the settings" },
        judge: firstOptionJudge,
        gen: new FakeGenerationGateway(),
        judgmentBudget: 1,
        minConfidence: 0,
        outDir: await out("usability"),
        bounds: { maxDecisions: 1, maxActions: 1 },
        serverLog: serverLog(),
      });
      const core = assertConforms(r, "usability");
      expect(core.target.seedUrl).toBe(url());
      assertServerLogDefectInDefects(r);
      expect(r.defects.every((d) => d.advisory === true)).toBe(true);
      expect(core.missionOutcome).not.toBe("defects-found");
    },
    180_000,
  );

  it(
    "--json prints the same schema, and every --repeat run's envelope conforms (multi-run)",
    async () => {
      const lines: string[] = [];
      const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { judge: clickThenDone(), gen: new FakeGenerationGateway({}) } });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      const outDir = await out("cli");
      await program.parseAsync(
        [
          "explore",
          "--url",
          url(),
          "--feature",
          "save settings",
          "--route",
          "/settings",
          "--allow",
          origin,
          "--max-actions",
          "2",
          "--log-source",
          `file:${logFile}`,
          "--log-defect",
          "error",
          "--server-log-drain-ms",
          "1000",
          "--repeat",
          "2",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );
      process.exitCode = undefined;
      const env = JSON.parse(lines.join("")) as { ok: boolean; data: { kind: string; cells: Array<{ runs: Array<{ envelopePath: string }> }> } };
      expect(env.ok, JSON.stringify(env)).toBe(true);
      expect(env.data.kind).toBe("multi-run");
      const envelopes = env.data.cells.flatMap((c) => c.runs.map((r) => r.envelopePath));
      expect(envelopes).toHaveLength(2);
      for (const p of envelopes) {
        const runEnv = JSON.parse(readFileSync(p, "utf8")) as { ok: boolean; data: unknown };
        expect(runEnv.ok).toBe(true);
        assertConforms(runEnv.data, "feature");
      }
      // Every per-run result file it wrote validates too.
      const resultFiles = readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter((f) => /feature-.*\.result\.json$/.test(f));
      expect(resultFiles.length).toBe(2);
      for (const f of resultFiles) expect(PersistedMissionResultSchema.safeParse(JSON.parse(readFileSync(join(outDir, f), "utf8"))).success).toBe(true);
    },
    300_000,
  );

  it(
    "a check suite's mission results conform (the suite stamp passes through)",
    async () => {
      const suiteDir = await out("check");
      await writeFile(
        join(suiteDir, "suite.json"),
        JSON.stringify({
          version: 1,
          name: "schema",
          budget: { maxActions: 10, maxMinutes: 5 },
          targets: [{ name: "settings", url: url(), missions: [{ strategy: "feature", feature: "save settings", maxActions: 2 }] }],
        }),
      );
      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        journeysDir: join(suiteDir, "journeys"),
        explore: { targetsConfigPath: join(suiteDir, "no-targets.json") },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      await program.parseAsync(["check", "--suite", join(suiteDir, "suite.json"), "--out", join(suiteDir, "out"), "--json"], { from: "user" });
      process.exitCode = undefined;
      const env = JSON.parse(lines.join("")) as { ok: boolean; data: { items: Array<{ strategy?: string; resultPath?: string }> } };
      expect(env.ok, JSON.stringify(env)).toBe(true);
      const paths = env.data.items.flatMap((i) => (i.resultPath === undefined ? [] : [i.resultPath]));
      expect(paths).toHaveLength(1);
      const file = PersistedMissionResultSchema.safeParse(JSON.parse(readFileSync(paths[0]!, "utf8")));
      expect(file.success, file.success ? "" : JSON.stringify(file.error.issues)).toBe(true);
      expect(file.success && file.data.result.strategy).toBe("feature");
    },
    180_000,
  );
});
