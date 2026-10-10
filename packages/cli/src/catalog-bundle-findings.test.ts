import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { runFromMissionResult, runFromUxReport } from "@jevitate/findings";
import type { Journey } from "@jevitate/journey";
import type { TargetDescriptor } from "@jevitate/recording";
import { bundleFindings, locatorFindings, type BundleFindings } from "./catalog-bundle-findings.js";
import { exportCatalogBundle } from "./catalog-bundle-api.js";
import type { CatalogJourney } from "./catalog.js";
import type { GitExec } from "./change-context.js";

/**
 * #464 (d464c): the machine findings a Journeeze catalog bundle carries (catalog-bundle-v1.md §4.4
 * @ 61f8c92), from what the runs persisted. Checked against the pinned schema and fixture cases in
 * `test-fixtures/catalog-bundle/`.
 */

const FIXTURES = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const SAMPLE = join(FIXTURES, "catalog-bundle", "sample-project");
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
const validate = new Ajv({ allErrors: true, strict: false }).compile(readJson(join(FIXTURES, "catalog-bundle.v1.json")));
const fixtureCase = (name: string): any => readJson(join(FIXTURES, "catalog-bundle", "cases", `${name}.json`));
const sha16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

const STAMP = "2026-10-09T12-00-00-000Z";
const uxFinding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rubricItemId: "nielsen-1",
  citation: { source: "nielsen", ref: "nielsen-1" },
  severity: "minor",
  confidence: 0.72,
  observation: "Nothing on the item changes after the Broken button is pressed",
  userImpact: "The reviewer cannot tell whether the verdict was saved",
  recommendation: "Show the recorded verdict on the item right after the click",
  route: "/board",
  controls: ['button "Broken"'],
  quotes: ["Ana's board"],
  claim: { type: "no-feedback", source: "friction", verifiedBy: "friction:retry@4-5", verification: "ok" },
  ...over,
});
function fromUx(findings: Array<Record<string, unknown>>, stamp = STAMP): BundleFindings {
  const report = { headline: "h", findings };
  const run = runFromUxReport(`/logs/usability-${stamp}.json`, report);
  if (run === null) throw new Error("not a UX report");
  return bundleFindings({ runs: [], uxReports: [{ report, run }] });
}
const defectResult = (defect: Record<string, unknown>, list: "defects" | "hangs" = "defects"): unknown => ({
  missionOutcome: "defects-found",
  result: { strategy: "adversarial", startedAt: "2026-10-09T12:41:00.000Z", targetBuild: "592a7021c4f0", defects: [], hangs: [], [list]: [defect] },
});
function fromDefect(defect: Record<string, unknown>, list: "defects" | "hangs" = "defects"): BundleFindings {
  const run = runFromMissionResult(`/logs/adversarial-${STAMP}.result.json`, defectResult(defect, list));
  if (run === null) throw new Error("not a mission result");
  return bundleFindings({ runs: [run], uxReports: [] });
}
const saveDefect = {
  fingerprint: "3fa2c1d09b7e4a55",
  kind: "http-5xx",
  title: "Saving a verdict twice in quick succession returns a server error",
  url: "https://app.test/board/123456?item=7",
  repro: { recordingStepIndex: 2, steps: [{ target: 'button "Broken"', tflowId: "item.verdict.broken" }] },
};

describe("UX findings", () => {
  it("carry the contract's derived fingerprint over claim, route and element", () => {
    expect(fromUx([uxFinding({ controls: ['button "Save"', 'link "Back"'] })]).findings[0]?.fingerprint).toBe(sha16('ux\nno-feedback\n/board\nbutton "Save"\nlink "Back"'));
  });

  it("derive the fingerprint from the tflowId, not the controls, when the finding names one", () => {
    expect(fromUx([uxFinding({ tflowId: "item.verdict.broken" })]).findings[0]?.fingerprint).toBe("5b7e448babe54616");
  });

  it("send a claim type the contract does not know as other + producerClaim", () => {
    expect(fromUx([uxFinding({ claim: undefined, rubricItemId: "primary-action" })]).findings[0]).toMatchObject({ claim: "other", producerClaim: "primary-action" });
  });

  it("never export on-screen quotes", () => {
    expect(fromUx([uxFinding()]).findings[0]).not.toHaveProperty("quotes");
  });

  it(`template a route with a query (${fixtureCase("route-with-query").description})`, () => {
    expect(fromUx([uxFinding({ route: fixtureCase("route-with-query").patch[0].value })]).findings[0]?.route).toBe("/board");
  });

  it("are left out when their route cannot be a template", () => {
    expect(fromUx([uxFinding({ route: "/my board" })]).findings).toEqual([]);
  });

  it(`are left out when their text carries personal data (${fixtureCase("personal-data-in-finding").description})`, () => {
    expect(fromUx([uxFinding({ observation: fixtureCase("personal-data-in-finding").patch[0].value })]).findings).toEqual([]);
  });

  it("are left out with a warning that never repeats the personal data", () => {
    expect(fromUx([uxFinding({ observation: fixtureCase("personal-data-in-finding").patch[0].value })]).warnings.join("\n")).not.toContain("@example.com");
  });

  it("are one per fingerprint, the latest sighting kept", () => {
    const source = (stamp: string, severity: string) => {
      const report = { headline: "h", findings: [uxFinding({ severity })] };
      return { report, run: runFromUxReport(`/l/usability-${stamp}.json`, report)! };
    };
    const both = bundleFindings({ runs: [], uxReports: [source(STAMP, "minor"), source("2026-10-08T12-00-00-000Z", "major")] });
    expect(both.findings.map((f) => f.severity)).toEqual(["minor"]);
  });
});

describe("defects and hangs", () => {
  it("keep jevitate's fingerprint", () => {
    expect(fromDefect(saveDefect).findings[0]?.fingerprint).toBe("3fa2c1d09b7e4a55");
  });

  it("carry the acting step's tflowId", () => {
    expect(fromDefect(saveDefect).findings[0]?.tflowId).toBe("item.verdict.broken");
  });

  it("carry the route as a template (no query, no record id)", () => {
    expect(fromDefect(saveDefect).findings[0]?.route).toBe("/board/{id}");
  });

  it("are described by signal and route when their own title cannot travel", () => {
    expect(fromDefect({ ...saveDefect, title: "500 for ana@example.com" }).findings[0]?.observation).toBe("Defect (http-5xx) on /board/{id}");
  });

  it("export a hang as kind hang", () => {
    expect(fromDefect({ fingerprint: "aa11bb22cc33dd44", title: "The save spinner never stops", route: "/board" }, "hangs").findings[0]?.kind).toBe("hang");
  });

  it("leave advisory findings out (not a bundle finding kind)", () => {
    expect(fromDefect({ ...saveDefect, advisory: true }).findings).toEqual([]);
  });
});

describe("locator findings (#470 into the bundle)", () => {
  const CONVENTION = ["data-testid", "data-test"] as const;
  const APPROVAL_AT = "2026-10-09T14:00:00.000Z";

  function journeyOf(id: string, targets: readonly TargetDescriptor[], route = "/contacts/new", at = APPROVAL_AT): CatalogJourney {
    const journey = {
      metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-10-09T12:00:00.000Z" },
      recording: {
        version: "1",
        site: "https://app.test",
        pages: [{ url: route, steps: targets.map((target, i) => ({ stepId: `s-${i}`, step: { kind: "click" as const, target, expect: { kind: "visible" as const, target: { role: "heading", name: "Contacts" } } } })) }],
      },
    } as unknown as Journey;
    return { id, name: id, promoted: true, journey, approval: { contentHash: "a".repeat(64), at }, contentHash: "b".repeat(64), changedSinceApproval: false };
  }

  it("a brittle step yields one finding with producerClaim locator-brittle", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }])], CONVENTION);
    expect(r.findings.map((f) => f.producerClaim)).toEqual(["locator-brittle"]);
  });

  it("a journey whose steps are all test-id located yields no locator finding", () => {
    const r = locatorFindings([journeyOf("j", [{ testId: "save-contact", testIdAttr: "data-testid" }])], CONVENTION);
    expect(r.findings).toEqual([]);
  });

  it("two steps in two journeys using the same brittle element yield one finding with two steps", () => {
    const r = locatorFindings([journeyOf("j1", [{ role: "button", name: "Save" }]), journeyOf("j2", [{ role: "button", name: "Save" }])], CONVENTION);
    expect(r.findings[0]?.locator?.steps).toBe(2);
  });

  it("derive the fingerprint over the route template and the key without its route prefix", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }], "/contacts/new")], CONVENTION);
    expect(r.findings[0]?.fingerprint).toBe("19a32c2bd2f73f51");
  });

  it("the same journeys exported twice give identical locator findings", () => {
    const journeys = [journeyOf("j", [{ role: "button", name: "Save" }])];
    expect(locatorFindings(journeys, CONVENTION).findings).toEqual(locatorFindings(journeys, CONVENTION).findings);
  });

  it("name the element and route in the observation and the fix as the recommendation", () => {
    const f = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }], "/contacts/new")], CONVENTION).findings[0]!;
    expect([f.observation, f.recommendation]).toEqual(['the "Save" button on /contacts/new is found by a brittle locator (no test id)', 'add data-testid="save-contact" to the "Save" button on /contacts/new']);
  });

  it("leave out a locator finding whose element names a record id", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "link", name: "Order 48213377" }])], CONVENTION);
    expect(r.findings).toEqual([]);
  });

  it("leave out a locator finding whose page has no route", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }], "")], CONVENTION);
    expect(r.findings).toEqual([]);
  });

  it("drop a locator finding whose route cannot be templated", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }], "/my board")], CONVENTION);
    expect(r.findings).toEqual([]);
  });

  it("warn when a locator finding's route cannot be templated", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }], "/my board")], CONVENTION);
    expect(r.warnings).toContainEqual(expect.stringMatching(/route/));
  });

  it("drop a locator finding whose element carries personal data", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "ana@example.com" }])], CONVENTION);
    expect(r.findings).toEqual([]);
  });

  it("warn without repeating the personal data when a locator finding is dropped", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "ana@example.com" }])], CONVENTION);
    expect(r.warnings.join("\n")).not.toContain("@example.com");
  });

  it("name the page in the fix by its route template, never its record id", () => {
    const r = locatorFindings([journeyOf("j", [{ role: "button", name: "Save" }], "/contacts/4821/edit")], CONVENTION);
    expect(r.findings[0]?.recommendation).toContain("on /contacts/{id}/edit");
  });

  it("date the finding at the latest approval of the journeys it occurs in", () => {
    const r = locatorFindings([journeyOf("j1", [{ role: "button", name: "Save" }], "/contacts/new", "2026-10-08T09:00:00.000Z"), journeyOf("j2", [{ role: "button", name: "Save" }], "/contacts/new", "2026-10-09T14:00:00.000Z")], CONVENTION);
    expect(r.findings[0]?.at).toBe("2026-10-09T14:00:00.000Z");
  });
});

describe("the exported bundle", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fakeGit: GitExec = async (args) => ({ stdout: args[0] === "rev-parse" ? "592a7021c4f0be9d3a8e6b1f2c7d4e5a6b7c8d9e\n" : "" });

  it("collects the project's findings by default and validates against the pinned schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-bundle-findings-"));
    dirs.push(root);
    cpSync(SAMPLE, root, { recursive: true });
    const logs = join(root, ".jevitate", "logs", "2026-10-09");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `usability-${STAMP}.json`), JSON.stringify({ headline: "h", findings: [uxFinding(), uxFinding({ observation: "Saving fails for ana@example.com", route: "/other" })] }));
    writeFileSync(join(logs, `adversarial-${STAMP}.result.json`), JSON.stringify(defectResult(saveDefect)));
    const result = await exportCatalogBundle(
      { format: "journeeze-bundle", catalogDir: join(root, ".jevitate"), journeysDir: join(root, ".jevitate", "journeys"), outDir: join(root, "out") },
      { git: fakeGit, version: () => "0.10.0" },
    );
    const bundle = readJson(result.bundlePath);
    expect({ findings: bundle.findings.length, valid: validate(bundle), errors: validate.errors ?? null }).toEqual({ findings: 2, valid: true, errors: null });
  });
});
