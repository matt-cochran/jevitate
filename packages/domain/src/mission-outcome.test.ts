import { describe, expect, it } from "vitest";
import { defectOutcomeOf } from "./mission-outcome.js";

describe("defectOutcomeOf (#421/#423)", () => {
  it("no defects: status none, empty byKind, no advisoryByKind", () => {
    expect(defectOutcomeOf([])).toEqual({ status: "none", byKind: {} });
  });

  it("counts gating defects per kind; advisory ones apart and never setting the status", () => {
    const out = defectOutcomeOf([
      { kind: "server-log" },
      { kind: "server-log" },
      { kind: "http-5xx" },
      { kind: "judgment-flagged-state", advisory: true },
    ]);
    expect(out).toEqual({ status: "defects", byKind: { "server-log": 2, "http-5xx": 1 }, advisoryByKind: { "judgment-flagged-state": 1 } });
    expect(defectOutcomeOf([{ kind: "server-log", advisory: true }])).toEqual({ status: "none", byKind: {}, advisoryByKind: { "server-log": 1 } });
  });
});
