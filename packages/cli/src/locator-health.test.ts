import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { analyzeRecording, classifyTarget, compareLocatorHealth, dedupeSuggestions, exceedsBrittleSteps, suggestTestId } from "./locator-health.js";
import { brittleStepGate } from "./locator-health-api.js";
import { DEFAULT_TEST_ID_ATTRIBUTES, loadProjectConfig, ProjectConfigError } from "./project-config.js";

/** #470: the pure locator-health core — verdicts, reasons, fixes, de-duplication, trend; and the config. */

const CONVENTION = DEFAULT_TEST_ID_ATTRIBUTES;
const seen = { kind: "visible" as const, target: { role: "heading", name: "Contacts" } };

function recording(targets: readonly TargetDescriptor[], url = "https://app.test/contacts/new"): Recording {
  return { version: "1", site: "https://app.test", pages: [{ url, steps: targets.map((target, i) => ({ stepId: `s-${i}`, step: { kind: "click" as const, target, expect: seen } })) }] };
}

const testIdButton: TargetDescriptor = { testId: "save-contact", testIdAttr: "data-testid" };
const namedButton: TargetDescriptor = { role: "button", name: "Publish" };
const cssOnly: TargetDescriptor = { css: "main > div:nth-of-type(2) > span" };

describe("classifyTarget", () => {
  it("a test id from the convention is stable", () => {
    expect(classifyTarget(testIdButton, CONVENTION).codes).toEqual([]);
  });

  it("a test id from an attribute outside the convention is brittle", () => {
    expect(classifyTarget({ testId: "save", testIdAttr: "data-qa" }, CONVENTION).codes).toContain("test-id-not-in-convention");
  });

  it("a test id from data-cy meets a convention that lists it", () => {
    expect(classifyTarget({ testId: "save", testIdAttr: "data-cy" }, [...CONVENTION, "data-cy"]).codes).toEqual([]);
  });

  it("a generated-looking test id is low", () => {
    expect(classifyTarget({ testId: "row-8f3a91c7" }, CONVENTION).level).toBe("low");
  });

  it("a tflow id alongside a role+name never counts as a test id", () => {
    expect(classifyTarget({ ...namedButton, tflowId: "contact.publish" }, CONVENTION).codes).toContain("tflow-id-not-a-test-id");
  });

  it("a duplicate name needing an ordinal is capped one level", () => {
    expect(classifyTarget({ role: "button", name: "Edit", ordinal: 1 }, CONVENTION).level).toBe("medium");
  });

  it("a positional css path is flagged", () => {
    expect(classifyTarget(cssOnly, CONVENTION).codes).toContain("positional-css");
  });

  it("a text locator is flagged as copy likely to change", () => {
    expect(classifyTarget({ text: "Welcome back" }, CONVENTION).codes).toContain("text-copy");
  });

  it("the rung a run resolved by replaces the recorded one", () => {
    expect(classifyTarget({ ...namedButton, anchor: { id: "publish" } }, CONVENTION, { index: 0, rung: "role+name" }).rung).toBe("role+name");
  });
});

describe("analyzeRecording", () => {
  const health = analyzeRecording(recording([testIdButton, namedButton, cssOnly]), { testIdAttributes: CONVENTION, journeyId: "contacts" });

  it("reports rung and level per step", () => {
    expect(health.steps.map((s) => [s.rung, s.level, s.stability])).toEqual([
      ["testId", "high", "stable"],
      ["role+name", "high", "brittle"],
      ["css", "low", "brittle"],
    ]);
  });

  it("summarises the steps on stable locators", () => {
    expect(health.line).toBe("1/3 steps on stable locators; 2 brittle (high 2 · medium 0 · low 1)");
  });

  it("suggests a test id for the named button, derived from its name and route", () => {
    expect(health.suggestions.find((s) => s.name === "Publish")?.fix).toBe('add data-testid="publish-contact" to the "Publish" button on /contacts/new');
  });

  it("names the css-only element in its suggestion", () => {
    expect(health.suggestions.find((s) => s.key.includes("|css|"))?.element).toBe('the element at css "main > div:nth-of-type(2) > span"');
  });
});

describe("suggestions", () => {
  it("the same element across two runs is one suggestion with both occurrences", () => {
    const a = analyzeRecording(recording([namedButton]), { testIdAttributes: CONVENTION, journeyId: "run-a" });
    const b = analyzeRecording(recording([namedButton]), { testIdAttributes: CONVENTION, journeyId: "run-b" });
    expect(dedupeSuggestions([a.suggestions, b.suggestions]).map((s) => s.occurrences.map((o) => o.journeyId))).toEqual([["run-a", "run-b"]]);
  });

  it("a single-word name takes the route's noun (Save on /contacts/new → save-contact)", () => {
    expect(suggestTestId("Save", "/contacts/new", "button")).toBe("save-contact");
  });
});

describe("trend against a baseline", () => {
  it("a step moved from css to a test id counts as improved", () => {
    const before = analyzeRecording(recording([cssOnly]), { testIdAttributes: CONVENTION });
    const after = analyzeRecording(recording([{ testId: "archive-contact" }]), { testIdAttributes: CONVENTION });
    expect(compareLocatorHealth(after, before)).toMatchObject({ improved: 1, regressed: 0, brittleDelta: -1 });
  });

  it("a step fallen back to text counts as regressed", () => {
    const before = analyzeRecording(recording([testIdButton]), { testIdAttributes: CONVENTION });
    const after = analyzeRecording(recording([{ text: "Save" }]), { testIdAttributes: CONVENTION });
    expect(compareLocatorHealth(after, before).regressed).toBe(1);
  });
});

describe("the opt-in gate", () => {
  it("exceeds only past the threshold", () => {
    expect([exceedsBrittleSteps({ brittle: 2 }, 2), exceedsBrittleSteps({ brittle: 3 }, 2), exceedsBrittleSteps({ brittle: 9 }, undefined)]).toEqual([false, true, false]);
  });

  it("refuses a negative threshold", () => {
    expect(() => brittleStepGate(-1)).toThrow(RangeError);
  });
});

describe("project config testIdAttributes", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-project-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const withConfig = (body: unknown): string => {
    writeFileSync(join(dir, "project.json"), JSON.stringify(body));
    return dir;
  };

  it("defaults to data-testid and data-test without a config", () => {
    expect(loadProjectConfig(null).testIdAttributes).toEqual(["data-testid", "data-test"]);
  });

  it("reads a team's own attributes", () => {
    expect(loadProjectConfig(withConfig({ testIdAttributes: ["data-testid", "data-cy"] })).testIdAttributes).toEqual(["data-testid", "data-cy"]);
  });

  it("refuses data-tflow-id as a test-id attribute", () => {
    expect(() => loadProjectConfig(withConfig({ testIdAttributes: ["data-testid", "data-tflow-id"] }))).toThrow(ProjectConfigError);
  });
});
