import { describe, expect, test } from "vitest";
import type { Control, Snapshot } from "../snapshot.js";
import * as coverage from "./fingerprint.js";
import * as feature from "../feature/fingerprint.js";
import { Frontier as CoverageFrontier } from "./frontier.js";
import { Frontier as FeatureFrontier } from "../feature/frontier.js";

// Ticket #28: the two exploration missions used to ship their OWN copies of the
// fingerprint / frontier / reach logic. After the de-dup the shared pieces live
// only in coverage/, and the feature/ module is a thin adapter that carries the
// SINGLE genuine divergence (concrete-url vs templated-url state identity).

function control(over: Partial<Control>): Control {
  return {
    index: 0,
    descriptor: { role: "button", name: "Reply" },
    stability: "high",
    role: "button",
    name: "Reply",
    tag: "button",
    inputType: null,
    enabled: true,
    summary: 'button "Reply"',
    ...over,
  };
}

function snap(url: string, controls: Control[] = []): Snapshot {
  return { url, controls, truncated: false, signature: "s" };
}

describe("coverage/feature fingerprint de-dup (ticket #28)", () => {
  test("actionKey is ONE shared implementation — identical output from both entry points", () => {
    const c = control({ role: "link", name: "Back" });
    expect(feature.actionKey("fp", c, "click")).toBe(coverage.actionKey("fp", c, "click"));
    expect(feature.actionKey("fp", c, "type")).toBe(coverage.actionKey("fp", c, "type"));
  });

  test("the Frontier work-queue is ONE shared class", () => {
    expect(FeatureFrontier).toBe(CoverageFrontier);
  });

  test("the ONLY divergence is url identity: coverage templates id-like segments, feature keeps them distinct", () => {
    const t1 = snap("https://x.test/thread/1");
    const t2 = snap("https://x.test/thread/2");
    // Coverage (induction) collapses concrete ids to one semantic page…
    expect(coverage.stateFingerprint(t1)).toBe(coverage.stateFingerprint(t2));
    // …while the feature mission keeps the two routes distinct.
    expect(feature.stateFingerprint(t1)).not.toBe(feature.stateFingerprint(t2));
  });

  test("control-table semantics are shared: same route + controls ⇒ order-independent equality in both", () => {
    const a = snap("https://x.test/inbox", [control({ name: "A" }), control({ name: "B" })]);
    const b = snap("https://x.test/inbox", [control({ name: "B" }), control({ name: "A" })]);
    expect(coverage.stateFingerprint(a)).toBe(coverage.stateFingerprint(b));
    expect(feature.stateFingerprint(a)).toBe(feature.stateFingerprint(b));
  });
});
