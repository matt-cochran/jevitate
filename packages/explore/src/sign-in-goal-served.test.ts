import { describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { GOAL_IS_SIGN_IN_QUESTION } from "./decide.js";
import { goalAsksForChange } from "./read-only.js";
import { ScriptedJudge, withSession, useSkippingTime, type ScriptedStep } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #810 — the nav lab's `sign-in-goal` case. A "Sign in with…" goal used to run read-only, so its
 * POST /login was aborted and it never signed in (10 of 10 failed). The goal now asks for a change:
 * the run may type and submit. Scripted judge + fake generator: no model call. The credentials come
 * from the goal text itself (a value the goal states verbatim needs no model).
 */

const GOAL = "Sign in with email morgan@pinecrest.example and password lab-pass-1.";

interface LabState {
  readonly done: boolean;
  readonly posts: readonly string[];
  readonly requests: readonly string[];
}

const SIGN_IN_STEPS: ScriptedStep[] = [{ op: "click", target: "0" }, { op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }];

async function oneRun(
  judge = new ScriptedJudge([...SIGN_IN_STEPS, { op: "done" }]),
): Promise<{ lab: LabState; transcript: string; recording: string; result: Awaited<ReturnType<typeof runGoalBasedMission>> }> {
  // @ts-expect-error — a plain .mjs fixture with no declaration file
  const { startNavLab } = (await import("../../../test/fixtures/nav-lab/app.mjs")) as {
    startNavLab: (o: { caseId: string; port?: number }) => Promise<{ url: string; close: () => Promise<void> }>;
  };
  const lab = await startNavLab({ caseId: "sign-in-goal" });
  try {
    // Home: [0] Sign in (link). Sign-in page: [0] Email, [1] Password, [2] Sign in (submit).
    const result = await withSession(
      "sign-in-goal-",
      async (session) => {
        const actor = CastActor.named("sign-in").whoCan(new BrowseTheWeb(session, [lab.url]));
        return runGoalBasedMission({
          actor,
          judge,
          gen: new FakeGenerationGateway(),
          goal: GOAL,
          allowlist: [lab.url],
          startUrl: `${lab.url}/`,
          bounds: { maxDecisions: 10 },
        });
      },
      lab.url,
    );
    const state = (await (await fetch(`${lab.url}/__lab/state`)).json()) as LabState;
    expect(result.outcome).toBe("succeeded");
    return { lab: state, transcript: JSON.stringify(result.transcript), recording: JSON.stringify(result.recording), result };
  } finally {
    await lab.close();
  }
}

describe("#810 — a sign-in goal is not read-only", () => {
  it("the goal reads as asking for a change", () => {
    expect(goalAsksForChange(GOAL)).toBe(true);
  });

  it(
    "the sign-in-goal case succeeds 2 of 2: one POST /login each, and the lab is signed in",
    async () => {
      for (let i = 0; i < 2; i++) {
        const { lab, transcript, recording } = await oneRun();
        expect(lab.posts).toEqual(["/login"]);
        expect(lab.requests.filter((r) => r.startsWith("POST /login"))).toEqual(["POST /login 303"]);
        expect(lab.done).toBe(true);
        // The transcript masks the typed password field; so does the Recording, without any --secret:
        // a value typed into a credential field is a run secret (goal-credential-redaction-served.test.ts).
        expect(transcript).not.toContain("lab-pass-1");
        expect(recording).not.toContain("lab-pass-1");
      }
    },
    180_000,
  );

  it(
    "RC lab 0/10: a model that never proposes done on the signed-in home page still ends succeeded — code saw Sign in give way",
    async () => {
      // As every rc-030 run did: after the sign-in it idles, then reports. The signed-in home page shows
      // "Welcome back, Morgan" and Invoices, no sign-out control; the page judgment alone stays below the bar.
      const judge = new ScriptedJudge([...SIGN_IN_STEPS, { op: "wait" }, { op: "scroll_down" }, { op: "scroll_up" }, { op: "report" }]);
      judge.goalMetProbability = 0.3;
      judge.noulProbabilities = { [GOAL_IS_SIGN_IN_QUESTION]: 0.95 };
      const { lab, result } = await oneRun(judge);
      expect(lab.done).toBe(true);
      expect(result.outcome).toBe("succeeded");
      expect(result.run.outcome).toEqual({ status: "completed", verifiedBy: "sign-in-signals" });
      const facts = judge.goalCalls.at(-1)?.state.controls.find((c) => c.startsWith("SIGN-IN (observed by code"));
      expect(facts).toMatch(/showed a sign-in control before the run signed in and shows none now/);
      expect(JSON.stringify(judge.goalCalls)).not.toContain("lab-pass-1");
    },
    90_000,
  );
});
