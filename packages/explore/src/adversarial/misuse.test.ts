import { describe, expect, test } from "vitest";
import { pickMisuseAction } from "./misuse.js";
import type { Control, Snapshot } from "../index.js";

function ctrl(over: Partial<Control>): Control {
  return {
    index: 0,
    descriptor: { css: "x" },
    stability: "high",
    role: "button",
    name: "",
    tag: "button",
    inputType: null,
    enabled: true,
    summary: "button",
    ...over,
  };
}

const snapshot: Snapshot = {
  url: "https://x.test/checkout",
  truncated: false,
  signature: "s",
  controls: [
    ctrl({ index: 0, role: "textbox", tag: "input", inputType: "text", name: "Username" }),
    ctrl({ index: 1, role: "button", name: "Submit" }),
    ctrl({ index: 2, role: "button", name: "Cancel" }),
  ],
};

describe("pickMisuseAction — ordering-violation", () => {
  test("prefers a terminal-looking control (Submit/Confirm/Pay) BEFORE any required field is filled", () => {
    const decision = pickMisuseAction({ snapshot, strategy: "ordering-violation", rng: () => 0 });
    expect(decision).toEqual({ op: "click", targetIndex: 1 });
  });

  test("returns null when no terminal-looking control exists", () => {
    const noTerminal: Snapshot = { ...snapshot, controls: [snapshot.controls[0]!] };
    expect(pickMisuseAction({ snapshot: noTerminal, strategy: "ordering-violation", rng: () => 0 })).toBeNull();
  });
});

describe("pickMisuseAction — repeat-rapid", () => {
  test("re-issues the last decision verbatim", () => {
    const last = { op: "click" as const, targetIndex: 2 };
    const decision = pickMisuseAction({ snapshot, strategy: "repeat-rapid", lastDecision: last, rng: () => 0 });
    expect(decision).toEqual(last);
  });

  test("returns null when there is no last decision to repeat", () => {
    expect(pickMisuseAction({ snapshot, strategy: "repeat-rapid", rng: () => 0 })).toBeNull();
  });
});

describe("pickMisuseAction — boundary-input", () => {
  test("targets the first enabled textbox with an 'invalid'-strategy value", () => {
    const decision = pickMisuseAction({ snapshot, strategy: "boundary-input", rng: () => 0 });
    expect(decision).toMatchObject({ op: "type", targetIndex: 0 });
    expect((decision as { fillText?: string }).fillText).toBeTruthy();
  });

  test("returns null when there is no textbox to target", () => {
    const noText: Snapshot = { ...snapshot, controls: snapshot.controls.filter((c) => c.role !== "textbox") };
    expect(pickMisuseAction({ snapshot: noText, strategy: "boundary-input", rng: () => 0 })).toBeNull();
  });
});

describe("pickMisuseAction — contradictory-actions", () => {
  test("picks Cancel when the last decision targeted Submit (or vice versa) — a same-step contradiction", () => {
    const decision = pickMisuseAction({
      snapshot,
      strategy: "contradictory-actions",
      lastDecision: { op: "click", targetIndex: 1 },
      rng: () => 0,
    });
    expect(decision).toEqual({ op: "click", targetIndex: 2 });
  });

  test("returns null when there is no opposing control to pick", () => {
    const onlyOne: Snapshot = { ...snapshot, controls: [snapshot.controls[1]!] };
    expect(
      pickMisuseAction({
        snapshot: onlyOne,
        strategy: "contradictory-actions",
        lastDecision: { op: "click", targetIndex: 1 },
        rng: () => 0,
      }),
    ).toBeNull();
  });
});

describe("pickMisuseAction — nav-during-pending", () => {
  test("returns a scroll_down as a stand-in 'do something else while X is pending' action", () => {
    // The real "during pending async" timing is orchestrated by the mission
    // loop (Task 6), which fires this action WITHOUT awaiting the prior
    // action's network settle. Here we only verify the pure action choice.
    const decision = pickMisuseAction({ snapshot, strategy: "nav-during-pending", rng: () => 0 });
    expect(decision).toEqual({ op: "scroll_down" });
  });
});
