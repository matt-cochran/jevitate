import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOG_CLASS_RULES,
  LogClassesError,
  classifyLogLine,
  loadLogClassRules,
  parseLogClasses,
  withDefaultRules,
} from "./log-classes.js";

/** #422 — `.jevitate/log-classes.json`: strict validation, first match wins, project rules ahead of the defaults. */

const F = "/repo/.jevitate/log-classes.json";
const line = (message: string, over: { source?: string; level?: "error" | "warn" | "info" | "debug" | "unknown" } = {}) => ({
  message,
  source: over.source ?? "docker:api-1",
  level: over.level ?? "error",
});

describe("parseLogClasses (#422): validated strictly, every error naming the file and rule", () => {
  it("accepts a well-formed file, in file order, compiling /re/flags and bare patterns", () => {
    const rules = parseLogClasses(
      {
        version: 1,
        rules: [
          { id: "stripe-test", class: "environment", message: "/no such customer/i" },
          { id: "signup-422", class: "expected-validation", source: "^docker:api", level: "warn", message: "validation failed" },
          { id: "keep", class: "defect", level: "error" },
        ],
      },
      F,
    );
    expect(rules.map((r) => [r.id, r.class])).toEqual([
      ["stripe-test", "environment"],
      ["signup-422", "expected-validation"],
      ["keep", "defect"],
    ]);
    expect(rules[0]?.message?.flags).toBe("i");
    expect(rules[1]?.message?.test("Validation failed")).toBe(false); // a bare pattern is case-sensitive
  });

  const refusals: ReadonlyArray<[string, unknown, RegExp]> = [
    ["not an object", [], /must be a JSON object/],
    ["wrong version", { version: 2, rules: [] }, /"version" must be 1/],
    ["unknown top-level key", { version: 1, rules: [], extra: 1 }, /unknown key "extra"/],
    ["rules not an array", { version: 1, rules: {} }, /"rules" must be an array/],
    ["missing id", { version: 1, rules: [{ class: "environment", message: "x" }] }, /rules\[0\]: "id" must be a non-empty string/],
    ["unknown class", { version: 1, rules: [{ id: "a", class: "noise", message: "x" }] }, /rule "a": unknown class "noise"/],
    ["bad regex", { version: 1, rules: [{ id: "b", class: "environment", message: "/(/" }] }, /rule "b": "message" is not a valid regex/],
    ["g flag", { version: 1, rules: [{ id: "g", class: "environment", message: "/x/g" }] }, /rule "g".*flags are not allowed/],
    ["unknown level", { version: 1, rules: [{ id: "c", class: "environment", level: "fatal" }] }, /rule "c": unknown level "fatal"/],
    ["unknown rule key", { version: 1, rules: [{ id: "d", class: "environment", message: "x", regex: "y" }] }, /rule "d": unknown key "regex"/],
    ["matches everything", { version: 1, rules: [{ id: "e", class: "environment" }] }, /rule "e": needs at least one of/],
    ["duplicate id", { version: 1, rules: [{ id: "f", class: "environment", message: "x" }, { id: "f", class: "defect", message: "y" }] }, /rule "f": duplicate id/],
  ];
  for (const [what, raw, why] of refusals) {
    it(`refuses ${what}`, () => {
      expect(() => parseLogClasses(raw, F)).toThrow(LogClassesError);
      expect(() => parseLogClasses(raw, F)).toThrow(why);
      expect(() => parseLogClasses(raw, F)).toThrow(F);
    });
  }
});

describe("classification (#422): project rules first, then the defaults; first match wins", () => {
  it("the defaults class a missing/invalid credential and a degraded health check as environment", () => {
    const rules = withDefaultRules([]);
    expect(classifyLogLine(rules, line("Incorrect API key provided: sk-***"))?.id).toBe("default:credential");
    expect(classifyLogLine(rules, line("OpenAI provider not configured"))?.class).toBe("environment");
    expect(classifyLogLine(rules, line("Health check 'payments' is Degraded"))?.id).toBe("default:health-check-degraded");
    expect(classifyLogLine(rules, line("duplicate key value violates unique constraint"))).toBeUndefined();
  });

  it("a project rule with a default's id replaces it; an earlier project rule wins over a later default", () => {
    const project = parseLogClasses(
      {
        version: 1,
        rules: [
          { id: "default:credential", class: "defect", message: "/incorrect api key/i" },
          { id: "billing-health", class: "defect", message: "/health check 'billing'/i" },
        ],
      },
      F,
    );
    const rules = withDefaultRules(project);
    expect(rules.filter((r) => r.id === "default:credential")).toHaveLength(1);
    expect(classifyLogLine(rules, line("Incorrect API key provided"))?.class).toBe("defect");
    expect(classifyLogLine(rules, line("Health check 'billing' is Degraded"))?.id).toBe("billing-health");
    expect(classifyLogLine(rules, line("Health check 'mail' is Degraded"))?.id).toBe("default:health-check-degraded");
  });

  it("source and level narrow a rule", () => {
    const rules = parseLogClasses({ version: 1, rules: [{ id: "v", class: "expected-validation", source: "^docker:api", level: "warn", message: "invalid" }] }, F);
    expect(classifyLogLine(rules, line("invalid email", { level: "warn" }))?.id).toBe("v");
    expect(classifyLogLine(rules, line("invalid email", { level: "error" }))).toBeUndefined();
    expect(classifyLogLine(rules, line("invalid email", { level: "warn", source: "file:/var/log/worker.log" }))).toBeUndefined();
  });
});

describe("loadLogClassRules (#422): the project's .jevitate/log-classes.json, found as .jevitate/ is", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const project = (file?: string): { cwd: () => string; homedir: () => string } => {
    dir = mkdtempSync(join(tmpdir(), "jevitate-log-classes-"));
    mkdirSync(join(dir, ".jevitate"));
    mkdirSync(join(dir, "app"));
    if (file !== undefined) writeFileSync(join(dir, ".jevitate", "log-classes.json"), file);
    const root = dir;
    return { cwd: () => join(root, "app"), homedir: () => join(root, "home") };
  };

  it("no file: the defaults only", () => {
    expect(loadLogClassRules(project()).map((r) => r.id)).toEqual(DEFAULT_LOG_CLASS_RULES.map((r) => r.id));
  });

  it("a file: its rules ahead of the defaults", () => {
    const deps = project(JSON.stringify({ version: 1, rules: [{ id: "mine", class: "environment", message: "smtp" }] }));
    expect(loadLogClassRules(deps).map((r) => r.id)).toEqual(["mine", ...DEFAULT_LOG_CLASS_RULES.map((r) => r.id)]);
  });

  it("a malformed file fails closed, naming it", () => {
    const deps = project("{ not json");
    expect(() => loadLogClassRules(deps)).toThrow(LogClassesError);
    expect(() => loadLogClassRules(deps)).toThrow(/log-classes\.json is not valid JSON/);
  });
});
