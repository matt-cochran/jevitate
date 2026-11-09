import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { FakeGenerationGateway, type GenInput, type GenTaskKind, type GenerationResult } from "@jevitate/ai-core";
import { runExploration } from "./explore-goal.js";
import { ScriptedJudge, useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
// #547: screenshots need the browser's own requestAnimationFrame (the pixel mask), so the page keeps its clock.
useSkippingTime({ per: "all", pageClock: false });

/**
 * A goal-stated credential is in NO written artifact (0.30.0, the d-sign-in-verb finding). The nav
 * lab's `sign-in-goal` case through `runExploration`, NO `--secret`: the goal states the password and
 * the run types it. Every file the run writes (result, Recording, transcript, evidence, logs) and
 * every generator payload after the fill is grepped for the MARKER. Scripted judge + fake generator.
 */

const MARKER = "lab-pass-1";
const EMAIL = "morgan@pinecrest.example";

class CapturingGateway extends FakeGenerationGateway {
  readonly payloads: string[] = [];
  override async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    this.payloads.push(JSON.stringify(input));
    return super.generate(kind, input);
  }
}

describe("a goal-stated password is in no written artifact", () => {
  it("result, Recording, transcript and every other file the run writes hold the MARKER 0 times; the email still records", async () => {
    // @ts-expect-error — a plain .mjs fixture with no declaration file
    const { startNavLab } = (await import("../../../test/fixtures/nav-lab/app.mjs")) as {
      startNavLab: (o: { caseId: string; port?: number }) => Promise<{ url: string; close: () => Promise<void> }>;
    };
    const lab = await startNavLab({ caseId: "sign-in-goal" });
    const out = await mkdtemp(join(tmpdir(), "jev-goal-cred-"));
    try {
      // Home: [0] Sign in (link). Sign-in page: [0] Email, [1] Password, [2] Sign in (submit).
      const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }, { op: "done" }]);
      const gen = new CapturingGateway();
      const result = await runExploration({
        url: `${lab.url}/`,
        allowlist: [lab.url],
        goal: `Sign in with email ${EMAIL} and password ${MARKER}.`,
        judge,
        gen,
        outDir: out,
        bounds: { maxDecisions: 10 },
        screenshots: { mode: "steps" },
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      const r = result as unknown as { goalOutcome: string; resultPath: string };
      expect(r.goalOutcome).toBe("succeeded");
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const f = join(d, e.name);
          if (e.isDirectory()) walk(f);
          else files.push(f);
        }
      };
      walk(out);
      const text = files.filter((f) => /\.(json|md|txt|jsonl|log)$/.test(f));
      expect(text).toContain(r.resultPath);
      expect(text.length).toBeGreaterThanOrEqual(3);
      let total = 0;
      for (const f of text) total += readFileSync(f, "utf8").split(MARKER).length - 1;
      expect(total).toBe(0);
      expect(JSON.stringify(result).split(MARKER).length - 1).toBe(0);
      // No over-redaction: the email field's value still records, in the result's Recording.
      expect(readFileSync(r.resultPath, "utf8")).toContain(`"value": "${EMAIL}"`);
      // The decision states after the password was typed (from the 4th on) and every goal check.
      expect(JSON.stringify(judge.calls.slice(3)).split(MARKER).length - 1).toBe(0);
      expect(JSON.stringify(judge.goalCalls).split(MARKER).length - 1).toBe(0);
      expect(gen.payloads.filter((p) => p.includes(MARKER))).toEqual([]);
    } finally {
      await lab.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});
