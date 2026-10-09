import { describe, expect, it } from "vitest";
import { formatMissionHuman, locatorHealthLines } from "./cli-output.js";

/** #470: a run's locator health in the human output — the one-line summary, then the top fixes. */

const health = {
  stable: 1,
  brittle: 2,
  line: "1/3 steps on stable locators; 2 brittle (high 2 · medium 0 · low 1)",
  suggestions: [
    { key: "a", element: 'the "Publish" button', fix: 'add data-testid="publish-contact" to the "Publish" button on /contacts/new', reasons: ["no test id"], steps: 2 },
    { key: "b", element: "the element", fix: 'add data-testid="contacts-div" to the element at css "div" on /contacts/new', reasons: ["no test id"], steps: 1 },
  ],
};

describe("locatorHealthLines", () => {
  it("shows the summary and the top fixes", () => {
    expect(locatorHealthLines(health, 1)).toEqual([
      "LOCATORS 1/3 steps on stable locators; 2 brittle (high 2 · medium 0 · low 1)",
      'FIX     add data-testid="publish-contact" to the "Publish" button on /contacts/new (2 steps)',
      "FIX     … 1 more: jevitate locator-health",
    ]);
  });

  it("shows nothing for a result without locator health", () => {
    expect(locatorHealthLines(undefined)).toEqual([]);
  });

  it("a run's human summary carries the locator line", () => {
    expect(formatMissionHuman({ missionOutcome: "passed", strategy: "journey", locatorHealth: health })).toContain("LOCATORS 1/3 steps on stable locators");
  });
});
