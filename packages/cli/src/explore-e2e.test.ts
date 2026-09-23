import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import {
  FakeGenerationGateway,
  type Answer,
  type JudgmentPort,
} from "@jevitate/ai-core";
import { RecordingSchema } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor, type BrowserSession } from "@jevitate/screenplay";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { startServer } from "@jevitate/example-site";
import { buildProgram } from "./program.js";

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

class ScriptedJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly seq: ReadonlyArray<{ op: string; target?: string }>) {}
  async systemOne(args: { questions: Record<string, unknown> }): Promise<Record<string, Answer>> {
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)]!;
    this.#i += 1;
    const out: Record<string, Answer> = { op: { kind: "choice", value: cur.op, confidence: 0.9 } };
    if (args.questions.target && cur.target !== undefined) {
      out.target = { kind: "choice", value: cur.target, confidence: 0.9 };
    }
    return out;
  }
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
