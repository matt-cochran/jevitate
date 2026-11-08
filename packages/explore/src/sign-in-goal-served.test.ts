import { describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { goalAsksForChange } from "./read-only.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

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

async function oneRun(): Promise<{ lab: LabState; transcript: string }> {
  // @ts-expect-error — a plain .mjs fixture with no declaration file
  const { startNavLab } = (await import("../../../test/fixtures/nav-lab/app.mjs")) as {
    startNavLab: (o: { caseId: string; port?: number }) => Promise<{ url: string; close: () => Promise<void> }>;
  };
  const lab = await startNavLab({ caseId: "sign-in-goal" });
  try {
    // Home: [0] Sign in (link). Sign-in page: [0] Email, [1] Password, [2] Sign in (submit).
    const judge = new ScriptedJudge([{ op: "click", target: "0" }, { op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }, { op: "done" }]);
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
    return { lab: state, transcript: JSON.stringify(result.transcript) };
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
        const { lab, transcript } = await oneRun();
        expect(lab.posts).toEqual(["/login"]);
        expect(lab.requests.filter((r) => r.startsWith("POST /login"))).toEqual(["POST /login 303"]);
        expect(lab.done).toBe(true);
        // The transcript masks the typed password field. NOT asserted for the Recording: without a
        // registered secret (--secret) it holds the goal as `intent` and the typed value (0.29.0 behaviour).
        expect(transcript).not.toContain("lab-pass-1");
      }
    },
    180_000,
  );
});
