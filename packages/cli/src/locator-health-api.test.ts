import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { TargetDescriptor } from "@jevitate/recording";
import { locatorHealth, renderLocatorHealth, runLocatorHealth } from "./locator-health-api.js";
import { ProjectConfigError } from "./project-config.js";
import { journeyResultRecord } from "./journey-result-record.js";

/** #470: `jevitate locator-health` / MCP `locator_health` over stored Journeys, a run result and a baseline. */

const heading = { kind: "visible" as const, target: { role: "heading", name: "Contacts" } };

function journey(id: string, targets: readonly TargetDescriptor[], promoted = true): Journey {
  return {
    metadata: { id, name: id, promoted, params: [], createdAtIso: "2026-10-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: "https://app.test",
      pages: [{ url: "/contacts/new", steps: targets.map((target, i) => ({ stepId: `s-${i}`, step: { kind: "click" as const, target, expect: heading } })) }],
    },
  };
}

const publish: TargetDescriptor = { role: "button", name: "Publish", anchor: { id: "publish" } };
const save: TargetDescriptor = { testId: "save", testIdAttr: "data-cy" };

let root: string;
let journeysDir: string;
let projectDir: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jev-locator-health-api-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, "project");
  mkdirSync(projectDir);
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("contacts", [save, publish]));
  await store.put(journey("drafts", [publish]));
  await store.put(journey("unpromoted", [publish], false));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeJson(name: string, body: unknown): string {
  const p = join(root, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("locatorHealth", () => {
  it("covers every promoted Journey by default", async () => {
    const r = await locatorHealth({ journeysDir, projectDir: null });
    expect(r.journeys.map((j) => j.id)).toEqual(["contacts", "drafts"]);
  });

  it("de-duplicates an element used by two Journeys into one fix", async () => {
    const r = await locatorHealth({ journeysDir, projectDir: null });
    expect(r.suggestions.find((s) => s.name === "Publish")?.occurrences.map((o) => o.journeyId)).toEqual(["contacts", "drafts"]);
  });

  it("a data-cy test id is brittle under the default convention", async () => {
    const r = await locatorHealth({ journeysDir, projectDir: null, journeyId: "contacts" });
    expect(r.journeys[0]?.health.steps[0]?.reasons).toContain("test id attribute is not in the convention");
  });

  it("a data-cy test id is stable once the project config lists data-cy", async () => {
    writeFileSync(join(projectDir, "project.json"), JSON.stringify({ testIdAttributes: ["data-testid", "data-cy"] }));
    const r = await locatorHealth({ journeysDir, projectDir, journeyId: "contacts" });
    rmSync(join(projectDir, "project.json"));
    expect(r.journeys[0]?.health.steps[0]?.stability).toBe("stable");
  });

  it("a project config naming data-tflow-id is refused", async () => {
    writeFileSync(join(projectDir, "project.json"), JSON.stringify({ testIdAttributes: ["data-tflow-id"] }));
    const outcome = await locatorHealth({ journeysDir, projectDir }).catch((err: unknown) => err);
    rmSync(join(projectDir, "project.json"));
    expect(outcome).toBeInstanceOf(ProjectConfigError);
  });

  it("a run result reports the rung each step actually resolved by", async () => {
    const run = writeJson("run.result.json", { result: { mode: "journey", journeyId: "drafts", resolved: [{ index: 0, stepId: "s-0", rung: "role+name" }] } });
    const r = await locatorHealth({ journeysDir, projectDir: null, runResult: run });
    expect(r.journeys[0]?.health.steps.map((s) => [s.source, s.rung])).toEqual([["resolved", "role+name"]]);
  });

  it("reports the trend against a previous report", async () => {
    const before = await locatorHealth({ journeysDir, projectDir: null, journeyId: "contacts" });
    const baseline = writeJson("baseline.json", { v: 1, ok: true, data: before });
    writeFileSync(join(projectDir, "project.json"), JSON.stringify({ testIdAttributes: ["data-testid", "data-cy"] }));
    const after = await locatorHealth({ journeysDir, projectDir, journeyId: "contacts", baseline });
    rmSync(join(projectDir, "project.json"));
    expect(after.trend).toMatchObject({ improved: 1, regressed: 0, brittleDelta: -1 });
  });

  it("the human rendering leads the work list with the fix", async () => {
    const r = await locatorHealth({ journeysDir, projectDir: null, journeyId: "drafts" });
    expect(renderLocatorHealth(r)).toContain('  - add data-testid="publish-contact" to the "Publish" button on /contacts/new  [1 step(s): no test id]');
  });
});

describe("runLocatorHealth (result.json)", () => {
  it("carries the one-line summary of the run", () => {
    expect(runLocatorHealth(journey("x", [publish]), undefined, ["data-testid"])?.line).toBe("0/1 steps on stable locators; 1 brittle (high 0 · medium 1 · low 0)");
  });
});

describe("a Journey run's result.json", () => {
  it("records each step's resolution and the run's locator health", () => {
    const record = journeyResultRecord(
      { outcome: "ok", output: null, resolved: [{ index: 0, stepId: "s-0", rung: "role+name" }] },
      { journey: journey("drafts", [publish]), params: {}, startedAt: "2026-10-09T00:00:00.000Z", testIdAttributes: ["data-testid"] },
    );
    expect(record.result.locatorHealth).toMatchObject({ stable: 0, brittle: 1, steps: [{ index: 0, rung: "role+name", stability: "brittle" }] });
  });
});
