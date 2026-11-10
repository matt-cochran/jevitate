import { describe, expect, it } from "vitest";
import { migrateLabels } from "./journey-labels-migrate-api.js";
import { warnParamNamesOnArgv } from "./regression-cli.js";

const MARKER = "MARKER-s3cret-value";

function expectNamesOnly(lines: string[]): void {
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("password");
  expect(lines[0]).not.toContain(MARKER);
}

describe("secret --param argv warning (#809, #827)", () => {
  it("regression run/capture and verify-fix share the helper: name only", () => {
    const lines: string[] = [];
    warnParamNamesOnArgv((l) => lines.push(l), { password: MARKER, user: "bob" });
    expectNamesOnly(lines);
  });

  it("a non-secret param warns nothing", () => {
    const lines: string[] = [];
    warnParamNamesOnArgv((l) => lines.push(l), { user: "bob" });
    expect(lines).toEqual([]);
  });

  it("journey migrate --labels warns before any replay", async () => {
    const lines: string[] = [];
    await expect(migrateLabels({ journeysDir: "/nonexistent-journeys", ids: ["nope"], params: { password: MARKER }, warn: (l) => lines.push(l) })).rejects.toThrow();
    expectNamesOnly(lines);
  });
});
