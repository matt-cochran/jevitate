import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FakeGenerationGateway, type JudgmentState } from "@jevitate/ai-core";
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
async function replay(caseId: string, prefs: (call: number, state: JudgmentState) => readonly Preference[], met = 0.1): Promise<GoalBasedResult> {
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

/**
 * rc-030b no-route-absent-feature r0, decision by decision: nav links only, giving up (`null`) between
 * them while return-to-start moves it back; never an invoice, the profile or the team page.
 */
const NAV_ONLY: ReadonlyArray<string | null> = ["Invoices", "Settings", "Invoices", null, "Pinecrest Books", "Customers", "Invoices", null, "Settings", null, "Pinecrest Books", "Customers", "Invoices"];
/** What the floor steer names after NAV_ONLY: the invoice pages, profile and team. */
const LEAVES = ["INV-1024", "Invoices", "INV-1042", "Invoices", "INV-1057", "Settings", "Profile", "Settings", "Team"];
/** A model that tours `first` (`null`: gives up) and gives up; once the floor steer is in its history, tours `then`. */
const steered = (first: ReadonlyArray<string | null>, then: readonly string[]) => {
  let i = 0;
  let j = 0;
  return (_call: number, state: { readonly history: readonly string[] }): readonly Preference[] => {
    if (!state.history.some((h) => h.startsWith("blocked deferred (1/3)"))) {
      const name = i < first.length ? first[i++] : null;
      return name === null || name === undefined ? [] : [click(name)];
    }
    return j < then.length ? [click(then[j++]!)] : [];
  };
};

describe("rc-030b nav lab, served: a give-up below the floor is steered to what is left, then the floor decides", () => {
  const CASES: Array<{ id: string; first: ReadonlyArray<string | null>; then: readonly string[]; pages: readonly string[] }> = [
    { id: "no-route-absent-feature", first: NAV_ONLY, then: LEAVES, pages: ["/invoices/1057", "/settings/team"] },
    { id: "no-route-removed-link", first: NAV_ONLY, then: LEAVES, pages: ["/invoices/1024", "/settings/profile"] },
    { id: "wall-role-hidden", first: NAV_ONLY, then: LEAVES, pages: ["/invoices/1042", "/settings/team"] },
    // rc-030b large-no-route r3/r4/r5/r9: gave up on the directory, having opened no customer.
    { id: "large-no-route", first: ["Customer directory"], then: ["Customer 1", "Next customer", "Next customer"], pages: ["/customer/1", "/customer/3"] },
  ];
  for (const c of CASES) {
    it(`${c.id}: the rc-030b give-up is deferred toward the unopened pages and ends no-route-found (exit 2)`, async () => {
      const r = await replay(c.id, steered(c.first, c.then));
      expect(r.run.failure?.kind, r.reason).toBe("no-route-found");
      expect(reasonOf(r)).toBe("no-route-found");
      expect(MISSION_EXIT_CODES[goalMissionOutcome(r.outcome, "none")]).toBe(2);
      expect(r.run.noRouteShortfall).toBeUndefined();
      for (const p of c.pages) expect(r.reason).toContain(p);
      expect(r.run.transcript.some((t) => /blocked deferred \(1\/3\): the run has not covered what it can reach yet/.test(t.reason ?? ""))).toBe(true);
    }, 120_000);
  }

  it("a model that ignores the steer ends as before (blocked, exit 1), and the result names the floor's shortfall", async () => {
    const r = await replay("no-route-absent-feature", steered(NAV_ONLY, []));
    expect(r.outcome).toBe("blocked");
    expect(r.run.failure).toBeUndefined();
    expect(r.run.noRouteShortfall).toMatch(/"INV-1024" on \/invoices leads to a page not opened/);
  }, 120_000);
});

describe("#807 nav lab, served: a reachable goal never reads no-route-found", () => {
  it("hover-menu-span: the route is a link the page hides in a hover menu, so the floor is not met even after every visible control", async () => {
    const r = await replay("hover-menu-span", tour(APP_TOUR));
    expect(r.run.failure?.kind).not.toBe("no-route-found");
    expect(reasonOf(r)).not.toBe("no-route-found");
    expect(r.run.noRouteShortfall).toMatch(/hides a control the run cannot see \("Report library"\)/);
  }, 120_000);

  it("route-hidden-from-model: no steer is given while something clickable is beyond the run, and the shortfall says so", async () => {
    const r = await replay("route-hidden-from-model", steered(NAV_ONLY, LEAVES));
    expect(reasonOf(r)).not.toBe("no-route-found");
    expect(r.run.transcript.some((t) => /blocked deferred \(\d\/3\)/.test(t.reason ?? ""))).toBe(false);
    expect(r.run.noRouteShortfall).toMatch(/shows something clickable the run cannot use/);
  }, 120_000);

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
