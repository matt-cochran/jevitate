import { describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenInput, type GenTaskKind, type GenerationResult } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Step } from "@jevitate/recording";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * A goal-stated credential is never stored or shown to a model after it is typed (0.30.0, the
 * d-sign-in-verb finding). The nav lab's `sign-in-goal` case, NO `--secret`: the goal states the
 * password, the run types it from the goal. It used to be stored in the clear — the Recording's
 * fill `{ redacted: false, value }` and its `intent` — and the goal carried it into every later
 * model call. Scripted judge + fake generator: no model call.
 */

/** The lab accepts exactly this password: the MARKER no artifact or later payload may hold. */
const MARKER = "lab-pass-1";
const EMAIL = "morgan@pinecrest.example";
const GOAL = `Sign in with email ${EMAIL} and password ${MARKER}.`;

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** A fake generator that keeps every payload it was sent, and whether the run had learned the credential then. */
class CapturingGateway extends FakeGenerationGateway {
  readonly calls: Array<{ kind: string; input: unknown; afterFill: boolean }> = [];
  learned = false;
  override async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    this.calls.push({ kind, input, afterFill: this.learned });
    return super.generate(kind, input);
  }
}

describe("a goal-stated credential is redacted at rest and from later model calls", () => {
  it(
    "the password field's fill is { redacted: true }, the intent masks it, the email still records, and no artifact or later payload holds the MARKER",
    async () => {
      // @ts-expect-error — a plain .mjs fixture with no declaration file
      const { startNavLab } = (await import("../../../test/fixtures/nav-lab/app.mjs")) as {
        startNavLab: (o: { caseId: string; port?: number }) => Promise<{ url: string; close: () => Promise<void> }>;
      };
      const lab = await startNavLab({ caseId: "sign-in-goal" });
      try {
        // Home: [0] Sign in (link). Sign-in page: [0] Email, [1] Password, [2] Sign in (submit).
        const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }, { op: "done" }]);
        const gen = new CapturingGateway();
        const learned: string[] = [];
        let judgeCallsAtFill = -1;
        const result = await withSession(
          "goal-credential-",
          async (session) => {
            const actor = CastActor.named("sign-in").whoCan(new BrowseTheWeb(session, [lab.url]));
            return runGoalBasedMission({
              actor,
              judge,
              gen,
              goal: GOAL,
              allowlist: [lab.url],
              startUrl: `${lab.url}/`,
              bounds: { maxDecisions: 10 },
              onRunSecret: (v) => {
                learned.push(v);
                gen.learned = true;
                judgeCallsAtFill = judge.calls.length;
              },
            });
          },
          lab.url,
        );
        const state = (await (await fetch(`${lab.url}/__lab/state`)).json()) as { done: boolean };
        // The run still works: the real value reached the browser.
        expect(result.outcome).toBe("succeeded");
        expect(state.done).toBe(true);
        // The caller learned the value as a run secret (the CLI masks its own artifacts with it).
        expect(learned).toEqual([MARKER]);

        // The Recording: the password fill redacted, the email fill (not a credential) in the clear.
        const steps: Step[] = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
        const fills = steps.filter((s): s is Extract<Step, { kind: "fill" }> => s.kind === "fill");
        expect(fills).toHaveLength(2);
        expect(fills[0]!.value).toEqual({ redacted: false, value: EMAIL });
        expect(fills[1]!.value).toEqual({ redacted: true, length: MARKER.length });
        expect(result.recording.intent).toBe(`Sign in with email ${EMAIL} and password «redacted».`);

        // Every artifact the mission returns (Recording, transcript, run, reason, checks): zero.
        expect(count(JSON.stringify(result), MARKER)).toBe(0);
        // The transcript masks the field's value, as before.
        expect(JSON.stringify(result.transcript)).toContain("«redacted»");

        // Every model payload AFTER the fill: the decision states, the goal checks, the generator.
        expect(judgeCallsAtFill).toBeGreaterThan(0);
        const laterJudge = judge.calls.slice(judgeCallsAtFill);
        expect(laterJudge.length).toBeGreaterThan(0);
        expect(count(JSON.stringify(laterJudge), MARKER)).toBe(0);
        expect(judge.goalCalls.length).toBeGreaterThan(0);
        expect(count(JSON.stringify(judge.goalCalls), MARKER)).toBe(0);
        expect(count(JSON.stringify(gen.calls.filter((c) => c.afterFill)), MARKER)).toBe(0);
        // The goal itself reaches later calls redacted, not dropped.
        expect(JSON.stringify(laterJudge)).toContain("password «redacted»");
      } finally {
        await lab.close();
      }
    },
    180_000,
  );
});
