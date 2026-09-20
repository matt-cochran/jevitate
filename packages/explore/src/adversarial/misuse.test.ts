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
