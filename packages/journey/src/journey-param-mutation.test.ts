import { describe, it, expect } from "vitest";
import { JourneySchema } from "./index.js";

// #579: `metadata.parameters[].mutationValues` — alternative values a human reviewed as valid but
// WRONG for the parameter. Schema and type only; a later deliverable makes `journey verify --mutate`
// prove an assertion can fail by substituting one.
const journey = (parameter: Record<string, unknown>) => ({
  metadata: {
    id: "j", name: "j", promoted: true, params: [], createdAtIso: "2026-01-01T00:00:00Z",
    parameters: [parameter],
  },
  recording: { version: "1", site: "example", pages: [] },
});

const values = (n: number) => Array.from({ length: n }, (_, i) => `wrong-${i}`);

describe("JourneySchema metadata.parameters[].mutationValues (#579)", () => {
  it("accepts a reviewed alternative value on a parameter", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: ["0"] })).success).toBe(true);
  });

  it("accepts a parameter without mutationValues (additive)", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity" })).success).toBe(true);
  });

  it("accepts the one-entry lower bound", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: values(1) })).success).toBe(true);
  });

  it("accepts the twenty-entry upper bound", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: values(20) })).success).toBe(true);
  });

  it("refuses an empty mutationValues array", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: [] })).success).toBe(false);
  });

  it("refuses a duplicate mutation value", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: ["0", "0"] })).success).toBe(false);
  });

  it("refuses an empty-string mutation value", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: [""] })).success).toBe(false);
  });

  it("refuses a twenty-first mutation value", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: values(21) })).success).toBe(false);
  });

  it("refuses a mutation value longer than 2000 characters", () => {
    expect(JourneySchema.safeParse(journey({ name: "quantity", mutationValues: ["x".repeat(2001)] })).success).toBe(false);
  });

  it("refuses mutationValues on a parameter marked secret", () => {
    expect(JourneySchema.safeParse(journey({ name: "amount", secret: true, mutationValues: ["0"] })).success).toBe(false);
  });

  it("names the parameter and E_MUTATION_VALUES_SECRET when refusing a secret parameter", () => {
    const r = JourneySchema.safeParse(journey({ name: "amount", secret: true, mutationValues: ["0"] }));
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join("\n")).toMatch(/^(?=.*E_MUTATION_VALUES_SECRET)(?=.*amount)/);
  });

  it("refuses mutationValues on a credential-like parameter name", () => {
    expect(JourneySchema.safeParse(journey({ name: "token", mutationValues: ["wrong"] })).success).toBe(false);
  });

  it("names the parameter and E_MUTATION_VALUES_SECRET when refusing a credential-like name", () => {
    const r = JourneySchema.safeParse(journey({ name: "token", mutationValues: ["wrong"] }));
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join("\n")).toMatch(/^(?=.*E_MUTATION_VALUES_SECRET)(?=.*token)/);
  });
});
