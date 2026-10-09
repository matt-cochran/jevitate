import { describe, expect, it } from "vitest";
import type { Step } from "@jevitate/recording";
import type { ChangeEvidence, ChangeScope } from "./change-scope.js";
import { explainsBreak, newAnchorsInChange } from "./change-scope-explain.js";

const seen = { kind: "visible", target: { testId: "ok" } } as const;
const scopeOf = (...evidence: ChangeEvidence[]): ChangeScope => ({ evidence, scanned: { files: 1, hunks: 1, skipped: [] } });

describe("explainsBreak (#453, deterministic)", () => {
  it("retargets a renamed test id", () => {
    const step: Step = { kind: "click", target: { testId: "save-btn" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "test-id", before: "save-btn", after: "save" })).candidates.map((c) => c.step)).toEqual([{ ...step, target: { testId: "save" } }]);
  });

  it("matches a label case-insensitively with whitespace normalised", () => {
    const step: Step = { kind: "click", target: { role: "button", name: "Create  New" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "label", before: "create new", after: "Create" })).explained).toBe(true);
  });

  it("retargets a css id token, keeping the rest of the selector", () => {
    const step: Step = { kind: "click", target: { css: "form #old-save.primary" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "test-id", before: "old-save", after: "save" })).candidates[0]?.step).toEqual({ ...step, target: { css: "form #save.primary" } });
  });

  it("retargets a renamed route on a navigate step, keeping its query", () => {
    const step: Step = { kind: "navigate", url: "/settings/profile?tab=1", expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "route", before: "/settings/profile/", after: "/account" })).candidates[0]?.step).toEqual({ ...step, url: "/account?tab=1" });
  });

  it("retargets an anchor on a container", () => {
    const step: Step = { kind: "click", target: { role: "button", name: "Go", container: { testId: "old-panel" } }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "test-id", before: "old-panel", after: "panel" })).candidates[0]?.field).toBe("container.testId");
  });

  it("is explained, with no candidate, by a free-text note that mentions the anchor", () => {
    const step: Step = { kind: "click", target: { role: "button", name: "Create New" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "n1", kind: "note", note: "we reworded the Create New button" }))).toMatchObject({ explained: true, candidates: [] });
  });

  it("does not explain an anchor a note only contains as part of a longer word", () => {
    const step: Step = { kind: "click", target: { role: "button", name: "Save" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "n1", kind: "note", note: "Saved searches moved to the sidebar" })).explained).toBe(false);
  });

  it("never explains a generic anchor by an unpaired note alone", () => {
    const step: Step = { kind: "click", target: { role: "button", name: "OK" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "n1", kind: "note", note: "the OK dialog was reworded" })).explained).toBe(false);
  });

  it("explains an anchor a note names as whole tokens across punctuation", () => {
    const step: Step = { kind: "click", target: { testId: "create-new" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "n1", kind: "note", note: "dropped the Create New test id" })).explained).toBe(true);
  });

  it("never explains a break with inserted-ui evidence (report-only, Q3)", () => {
    const step: Step = { kind: "click", target: { role: "button", name: "Create New" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "inserted-ui", before: "Create New", after: "Confirm" })).explained).toBe(false);
  });

  it("does not let a copy change explain a test id", () => {
    const step: Step = { kind: "click", target: { testId: "save" }, expect: seen };
    expect(explainsBreak(step, scopeOf({ id: "e1", kind: "copy", before: "save", after: "store" })).explained).toBe(false);
  });
});

describe("newAnchorsInChange", () => {
  it("is true only when the candidate's new anchor is some evidence's after", () => {
    const broken: Step = { kind: "click", target: { role: "button", name: "Create New" }, expect: seen };
    const scope = scopeOf({ id: "e1", kind: "label", before: "Create New", after: "Create" });
    expect([newAnchorsInChange(broken, { ...broken, target: { role: "button", name: "Create" } }, scope.evidence), newAnchorsInChange(broken, { ...broken, target: { role: "button", name: "Make" } }, scope.evidence)]).toEqual([true, false]);
  });
});
