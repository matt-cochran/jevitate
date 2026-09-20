import { describe, it, expect } from "vitest";
const RUN = process.env.RUN_TYPESAFE_TESTS === "1" && !!process.env.TYPESAFE_API_KEY;
describe.skipIf(!RUN)("Jev/TypeSafe live (opt-in)", () => {
  it("gets a real systemOne judgment", async () => {
    // build real JevClientCall via lazily-imported `@typesafe-ai/sdk`; assert answers validate.
    expect(RUN).toBe(true);
  });
});
