import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { goalMissionOutcome, goalReasonOf, MISSION_EXIT_CODES } from "@jevitate/domain";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./missions/goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * 0.30.0 (#807, fm-nav-no-route-reads-as-defect): the nav lab's no-route group, replayed with a scripted
 * model that tours every control the app offers and then gives up. With the coverage floor met, the run
 * ends `inconclusive` (exit 2), `goalReason: no-route-found`, naming what it searched; a role word on the
 * page is a hint in the reason, never a wall. Controls: a route the run cannot perceive (a clickable span)
 * and a reachable route the model never took must not read no-route-found, and a reached goal succeeds.
 */

interface Lab {
  readonly url: string;
  close(): Promise<void>;
}
const labPath = resolve(import.meta.dirname, "../../../test/fixtures/nav-lab/app.mjs");
async function startLab(caseId: string): Promise<Lab> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(labPath).href)) as { startNavLab(o: { caseId: string; port: number; seed: number }): Promise<Lab> };
  return mod.startNavLab({ caseId, port: 0, seed: 0 });
}

const GOAL = "Publish the Q3 sales report.";
const click = (name: string): Preference => ({ op: "click", name });
/** One scripted decision per entry, in order; after the last the model has nothing left and gives up. */
const tour = (names: readonly string[]) => (call: number): readonly Preference[] => (call < names.length ? [click(names[call]!)] : []);

/** Every page and control of the lab's shared app (`common(NAV.base)`): invoices, customers, settings. */
const APP_TOUR = ["Invoices", "INV-1024", "Invoices", "INV-1042", "Invoices", "INV-1057", "Customers", "Settings", "Profile", "Settings", "Team"];

const labs: Lab[] = [];
afterEach(async () => {
  await Promise.all(labs.splice(0).map((l) => l.close()));
});

/** `met`: what the scripted goal judgment says (no route: the goal is not met on any page). */
async function replay(caseId: string, prefs: (call: number) => readonly Preference[], met = 0.1): Promise<GoalBasedResult> {
  const lab = await startLab(caseId);
  labs.push(lab);
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = met;
  return withSession(
    `nav-no-route-${caseId}-`,
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
        bounds: { maxDecisions: 30, maxActions: 30 },
      });
    },
    lab.url,
  );
}

const reasonOf = (r: GoalBasedResult) =>
  goalReasonOf({
    goalOutcome: r.outcome,
    ...(r.run.stop === undefined ? {} : { stop: r.run.stop }),
    ...(r.run.failure === undefined ? {} : { failureKind: r.run.failure.kind }),
    ...(r.run.missCause === undefined ? {} : { missCause: r.run.missCause }),
  });

describe("#807 nav lab, served: the no-route group ends no-route-found once the floor is met", () => {
  const CASES: Array<{ id: string; tour: readonly string[]; pages: readonly string[] }> = [
    { id: "no-route-absent-feature", tour: APP_TOUR, pages: ["/invoices", "/customers", "/settings/team"] },
    { id: "no-route-removed-link", tour: APP_TOUR, pages: ["/invoices", "/customers", "/settings/team"] },
    { id: "loop-period-3", tour: ["Activity", "Archive", "Overview"], pages: ["/activity", "/archive"] },
    { id: "large-no-route", tour: ["Customer 1", "Next customer", "Next customer"], pages: ["/customer/1", "/customer/3"] },
    { id: "wall-role-hidden", tour: APP_TOUR, pages: ["/invoices", "/settings/profile"] },
  ];
  for (const c of CASES) {
    it(
      `${c.id}: inconclusive (exit 2), goalReason no-route-found, naming what was searched`,
      async () => {
        const r = await replay(c.id, tour(c.tour));
        expect(r.run.failure?.kind, r.reason).toBe("no-route-found");
        expect(r.outcome).toBe("inconclusive");
        expect(reasonOf(r)).toBe("no-route-found");
        expect(r.run.boundary).toBeUndefined();
        expect(MISSION_EXIT_CODES[goalMissionOutcome(r.outcome, "none")]).toBe(2);
        for (const p of c.pages) expect(r.reason).toContain(p);
        if (c.id === "wall-role-hidden") {
          expect(r.reason).toContain("signed in as a Viewer; a person with another role may see more");
        } else {
          expect(r.reason).not.toMatch(/another role/);
        }
        expect(r.reason).not.toMatch(/\bwall\b|permission|forbidden/i);
      },
      120_000,
    );
  }
});

describe("#807 nav lab, served: a reachable goal never reads no-route-found", () => {
  it("route-hidden-from-model: the route is a clickable span the run cannot use, so the floor is not met", async () => {
    const r = await replay("route-hidden-from-model", tour(APP_TOUR));
    expect(r.run.failure?.kind).not.toBe("no-route-found");
    expect(reasonOf(r)).not.toBe("no-route-found");
  }, 120_000);

  it("clean: a model that tours everything but Reports and gives up is below the floor (Reports unopened)", async () => {
    const r = await replay("clean", tour(["Invoices", "INV-1024", "Invoices", "INV-1042", "Invoices", "INV-1057", "Customers", "Settings", "Profile", "Settings", "Team"]));
    expect(r.outcome).not.toBe("succeeded");
    expect(r.run.failure?.kind).not.toBe("no-route-found");
    expect(reasonOf(r)).not.toBe("no-route-found");
  }, 120_000);

  it("clean: the route taken succeeds, with no no-route-found", async () => {
    const r = await replay("clean", (call) => (call < 3 ? [click("Publish report"), click("Q3 sales report"), click("Reports")] : [{ op: "done" }]), 0.9);
    expect(r.outcome).toBe("succeeded");
    expect(r.run.failure).toBeUndefined();
  }, 120_000);
});
