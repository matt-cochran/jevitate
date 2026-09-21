import { describe, expect, test } from "vitest";
import { stateFingerprint, actionKey } from "./fingerprint.js";
import type { Snapshot, Control } from "../index.js";

function control(over: Partial<Control> & { role?: string; name?: string }): Control {
  const { role = "", name = "", ...rest } = over;
  return {
    index: 0,
    descriptor: { role: role || undefined, name: name || undefined, css: "x" },
    stability: "high",
    role,
    name,
    tag: "button",
    inputType: null,
    enabled: true,
    summary: `${role} ${name}`.trim(),
    ...rest,
  };
}

function snap(over: Partial<Snapshot>): Snapshot {
  return { url: "https://x.test/", controls: [], truncated: false, signature: "s", ...over };
}

describe("stateFingerprint", () => {
  test("is stable for the same url template + control set, regardless of control order", () => {
    // Digit record ids template to the same `/thread/:id`, so these are the SAME
    // semantic state even though the concrete id differs (spec §7).
    const a = snap({
      url: "https://x.test/thread/1",
      controls: [control({ index: 0, role: "link", name: "Back" }), control({ index: 1, role: "button", name: "Reply" })],
    });
    const b = snap({
      url: "https://x.test/thread/2",
      controls: [control({ index: 1, role: "button", name: "Reply" }), control({ index: 0, role: "link", name: "Back" })],
    });
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
  });

  test("differs when a control's enabled state differs", () => {
    const a = snap({ url: "https://x.test/x", controls: [control({ enabled: true })] });
    const b = snap({ url: "https://x.test/x", controls: [control({ enabled: false })] });
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });

  test("differs when the url template differs", () => {
    const a = snap({ url: "https://x.test/thread/1", controls: [] });
    const b = snap({ url: "https://x.test/inbox", controls: [] });
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });
});

describe("actionKey", () => {
  test("is unique per (fingerprint, op, control) and stable across calls", () => {
    const c = control({ role: "button", name: "Reply" });
    const fp = "fp-1";
    expect(actionKey(fp, c, "click")).toBe(actionKey(fp, c, "click"));
    expect(actionKey(fp, c, "click")).not.toBe(actionKey(fp, c, "type"));
  });
});
