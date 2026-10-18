import { describe, expect, it } from "vitest";
import type { Assertion, OutcomeCheck, RecordedStep } from "@jevitate/recording";
import { JourneySchema } from "./journey.js";

/**
 * #562/#565 — a Journey whose assertion names something its run never binds where it is checked is
 * refused at load: not a declared parameter, not an earlier `extract` output, not `setup.x`; and a
 * secret parameter is never allowed.
 */

const target = { testId: "out" };
const open: RecordedStep = { step: { kind: "navigate", url: "/", expect: { kind: "visible", target } } };
const extractCode: RecordedStep = { step: { kind: "extract", target, as: "code", expect: { kind: "visible", target } } };
const clickExpecting = (expect: Assertion): RecordedStep => ({ step: { kind: "click", target, expect } });

function journey(o: { steps: RecordedStep[]; params?: string[]; parameters?: { name: string; secret?: boolean }[]; endState?: OutcomeCheck[] }): unknown {
  return {
    metadata: {
      id: "j",
      name: "J",
      promoted: false,
      params: o.params ?? [],
      createdAtIso: "2026-10-17T00:00:00.000Z",
      ...(o.parameters === undefined ? {} : { parameters: o.parameters }),
      ...(o.endState === undefined ? {} : { endState: o.endState }),
    },
    recording: { version: "1", site: "http://127.0.0.1:1", pages: [{ url: "/", steps: o.steps }] },
  };
}

const parses = (j: unknown): boolean => JourneySchema.safeParse(j).success;

describe("Journey assertion references", () => {
  it("accepts a step expect naming a declared param", () => {
    expect(parses(journey({ params: ["email"], steps: [open, clickExpecting({ kind: "valueEquals", target, value: { var: "email" } })] }))).toBe(true);
  });

  it("refuses a step expect naming an undeclared param", () => {
    expect(parses(journey({ steps: [open, clickExpecting({ kind: "textIncludes", target, text: "Hi ${invitee}" })] }))).toBe(false);
  });

  it("accepts a step expect naming an earlier extract output", () => {
    expect(parses(journey({ steps: [open, extractCode, clickExpecting({ kind: "valueEquals", target, value: { var: "code" } })] }))).toBe(true);
  });

  it("refuses a step expect naming an extract output bound only by a later step", () => {
    expect(parses(journey({ steps: [open, clickExpecting({ kind: "valueEquals", target, value: { var: "code" } }), extractCode] }))).toBe(false);
  });

  it("refuses an assertion naming a secret parameter", () => {
    expect(parses(journey({ parameters: [{ name: "pin", secret: true }], steps: [open, clickExpecting({ kind: "textIncludes", target, text: "${pin}" })] }))).toBe(false);
  });

  // #562/#565 follow-up: an extract output whose name reads as a credential is a secret.
  it("refuses a step expect naming a credential-named extract output", () => {
    const extractKey: RecordedStep = { step: { kind: "extract", target, as: "apiKey", expect: { kind: "visible", target } } };
    expect(parses(journey({ steps: [open, extractKey, clickExpecting({ kind: "textIncludes", target, text: "${apiKey}" })] }))).toBe(false);
  });

  it("refuses an end-state check naming a credential-named extract output", () => {
    const extractToken: RecordedStep = { step: { kind: "extract", target, as: "sessionToken", expect: { kind: "visible", target } } };
    const j = journey({ steps: [open, extractToken], endState: [{ kind: "page", assertion: { kind: "valueEquals", target, value: { var: "sessionToken" } } }] });
    const r = JourneySchema.safeParse(j);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("E_ASSERTION_REF_SECRET");
  });

  it("accepts an end-state check naming a setup output", () => {
    expect(parses(journey({ steps: [open], endState: [{ kind: "page", assertion: { kind: "textIncludes", target, text: "${setup.user}" } }] }))).toBe(true);
  });

  it("refuses an end-state check naming an undeclared param", () => {
    expect(parses(journey({ steps: [open], endState: [{ kind: "reloadThen", assertion: { kind: "attr", target, name: "data-who", value: { var: "who" } } }] }))).toBe(false);
  });
});
