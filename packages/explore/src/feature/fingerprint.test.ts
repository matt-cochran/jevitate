import { describe, expect, test } from "vitest";
import { stateFingerprint, actionKey } from "./fingerprint.js";
import type { Snapshot, Control } from "../snapshot.js";

// NOTE (deviation from plan Task 1): the real shipped `Control` (packages/
// explore/src/snapshot.ts) has NO `visible`/`value` fields and its `role`/
// `name` are required strings (only visible, describable controls survive a
// snapshot). The plan's assumed `{ visible, value, role?, name? }` shape does
// not exist, so this builder mirrors the real one.
function control(over: Partial<Control>): Control {
  return {
    index: 0,
    descriptor: { role: over.role ?? "link", name: over.name ?? "x" },
    stability: "high",
    role: "link",
    name: "x",
    tag: "a",
    inputType: null,
    enabled: true,
    summary: "",
    ...over,
  };
}

function snap(url: string, controls: Control[]): Snapshot {
  return { url, controls, truncated: false, signature: "s" };
}

describe("stateFingerprint", () => {
  test("is stable regardless of control order", () => {
    const a = snap("https://x.test/inbox", [control({ name: "t-1" }), control({ name: "t-2" })]);
    const b = snap("https://x.test/inbox", [control({ name: "t-2" }), control({ name: "t-1" })]);
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
  });

  test("differs when the url differs", () => {
    const a = snap("https://x.test/inbox", []);
    const b = snap("https://x.test/thread/t-1", []);
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });

  // Ticket #2 ruling: fingerprints must NOT template id-like path segments
  // (as ticket #3 does via urlTemplate). #2's acceptance ("multiple valid
  // routes") requires /thread/1 and /thread/2 to be DISTINCT reachable states.
  test("distinguishes two concrete ids under the same route (distinct routes)", () => {
    const a = snap("https://x.test/thread/1", []);
    const b = snap("https://x.test/thread/2", []);
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });
});

describe("actionKey", () => {
  test("is stable and op-discriminating", () => {
    const c = control({ name: "t-1" });
    expect(actionKey("fp", c, "click")).toBe(actionKey("fp", c, "click"));
    expect(actionKey("fp", c, "click")).not.toBe(actionKey("fp", c, "type"));
  });
});
