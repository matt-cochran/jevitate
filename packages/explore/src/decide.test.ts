import { describe, it, expect } from "vitest";
import { FakeJudgmentGateway, type Answer } from "@jevitate/ai-core";
import { decide, PROMPT_INJECTION_GUARD, type Op } from "./index.js";
import type { Snapshot, Control } from "./index.js";

function control(index: number, name: string, role = "button"): Control {
  return {
    index,
    descriptor: { role, name },
    stability: "high",
    role,
    name,
    tag: role === "textbox" ? "input" : "button",
    inputType: role === "textbox" ? "text" : null,
    enabled: true,
    summary: `${role} "${name}"`,
  };
}

const snap: Snapshot = {
  url: "http://127.0.0.1:3000/login",
  controls: [control(0, "Username", "textbox"), control(1, "Sign in")],
  truncated: false,
  signature: "sig",
};

const choice = (value: string, confidence = 0.9): Answer => ({ kind: "choice", value, confidence });

describe("decide — two-head op+target (Task 5)", () => {
  it("returns the scripted op and, for a target-op, the chosen control", async () => {
    const judge = new FakeJudgmentGateway({ op: choice("type"), target: choice("0") });
    const d = await decide(judge, { goal: "log in", snapshot: snap, history: [] });
    expect(d.op).toBe<Op>("type");
    expect(d.control?.name).toBe("Username");
    expect(d.confidence).toBe(0.9);
    expect(d.targetMissing).toBe(false);
  });

  it("ignores the non-chosen op's target head (done never consumes a target)", async () => {
    const judge = new FakeJudgmentGateway({ op: choice("done"), target: choice("1") });
    const d = await decide(judge, { goal: "log in", snapshot: snap, history: [] });
    expect(d.op).toBe<Op>("done");
    expect(d.control).toBeNull(); // target head ignored for done
    expect(d.targetMissing).toBe(false);
  });

  it("flags targetMissing (fail-closed) when a target-op picks an invalid index", async () => {
    const judge = new FakeJudgmentGateway({ op: choice("click"), target: choice("99") });
    const d = await decide(judge, { goal: "x", snapshot: snap, history: [] });
    expect(d.op).toBe<Op>("click");
    expect(d.control).toBeNull();
    expect(d.targetMissing).toBe(true);
  });

  it("injects the prompt-injection guard into every prompt (guardrail #5)", async () => {
    let capturedControls: string[] = [];
    const judge = {
      async systemOne(args: { state: { controls: string[] } }): Promise<Record<string, Answer>> {
        capturedControls = args.state.controls;
        return { op: choice("wait"), target: choice("0") };
      },
    };
    await decide(judge, { goal: "x", snapshot: snap, history: [] });
    expect(capturedControls[0]).toBe(PROMPT_INJECTION_GUARD);
    expect(capturedControls).toContain('[0] textbox "Username"');
  });

  it("redacts registered secrets out of the state before the model sees it", async () => {
    let dump = "";
    const judge = {
      async systemOne(args: { state: unknown }): Promise<Record<string, Answer>> {
        dump = JSON.stringify(args.state);
        return { op: choice("done") };
      },
    };
    const secretSnap: Snapshot = { ...snap, url: "http://127.0.0.1:3000/x?token=hunter2" };
    await decide(judge, { goal: "x", snapshot: secretSnap, history: ["typed hunter2"], secrets: ["hunter2"] });
    expect(dump).not.toContain("hunter2");
  });
});
