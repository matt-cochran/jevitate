import { describe, expect, it } from "vitest";
import { StepSchema } from "./schema.js";

/** A `reload` step names no URL: it re-loads whatever page the run is on, then checks `expect`. */
describe("reload step schema", () => {
  it("parses a reload step with its expectation", () => {
    expect(
      StepSchema.safeParse({
        kind: "reload",
        expect: { kind: "urlIncludes", text: "?id=" },
      }).success,
    ).toBe(true);
  });

  it("rejects a reload step carrying an unknown field", () => {
    expect(
      StepSchema.safeParse({
        kind: "reload",
        url: "/elsewhere",
        expect: { kind: "urlIncludes", text: "?id=" },
      }).success,
    ).toBe(false);
  });
});
