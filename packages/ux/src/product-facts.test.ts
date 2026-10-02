import { describe, expect, it } from "vitest";
import { ProductFactsError, factsPageFor, findFactConflicts, journeysFor, namesStep, parseProductFacts, parseProductFactsText, routeMatches } from "./product-facts.js";

const FACTS = parseProductFacts({
  version: 1,
  product: "Example",
  plans: [
    { name: "Starter", prices: [{ amount: 29, interval: "month" }, { amount: 290, interval: "year" }], trialDays: 14 },
    { name: "Pro", aliases: ["Professional"], prices: [{ amount: 149, interval: "month" }, { amount: 1490, interval: "year" }], trialDays: 14 },
  ],
  journeys: [{ name: "Start a project", routes: ["/onboarding", "/projects/:id"] }],
  pages: [{ route: "/onboarding", nextStep: "Create project", alternatives: ["Import", "Skip for now"] }],
});

describe("product facts — format and typed refusals", () => {
  it("defaults the currency and the optional lists", () => {
    const f = parseProductFacts({ version: 1 });
    expect(f).toEqual({ version: 1, currency: "USD", plans: [], journeys: [], pages: [] });
  });

  it("refuses an unknown key, a bad version, a negative price and a route without a slash — every problem, with its path", () => {
    let err: unknown;
    try {
      parseProductFacts({ version: 2, plans: [{ name: "Pro", prices: [{ amount: -1, interval: "month" }] }], pages: [{ route: "pricing", nextStep: "Buy" }], extra: true }, "facts.json");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProductFactsError);
    const e = err as ProductFactsError;
    expect(e.code).toBe("E_UX_PRODUCT_INPUT");
    expect(e.message).toContain("facts.json");
    const text = e.issues.join("\n");
    expect(text).toMatch(/^version:/m);
    expect(text).toMatch(/plans\[0\]\.prices\[0\]\.amount:/);
    expect(text).toMatch(/pages\[0\]\.route:/);
    expect(text).toMatch(/extra/);
  });

  it("refuses a plan name reused as another plan's alias, and a page route described twice", () => {
    expect(() =>
      parseProductFacts({
        version: 1,
        plans: [
          { name: "Pro", prices: [{ amount: 1, interval: "month" }] },
          { name: "Team", aliases: ["pro"], prices: [{ amount: 2, interval: "month" }] },
        ],
        pages: [
          { route: "/a", nextStep: "Go" },
          { route: "/a", nextStep: "Again" },
        ],
      }),
    ).toThrow(/plans\[1\]\.name: plan name\/alias "pro" is already used by plans\[0\].*pages\[1\]\.route/);
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseProductFactsText("{nope", "x.json")).toThrow(ProductFactsError);
  });
});

describe("product facts — matching", () => {
  it("matches routes with :param and * segments", () => {
    expect(routeMatches("/projects/:id", "/projects/:id")).toBe(true);
    expect(routeMatches("/projects/*", "/projects/settings")).toBe(true);
    expect(routeMatches("/projects/:id", "/projects")).toBe(false);
    expect(factsPageFor(FACTS, "/onboarding")?.nextStep).toBe("Create project");
    expect(factsPageFor(FACTS, "/other")).toBeUndefined();
    expect(journeysFor(FACTS, "/projects/:id")).toEqual(["Start a project"]);
  });

  it("names a step by normalized containment", () => {
    expect(namesStep("Create project", "Create project")).toBe(true);
    expect(namesStep("+ Create project", "create project")).toBe(true);
    expect(namesStep("Import", "Create project")).toBe(false);
  });
});

describe("product facts — fact conflicts found by code", () => {
  it("catches a wrong plan price and passes the correct one, a saving and a former price", () => {
    const text = ["Pricing", "Starter $29/month", "Pro $129/month", "Save $240 a year with annual billing", "Was $199, now $149"].join("\n");
    const conflicts = findFactConflicts(text, FACTS);
    expect(conflicts).toEqual([{ kind: "price", plan: "Pro", quote: "Pro $129/month", found: "$129/month", expected: "$149/month" }]);
  });

  it("attributes a price under a plan heading on its own line (a pricing card)", () => {
    const text = ["Professional", "For growing teams", "$99 / month", "Starter", "$29 per month"].join("\n");
    expect(findFactConflicts(text, FACTS).map((c) => [c.plan, c.found])).toEqual([["Pro", "$99/month"]]);
  });

  it("an amount matching any listed price of the plan is consistent (annual vs monthly)", () => {
    expect(findFactConflicts("Pro $1,490 per year", FACTS)).toEqual([]);
    expect(findFactConflicts("Raise Pro to $149", FACTS)).toEqual([]);
    expect(findFactConflicts("Raise Pro to $159", FACTS)).toHaveLength(1);
  });

  it("an amount in a currency the facts do not price in is not comparable", () => {
    expect(findFactConflicts("Pro €139/month", FACTS)).toEqual([]);
  });

  it("catches a wrong trial length", () => {
    expect(findFactConflicts("Start your 7-day free trial of Pro", FACTS)).toEqual([
      { kind: "trial", quote: "Start your 7-day free trial of Pro", found: "7-day trial", expected: "14-day trial" },
    ]);
    expect(findFactConflicts("14-day free trial, no card needed", FACTS)).toEqual([]);
  });

  it("finds nothing without facts", () => {
    expect(findFactConflicts("Pro $1", undefined)).toEqual([]);
  });
});
