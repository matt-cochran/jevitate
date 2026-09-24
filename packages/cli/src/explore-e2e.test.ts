import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import {
  FakeGenerationGateway,
  FakeJudgmentGateway,
  type Answer,
  type JudgmentPort,
} from "@jevitate/ai-core";
import { RecordingSchema } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor, type BrowserSession } from "@jevitate/screenplay";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { startServer } from "@jevitate/example-site";
import { buildProgram } from "./program.js";
import { runAdversarialCliMission, runCoverageMission } from "./explore-api.js";

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
});
