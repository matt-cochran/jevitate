import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import {
  FakeGenerationGateway,
  FakeJudgmentGateway,
  type Answer,
  UsageTracker,
  type GenerationPort,
  type JudgmentPort,
} from "@jevitate/ai-core";
import { RecordingSchema } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor, type BrowserSession } from "@jevitate/screenplay";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { startServer } from "@jevitate/example-site";
import { buildProgram } from "./program.js";
import { runAdversarialCliMission, runCoverageMission, runFeatureCliMission } from "./explore-api.js";

/**
 * P1 acceptance (Task 12): `jevitate explore --url <fixture> --goal ... --success ...`
 * drives the fixture to the goal (with injected fake gateways + a real browser),
 * writes a replayable Recording, and the invariant contract holds.
 */

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

/** Plays a fixed sequence in decide()'s candidate-action format: `<op>:<index>` or a bare op. */
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

/** Minimal structural view of a persisted transcript entry (the file is JSON). */
interface PersistedEntry {
  step: number;
  op: string | null;
  chosenBy: string;
  actOk: boolean;
  controlCount: number;
  strategy?: string;
  judgments?: Record<string, { value: boolean; probability: number }>;
}

function isPersistedEntry(v: unknown): v is PersistedEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    "step" in v &&
    typeof v.step === "number" &&
    "chosenBy" in v &&
    typeof v.chosenBy === "string" &&
    "controlCount" in v &&
    typeof v.controlCount === "number"
  );
}

async function readTranscript(path: string): Promise<PersistedEntry[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isPersistedEntry)) throw new Error(`not a transcript: ${path}`);
  return parsed;
}

describe("jevitate explore — real-browser fixture smoke (Task 12)", () => {
  it(
    "drives the fixture to the goal, writes a replayable Recording, and reports succeeded",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-explore-out-"));
      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          judge: new ScriptedJudge([
            { op: "type", target: "0" },
            { op: "click", target: "1" },
            { op: "done" },
          ]),
          gen: new FakeGenerationGateway({ "form.value": { text: "jane" } }),
        },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();

      await program.parseAsync(
        [
          "explore",
          "--url",
          `${site.url}/login`,
          "--goal",
          "sign in and reach the inbox",
          "--success",
          "urlIncludes:/inbox",
          "--allow",
          site.url,
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );

      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok).toBe(true);
      expect(parsed.data.outcome).toBe("succeeded");
      expect(parsed.data.assertionPassed).toBe(true);
      expect(parsed.data.finalUrl).toContain("/inbox");

      // The decision transcript is written next to the Recording and equals the returned one.
      expect(parsed.data.transcriptPath).toBe(parsed.data.recordingPath.replace(/\.json$/, ".transcript.json"));
      const transcript = await readTranscript(parsed.data.transcriptPath);
      expect(transcript).toEqual(parsed.data.transcript);
      expect(transcript.map((e) => e.op)).toEqual(["type", "click", "done"]);
      expect(transcript.every((e) => e.chosenBy === "model" && e.controlCount > 0)).toBe(true);

      // The written Recording is schema-valid and replays deterministically.
      const raw = await readFile(parsed.data.recordingPath, "utf8");
      const recording = RecordingSchema.parse(JSON.parse(raw));

      const port = new PlaywrightBrowserPort();
      const session: BrowserSession = await port.open({
        headless: true,
        allowedOrigins: [site.url],
        baseUrl: site.url,
      });
      try {
        const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [site.url]));
        const result = await new RecordingInterpreter().run(actor, recording);
        expect(result.outcome).toBe("completed");
        expect(session.page.url()).toContain("/inbox");
      } finally {
        await session.close();
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe("jevitate explore — #163 full run cost (Jev + generation) with known per-call costs", () => {
  it(
    "totalUsd is exactly the sum of every call's cost, the sidecar lists every call, and stderr shows the cost",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-explore-cost-"));
      const lines: string[] = [];
      const errs: string[] = [];
      const usage = new UsageTracker();
      const JEV_USD = 0.001;
      const GEN_USD = 0.0025;
      const inner = new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]);
      const judge: JudgmentPort = {
        async systemOne(args) {
          usage.recordJudgment({ inputTokens: 1_000, outputTokens: 0, usd: JEV_USD, model: "jev-1.13.0" });
          return inner.systemOne(args);
        },
      };
      const fakeGen = new FakeGenerationGateway({ "form.value": { text: "jane" } });
      const gen: GenerationPort = {
        async generate(kind, input) {
          usage.recordGeneration({ inputTokens: 50, outputTokens: 5, usd: GEN_USD, model: "openai/gpt-4o-mini", task: kind });
          return fakeGen.generate(kind, input);
        },
      };
      const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { judge, gen, usage } });
      program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => errs.push(s) });
      program.exitOverride();
      try {
        await program.parseAsync(
          ["explore", "--url", `${site.url}/login`, "--goal", "sign in and reach the inbox", "--success", "urlIncludes:/inbox", "--allow", site.url, "--out", outDir, "--json"],
          { from: "user" },
        );
        const parsed = JSON.parse(lines.join(""));
        expect(parsed.ok).toBe(true);
        const u = parsed.data.usage;
        expect(u.judgments).toBeGreaterThanOrEqual(3);
        expect(u.generations).toBeGreaterThanOrEqual(1);
        expect(u.jevUsd).toBeCloseTo(u.judgments * JEV_USD, 12);
        expect(u.generationUsd).toBeCloseTo(u.generations * GEN_USD, 12);
        expect(u.totalUsd).toBeCloseTo(u.judgments * JEV_USD + u.generations * GEN_USD, 12);
        expect(u.priced).toBe("full");

        const sidecarPath = parsed.data.resultPath.replace(/\.result\.json$/, ".usage.json");
        const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
        expect(sidecar.version).toBe(1);
        expect(sidecar.calls).toHaveLength(u.judgments + u.generations);
        expect(sidecar.calls.filter((c: { kind: string }) => c.kind === "generation").every((c: { task?: string }) => c.task === "form.value")).toBe(true);
        expect(sidecar.usage.totalUsd).toBeCloseTo(u.totalUsd, 12);
        expect(JSON.stringify(sidecar)).not.toMatch(/jane|sign in|Bearer/);

        expect(errs.join("")).toMatch(/^usage: cost \$0\.\d+ \(jev \$[\d.]+ \+ generation \$[\d.]+\) · \d+ judgments, \d+ generations?, [\d,]+ tokens\n$/);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe("jevitate explore — --fake-ai smoke answers the candidate-action question", () => {
  it(
    "the fake judge proposes done (advisory), the oracle refuses it, and the transcript is written",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-explore-fake-"));
      const lines: string[] = [];
      const program = buildProgram({ profiles: new ProfileManager("/unused") });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      try {
        await program.parseAsync(
          [
            "explore",
            "--url",
            `${site.url}/login`,
            "--goal",
            "sign in",
            "--success",
            "urlIncludes:/inbox",
            "--fake-ai",
            "--out",
            outDir,
            "--json",
          ],
          { from: "user" },
        );
        const parsed = JSON.parse(lines.join(""));
        expect(parsed.ok).toBe(true);
        // The fake judge only ever proposes done; the oracle (never Jev) refuses it each time, so the
        // run ends incomplete with the reason — not a silent early stop.
        expect(parsed.data.stop).toBe("blocked");
        expect(parsed.data.assertionPassed).toBe(false);
        expect(parsed.data.runOutcome.status).toBe("incomplete");
        expect(parsed.data.runOutcome.reason).toMatch(/proposed done 3 times, but the success condition is not met/);
        const transcript = await readTranscript(parsed.data.transcriptPath);
        expect(transcript).toHaveLength(3);
        expect(transcript.every((e) => e.op === "done" && e.actOk === false)).toBe(true);
        // #100: --fake-ai still threads a usage tracker end to end — 0 tokens (deterministic fake),
        // but at least one judgment counted (so a test can assert the shape without a live key).
        expect(parsed.data.usage.generations).toBe(0);
        expect(parsed.data.usage.judgments).toBeGreaterThanOrEqual(1);
        expect(parsed.data.usage.inputTokens).toBe(0);
        expect(parsed.data.usage.outputTokens).toBe(0);
        // #163: a fake call ran no model, so it is known to cost $0 — fully priced, never "unpriced".
        expect(parsed.data.usage.totalUsd).toBe(0);
        expect(parsed.data.usage.priced).toBe("full");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "#136: a configured JEVITATE_JEV_UNIT_PRICE_USD prices jevUsd end to end, with its source labelled",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-explore-fake-priced-"));
      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: { env: { JEVITATE_JEV_UNIT_PRICE_USD: "0.01" } },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      try {
        await program.parseAsync(
          ["explore", "--url", `${site.url}/login`, "--goal", "sign in", "--success", "urlIncludes:/inbox", "--fake-ai", "--out", outDir, "--json"],
          { from: "user" },
        );
        const parsed = JSON.parse(lines.join(""));
        expect(parsed.ok).toBe(true);
        const { usage } = parsed.data;
        expect(usage.judgments).toBeGreaterThanOrEqual(1);
        expect(usage.jevUsd).toBeCloseTo(usage.judgments * 0.01, 10);
        expect(usage.jevPriceSource).toBe("env:JEVITATE_JEV_UNIT_PRICE_USD");
        expect(usage.totalUsd).toBeCloseTo(usage.jevUsd, 10);
        expect(usage.usd).toBeCloseTo(usage.jevUsd, 10); // #100 compat alias
        expect(usage.priced).toBe("full"); // no generations were made (the fake judge never calls one)
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe("shared decision transcript — every model-deciding strategy writes one", () => {
  it(
    "adversarial: strategy-chosen steps with Jev's advisory looksBroken judgment",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-adv-transcript-"));
      try {
        const result = await runAdversarialCliMission({
          seedUrl: `${site.url}/login`,
          allowlist: [site.url],
          strategies: ["ordering-violation", "boundary-input"],
          bounds: { maxDecisions: 2 },
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.2 } }),
          generation: new FakeGenerationGateway(),
          outDir,
          nowIso: () => "2026-09-23T00:00:00.000Z",
        });
        expect(result.transcriptPath).toBe(join(outDir, "adversarial-2026-09-23T00-00-00-000Z.transcript.json"));
        // The typed verdict, its exit code, and the Recording + persisted result next to it. Two
        // steps never submitted the sign-in form: the run proved nothing, so it is inconclusive (2)
        // with its coverage — never clean.
        expect(result.outcome).toBe("inconclusive");
        expect(result.exitCode).toBe(2);
        expect(result.coverage).toMatchObject({ sufficient: false, forms: { found: 1, submitted: 0 } });
        expect(result.recordingPath).toBe(join(outDir, "adversarial-2026-09-23T00-00-00-000Z.json"));
        expect(JSON.parse(await readFile(result.recordingPath, "utf8"))).toEqual(result.recording);
        const persisted = JSON.parse(await readFile(result.resultPath, "utf8")) as unknown;
        expect(persisted).toMatchObject({
          missionOutcome: "inconclusive",
          exitCode: 2,
          result: { coverage: { sufficient: false, shortfalls: ["no form was submitted (1 found)"] } },
        });
        // Build identity (issue #83): every result says which build produced it, on disk too.
        expect(result.engine).toMatchObject({ version: expect.any(String), commit: expect.any(String), builtAt: expect.any(String) });
        expect(persisted).toMatchObject({ result: { engine: result.engine } });
        const transcript = await readTranscript(result.transcriptPath);
        expect(transcript).toEqual(result.transcript);
        expect(transcript.map((e) => e.strategy)).toEqual(["seed-load", "ordering-violation", "boundary-input"]);
        expect(transcript.every((e) => e.chosenBy === "strategy")).toBe(true);
        // boundary-input targets the Username field through the shared affordance mapping.
        expect(transcript[2]?.op).toBe("type");
        expect(transcript[1]?.judgments?.looksBroken).toEqual({ value: false, probability: 0.2 });
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "coverage: frontier steps with Jev's advisory isDefect judgment",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-cov-transcript-"));
      try {
        const result = await runCoverageMission({
          url: `${site.url}/exploratory-testing/cycle-a`,
          allowlist: [site.url],
          // The cycle spans sibling routes: widen the default start-route scope (#89).
          routeGlobs: ["/exploratory-testing/**"],
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0.1 } }),
          gen: new FakeGenerationGateway(),
          outDir,
          nowIso: () => "2026-09-23T00:00:00.000Z",
        });
        expect(result.transcriptPath).toBe(join(outDir, "coverage-2026-09-23T00-00-00-000Z.transcript.json"));
        const transcript = await readTranscript(result.transcriptPath);
        expect(transcript.length).toBe(result.coverage.transitionsExercised);
        expect(transcript.every((e) => e.op === "click" && e.strategy === "coverage-frontier" && e.actOk)).toBe(true);
        expect(transcript[0]?.judgments?.isDefect).toEqual({ value: false, probability: 0.1 });
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "coverage: a seed that redirects to /login (a lost --storage-state session) is inconclusive, never clean (#82)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-cov-redirect-"));
      try {
        // No --storage-state: a fresh, unauthenticated context, exactly like a lost/expired session.
        const result = await runCoverageMission({
          url: `${site.url}/inbox`,
          allowlist: [site.url],
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          gen: new FakeGenerationGateway(),
          outDir,
        });
        expect(result.outcome).toBe("scope-unreachable");
        expect(result.missionOutcome).toBe("inconclusive");
        expect(result.exitCode).toBe(2);
        expect(result.failure).toEqual({
          kind: "target-unreachable",
          message: "seed /inbox redirected to /login — the --storage-state session is not authenticated",
        });
        expect(result.coverage.statesVisited).toBe(0);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "coverage: --save-storage-state writes the context's storageState at the end, mode 0600 (#82)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-cov-save-state-"));
      const saveTo = join(outDir, "state.json");
      try {
        const result = await runCoverageMission({
          url: `${site.url}/whoami`,
          allowlist: [site.url],
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          gen: new FakeGenerationGateway(),
          outDir,
          saveStorageState: saveTo,
        });
        expect(result.outcome).toBe("exhausted");
        const written = JSON.parse(await readFile(saveTo, "utf8"));
        expect(written).toHaveProperty("cookies");
        expect(written).toHaveProperty("origins");
        // Owner read/write only — the file holds live session credentials.
        const mode = (await stat(saveTo)).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("runFeatureCliMission — ranked, honest --out (ticket #78)", () => {
  it(
    "exercises the in-scope 'Buy pack' buttons, is reported clean, and writes recordings + transcript + a typed result",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-feature-out-"));
      try {
        const result = await runFeatureCliMission({
          seedUrl: `${site.url}/feature-mission/shop`,
          allowlist: [site.url],
          capability: "buy a pack",
          routeGlobs: ["/feature-mission/shop"],
          outDir,
          nowIso: () => "2026-09-23T00:00:00.000Z",
        });

        expect(result.missionOutcome).toBe("clean");
        expect(result.exitCode).toBe(0);
        expect(result.failure).toBeUndefined();
        expect(result.coverage.inScopeActionsExercised).toBeGreaterThan(0);
        expect(new Set(result.coverage.boundaryEdges).size).toBe(result.coverage.boundaryEdges.length);

        // --out receives the recordings, the transcript and a typed result.json — none of
        // this was written before ticket #78.
        expect(result.recordingPaths.length).toBeGreaterThan(0);
        expect(result.recordingPaths.every((p) => p.startsWith(join(outDir, "feature-2026-09-23T00-00-00-000Z-path-")))).toBe(
          true,
        );
        for (const p of result.recordingPaths) {
          expect(JSON.parse(await readFile(p, "utf8"))).toMatchObject({ version: "1.0.0" });
        }
        expect(result.transcriptPath).toBe(join(outDir, "feature-2026-09-23T00-00-00-000Z.transcript.json"));
        const transcript = await readTranscript(result.transcriptPath);
        expect(transcript).toEqual(result.transcript);
        expect(transcript.every((e) => e.strategy === "feature-frontier" && e.chosenBy === "strategy")).toBe(true);
        const buyClick = transcript.find((e) => e.op === "click" && e.target !== null && /buy pack/i.test(e.target));
        expect(buyClick?.actOk).toBe(true);

        expect(result.resultPath).toBe(join(outDir, "feature-2026-09-23T00-00-00-000Z.result.json"));
        const persisted = JSON.parse(await readFile(result.resultPath, "utf8")) as unknown;
        expect(persisted).toMatchObject({ missionOutcome: "clean", exitCode: 0 });
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "a chrome-only page (nothing but the shared header nav) is reported inconclusive with a shortfall — never clean",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-feature-chrome-only-"));
      try {
        const result = await runFeatureCliMission({
          seedUrl: `${site.url}/feature-mission/chrome-only`,
          allowlist: [site.url],
          capability: "buy a pack",
          routeGlobs: ["/feature-mission/chrome-only"],
          outDir,
          nowIso: () => "2026-09-23T00:00:00.000Z",
        });

        expect(result.coverage.inScopeActionsExercised).toBe(0);
        expect(result.missionOutcome).toBe("inconclusive");
        expect(result.exitCode).toBe(2);
        expect(result.failure).toMatchObject({ kind: "insufficient-coverage" });
        expect(result.failure?.message).toContain("buy a pack");

        const persisted = JSON.parse(await readFile(result.resultPath, "utf8")) as unknown;
        expect(persisted).toMatchObject({
          missionOutcome: "inconclusive",
          exitCode: 2,
          result: { failure: { kind: "insufficient-coverage" } },
        });
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
