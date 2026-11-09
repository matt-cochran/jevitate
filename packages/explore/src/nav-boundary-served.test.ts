import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { goalReasonOf } from "@jevitate/domain";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./missions/goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * 0.30.0 (#807): the seeded navigation lab (test/fixtures/nav-lab), replayed with a scripted model.
 * Every boundary case must end `goalOutcome: "boundary"` with the kind the case calls for, in each
 * of two served replicates; a clean route and an incidental 403 on an image must not. The lab app
 * and its decoy origin are in-process servers on loopback ports the OS picks.
 */

interface Lab {
  readonly url: string;
  readonly extUrl: string;
  close(): Promise<void>;
}
const labPath = resolve(import.meta.dirname, "../../../test/fixtures/nav-lab/app.mjs");
async function startLab(caseId: string): Promise<Lab> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(labPath).href)) as { startNavLab(o: { caseId: string; port: number; seed: number }): Promise<Lab> };
  return mod.startNavLab({ caseId, port: 0, seed: 0 });
}

const GOAL = "Publish the Q3 sales report.";
const click = (name: string): Preference => ({ op: "click", name });
/** The route a person takes through the app; a step the page does not offer is skipped. */
const ROUTE: Preference[] = [click("Publish report"), click("Q3 sales report"), click("Reports")];

interface Case {
  readonly id: string;
  readonly prefs: (call: number) => readonly Preference[];
  readonly kind?: "wall" | "session" | "off-allowlist" | "new-tab";
  readonly origin?: "app" | "decoy";
}
/** After `n` decisions the scripted model has nothing left to try and gives up. */
const route = (n: number) => (call: number): readonly Preference[] => (call < n ? ROUTE : []);
const CASES: Case[] = [
  { id: "wall-403-page", prefs: route(4), kind: "wall" },
  { id: "wall-api-403", prefs: route(4), kind: "wall" },
  { id: "wall-plan-upgrade", prefs: route(4), kind: "wall" },
  { id: "session-expires-midrun", prefs: route(6), kind: "session" },
  { id: "sso-only", prefs: () => [click("Sign in with Pinecrest ID")], kind: "off-allowlist", origin: "decoy" },
  { id: "newtab-route", prefs: () => [click("Q3 sales report workspace")], kind: "new-tab", origin: "app" },
  { id: "clean", prefs: (call) => (call < 3 ? ROUTE : [{ op: "done" }]) },
  { id: "incidental-403-asset", prefs: (call) => (call < 3 ? ROUTE : [{ op: "done" }]) },
  // The stated limit (nav-lab failure-modes: "role-hidden controls: no signal within one session"): the
  // page only says "Signed in as Morgan Reyes (Viewer)" and has no Reports route; no 403, no paid control.
  // Code never guesses a wall from a role word: it is a no-route case (a second persona shows the role).
  { id: "wall-role-hidden", prefs: route(4) },
];

const labs: Lab[] = [];
afterEach(async () => {
  await Promise.all(labs.splice(0).map((l) => l.close()));
});

async function replay(c: Case): Promise<{ result: GoalBasedResult; lab: Lab }> {
  const lab = await startLab(c.id);
  labs.push(lab);
  const judge = new PreferenceJudge(c.prefs, "blocked");
  judge.goalMetProbability = 0.9;
  const result = await withSession(
    `nav-boundary-${c.id}-`,
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [lab.url]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [lab.url],
        startUrl: `${lab.url}/`,
        waitOpMs: 300,
        bounds: { maxDecisions: 12 },
      });
    },
    lab.url,
  );
  return { result, lab };
}

describe("#807 nav lab, served: boundary cases end as a boundary", () => {
  for (const c of CASES.filter((x) => x.kind !== undefined)) {
    for (const replicate of [1, 2]) {
      it(
        `${c.id} (replicate ${replicate}/2) ends 'boundary' of kind ${c.kind}`,
        async () => {
          const { result, lab } = await replay(c);
          expect(result.outcome).toBe("boundary");
          expect(result.run.boundary?.kind).toBe(c.kind);
          if (c.origin !== undefined) {
            expect(result.run.boundary?.origin).toBe(c.origin === "decoy" ? lab.extUrl : lab.url);
            const reason = result.reason ?? "";
            expect(reason).toContain(c.origin === "decoy" ? lab.extUrl : lab.url);
            expect(reason).not.toContain("{");
            const goalReason = goalReasonOf({ goalOutcome: "boundary", ...(result.run.missCause === undefined ? {} : { missCause: result.run.missCause }) });
            expect(goalReason).toBe(c.kind === "new-tab" ? "tab-opened" : "write-refused");
            expect(goalReason).not.toContain("{");
          }
        },
        120_000,
      );
    }
  }
});

describe("#807 nav lab, served: routes with no boundary", () => {
  for (const c of CASES.filter((x) => x.kind === undefined)) {
    it(
      `${c.id} ends with no boundary`,
      async () => {
        const { result } = await replay(c);
        expect(result.run.boundary).toBeUndefined();
        expect(result.outcome).not.toBe("boundary");
      },
      120_000,
    );
  }
});
