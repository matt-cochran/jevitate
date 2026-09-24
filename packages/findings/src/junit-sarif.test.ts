import { describe, expect, it } from "vitest";
import { consolidate } from "./consolidate.js";
import type { RunRecord } from "./extract.js";
import { findingKey } from "./identity.js";
import { renderJUnit, xmlEscape, type GateCase } from "./junit.js";
import { renderSarif, SARIF_SCHEMA } from "./sarif.js";

const cases: GateCase[] = [
  { suite: "shop", classname: "jevitate.shop.journey", name: "login", timeSec: 1.5, status: "passed", resultPath: "/o/journey-1.result.json" },
  {
    suite: "shop",
    classname: "jevitate.shop.feature",
    name: "invariants",
    timeSec: 2,
    status: "failed",
    type: "invariant",
    message: 'Invariant "a<b" violated on /app',
    detail: "invariant:abc <script>&\u0001",
  },
  { suite: "admin", classname: "jevitate.admin.goal", name: "export", timeSec: 0, status: "error", type: "budget-exceeded", message: "action budget exhausted" },
  { suite: "admin", classname: "jevitate.admin.goal", name: "import", timeSec: 0, status: "skipped", message: "not affected by --changed-routes" },
];

/** A minimal structural read of the XML: every element's name and attributes, in order. */
function elements(xml: string): Array<{ name: string; attrs: Record<string, string> }> {
  const out: Array<{ name: string; attrs: Record<string, string> }> = [];
  for (const m of xml.matchAll(/<([a-z]+)((?:\s+[a-z]+="[^"]*")*)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? "").matchAll(/([a-z]+)="([^"]*)"/g)) attrs[a[1] ?? ""] = a[2] ?? "";
    out.push({ name: m[1] ?? "", attrs });
  }
  return out;
}

describe("JUnit XML (#137)", () => {
  const xml = renderJUnit("jevitate check: ci", cases, "2026-09-24T10:00:00.000Z");

  it("has the JUnit shape: testsuites > testsuite > testcase with consistent counts", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    const els = elements(xml);
    expect(els[0]).toMatchObject({ name: "testsuites", attrs: { tests: "4", failures: "1", errors: "1", skipped: "1", time: "3.500" } });
    const suites = els.filter((e) => e.name === "testsuite");
    expect(suites.map((s) => [s.attrs.name, s.attrs.tests, s.attrs.failures, s.attrs.errors, s.attrs.skipped])).toEqual([
      ["shop", "2", "1", "0", "0"],
      ["admin", "2", "0", "1", "1"],
    ]);
    expect(els.filter((e) => e.name === "testcase").map((e) => e.attrs.name)).toEqual(["login", "invariants", "export", "import"]);
    expect(els.find((e) => e.name === "failure")?.attrs).toEqual({ message: "Invariant &quot;a&lt;b&quot; violated on /app", type: "invariant" });
    expect(els.find((e) => e.name === "error")?.attrs.type).toBe("budget-exceeded");
    expect(els.find((e) => e.name === "property")?.attrs).toEqual({ name: "result", value: "/o/journey-1.result.json" });
    // Balanced: every opened container closes.
    for (const tag of ["testsuites", "testsuite", "failure"]) {
      expect(xml.match(new RegExp(`<${tag}[ >]`, "g"))?.length).toBe(xml.match(new RegExp(`</${tag}>`, "g"))?.length);
    }
  });

  it("escapes markup and strips characters XML 1.0 cannot carry", () => {
    expect(xml).toContain("invariant:abc &lt;script&gt;&amp;</failure>");
    expect(xmlEscape("a\u0001b'")).toBe("ab&apos;");
  });
});

describe("SARIF 2.1.0 (#137)", () => {
  const identity = { category: "invariant", signal: "invariant:charge-implies-delivery", fingerprint: "fpInv", route: "/app", control: "Import" } as const;
  const run: RunRecord = {
    runId: "feature-1",
    mode: "feature",
    path: "/o/feature-1.result.json",
    observations: [
      {
        key: findingKey(identity),
        identity,
        title: 'Invariant "charge-implies-delivery" violated on /app',
        severity: "hard",
        related: ["fpInv"],
        occurrences: 1,
        evidence: [],
        reproduce: "jevitate verify-fix --result /o/feature-1.result.json --fingerprint fpInv",
      },
      {
        key: findingKey({ category: "ux", signal: "labels" }),
        identity: { category: "ux", signal: "labels" },
        title: "labels",
        severity: "advisory",
        related: [],
        occurrences: 1,
        evidence: [],
      },
    ],
  };
  const [inv, ux] = consolidate([run]);
  const log = renderSarif({
    toolVersion: "0.1.0",
    engineCommit: "abc1234",
    targetBuild: "build-7",
    suiteUri: "ci/jevitate-suite.json",
    automationId: "jevitate-check/ci/",
    findings: [
      ...(inv === undefined ? [] : [{ defect: inv, gating: true, status: "new" as const }]),
      ...(ux === undefined ? [] : [{ defect: ux, gating: false }]),
    ],
  });

  it("meets the minimal SARIF 2.1.0 schema expectations code scanning relies on", () => {
    expect(log.$schema).toBe(SARIF_SCHEMA);
    expect(log.version).toBe("2.1.0");
    const r = log.runs[0] as {
      tool: { driver: { name: string; version: string; rules: Array<{ id: string; shortDescription: { text: string } }> } };
      results: Array<{
        ruleId: string;
        level: string;
        message: { text: string };
        locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
        partialFingerprints: Record<string, string>;
      }>;
      properties: Record<string, string>;
    };
    expect(r.tool.driver).toMatchObject({ name: "jevitate", version: "0.1.0" });
    const ruleIds = r.tool.driver.rules.map((x) => x.id);
    expect(ruleIds).toEqual(["jevitate/invariant/invariant:charge-implies-delivery", "jevitate/ux/labels"]);
    for (const res of r.results) {
      expect(ruleIds).toContain(res.ruleId); // every result's rule is declared
      expect(["error", "warning", "note", "none"]).toContain(res.level);
      expect(res.message.text.length).toBeGreaterThan(0);
      expect(res.locations[0]?.physicalLocation.artifactLocation.uri).toBe("ci/jevitate-suite.json");
      expect(res.locations[0]?.physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);
      expect(res.partialFingerprints.jevitateFindingKey).toMatch(/^[a-z-]+:[0-9a-f]{12}$/);
    }
    expect(r.results.map((x) => x.level)).toEqual(["error", "note"]);
    expect(r.results[0]?.message.text).toContain("[new]");
    expect(r.results[0]?.message.text).toContain("reproduce: jevitate verify-fix");
    expect(r.properties).toEqual({ engineCommit: "abc1234", targetBuild: "build-7" });
  });
});
