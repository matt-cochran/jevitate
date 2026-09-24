import { describe, it, expect } from "vitest";
import { FakeJudgmentGateway, type Answer, type ChoiceQuestion, type Question } from "@jevitate/ai-core";
import {
  affordedOp,
  decide,
  targetCandidates,
  OPS,
  OPS_NEEDING_TARGET,
  PROMPT_INJECTION_GUARD,
  UPLOAD_OP_GUIDE,
  type Op,
} from "./index.js";
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

describe("decide — one candidate-action head", () => {
  it("returns the op afforded by the chosen control, with that control", async () => {
    const judge = new FakeJudgmentGateway({ action: choice("type:0") });
    const d = await decide(judge, { goal: "log in", snapshot: snap, history: [] });
    expect(d.op).toBe<Op>("type");
    expect(d.control?.name).toBe("Username");
    expect(d.confidence).toBe(0.9);
    expect(d.targetMissing).toBe(false);
  });

  it("a target-free action carries no control (done never consumes a target)", async () => {
    const judge = new FakeJudgmentGateway({ action: choice("done") });
    const d = await decide(judge, { goal: "log in", snapshot: snap, history: [] });
    expect(d.op).toBe<Op>("done");
    expect(d.control).toBeNull();
    expect(d.targetMissing).toBe(false);
  });

  it("fails closed (targetMissing) on an action id that was not offered — never a guessed control", async () => {
    const judge = new FakeJudgmentGateway({ action: choice("click:99") });
    const d = await decide(judge, { goal: "x", snapshot: snap, history: [] });
    expect(d.control).toBeNull();
    expect(d.targetMissing).toBe(true);
  });

  it("fails closed on an incoherent op/target pair (clicking a textbox is not an offered action)", async () => {
    const judge = new FakeJudgmentGateway({ action: choice("click:0") });
    const d = await decide(judge, { goal: "x", snapshot: snap, history: [] });
    expect(d.control).toBeNull();
    expect(d.targetMissing).toBe(true);
  });

  it("fails closed on a wrong-kind or missing answer", async () => {
    const wrongKind = {
      async systemOne(): Promise<Record<string, Answer>> {
        return { action: { kind: "noul", value: true, probability: 1 } };
      },
    };
    const d1 = await decide(wrongKind, { goal: "x", snapshot: snap, history: [] });
    expect(d1.targetMissing).toBe(true);
    expect(d1.control).toBeNull();
    const missing = {
      async systemOne(): Promise<Record<string, Answer>> {
        return {};
      },
    };
    const d2 = await decide(missing, { goal: "x", snapshot: snap, history: [] });
    expect(d2.targetMissing).toBe(true);
  });

  it("offers exactly one action per control (its afforded op) plus the target-free ops, each described", async () => {
    let asked: ChoiceQuestion<string> | undefined;
    const judge = {
      async systemOne(args: { questions: Record<string, Question> }): Promise<Record<string, Answer>> {
        const q = args.questions.action;
        if (q?.kind === "choice") asked = q;
        return { action: choice("wait") };
      },
    };
    await decide(judge, { goal: "x", snapshot: snap, history: [] });
    // "Username" is a form field, not a message composer: no `send` for it.
    expect(asked?.options).toEqual(["type:0", "click:1", "wait", "scroll_down", "scroll_up", "done", "blocked"]);
    expect(asked?.descriptions?.["type:0"]).toBe('type into textbox "Username"');
    expect(asked?.descriptions?.["click:1"]).toBe('click button "Sign in"');
    expect(asked?.instructions).toMatch(/single action/);
  });

  it("injects the prompt-injection guard into every prompt (guardrail #5)", async () => {
    let capturedControls: string[] = [];
    const judge = {
      async systemOne(args: { state: { controls: string[] } }): Promise<Record<string, Answer>> {
        capturedControls = args.state.controls;
        return { action: choice("wait") };
      },
    };
    await decide(judge, { goal: "x", snapshot: snap, history: [] });
    expect(capturedControls[0]).toBe(PROMPT_INJECTION_GUARD);
    expect(capturedControls).toContain('[0] textbox "Username"');
  });

  it("redacts registered secrets out of the state AND the candidate descriptions before the model sees them", async () => {
    let dump = "";
    const judge = {
      async systemOne(args: { state: unknown; questions: unknown }): Promise<Record<string, Answer>> {
        dump = JSON.stringify(args);
        return { action: choice("done") };
      },
    };
    const secretSnap: Snapshot = {
      ...snap,
      url: "http://127.0.0.1:3000/x?token=hunter2",
      controls: [control(0, "Welcome hunter2"), control(1, "Sign in")],
    };
    await decide(judge, { goal: "x", snapshot: secretSnap, history: ["typed hunter2"], secrets: ["hunter2"] });
    expect(dump).toContain("click:0");
    expect(dump).not.toContain("hunter2");
  });
});

describe("affordedOp — the one control→op mapping every mission shares", () => {
  const base: Pick<Control, "tag" | "inputType" | "role"> = { tag: "button", inputType: null, role: "button" };
  const table: Array<[string, Pick<Control, "tag" | "inputType" | "role">, ReturnType<typeof affordedOp>]> = [
    ["file input", { tag: "input", inputType: "file", role: "file-input" }, "upload"],
    ["native select", { tag: "select", inputType: null, role: "combobox" }, "select"],
    ["textarea", { tag: "textarea", inputType: null, role: "textbox" }, "type"],
    ["text input", { tag: "input", inputType: "text", role: "textbox" }, "type"],
    ["untyped input", { tag: "input", inputType: "", role: "textbox" }, "type"],
    ["email input", { tag: "input", inputType: "email", role: "textbox" }, "type"],
    ["password input", { tag: "input", inputType: "password", role: "textbox" }, "type"],
    ["number input", { tag: "input", inputType: "number", role: "spinbutton" }, "type"],
    ["date input", { tag: "input", inputType: "date", role: "textbox" }, "type"],
    ["checkbox", { tag: "input", inputType: "checkbox", role: "checkbox" }, "click"],
    ["radio", { tag: "input", inputType: "radio", role: "radio" }, "click"],
    ["submit input", { tag: "input", inputType: "submit", role: "button" }, "click"],
    ["range input", { tag: "input", inputType: "range", role: "slider" }, "click"],
    ["button", base, "click"],
    ["link", { tag: "a", inputType: null, role: "link" }, "click"],
    ["role=textbox div", { tag: "div", inputType: null, role: "textbox" }, "type"],
    ["role=searchbox div", { tag: "div", inputType: null, role: "searchbox" }, "type"],
    ["custom role=combobox div", { tag: "div", inputType: null, role: "combobox" }, "click"],
    ["role=button span", { tag: "span", inputType: null, role: "button" }, "click"],
  ];
  for (const [label, c, op] of table) {
    it(`${label} → ${op}`, () => {
      expect(affordedOp(c)).toBe(op);
    });
  }
});

describe("targetCandidates — the complete target actions a page affords", () => {
  const file: Control = {
    ...control(2, "Upload CSV"),
    role: "file-input",
    tag: "input",
    inputType: "file",
    descriptor: { css: "input[type=file]" },
    summary: 'file-input "Upload CSV"',
  };
  const disabled: Control = { ...control(3, "Disabled"), enabled: false };
  const controls = [...snap.controls, file, disabled];

  it("one candidate per control with its afforded op and a stable <op>:<index> id", () => {
    const ids = targetCandidates(controls).map((c) => c.id);
    expect(ids).toEqual(["type:0", "click:1", "upload:2", "click:3"]);
  });

  it("filters to the ops a mission may issue, and optionally to enabled controls", () => {
    expect(targetCandidates(controls, { ops: new Set(["click"]) }).map((c) => c.id)).toEqual(["click:1", "click:3"]);
    expect(targetCandidates(controls, { ops: new Set(["click"]), enabledOnly: true }).map((c) => c.id)).toEqual([
      "click:1",
    ]);
  });
});

describe("decide — upload offering", () => {
  const file: Control = {
    ...control(2, "Upload CSV"),
    role: "file-input",
    tag: "input",
    inputType: "file",
    descriptor: { css: "input[type=file]" },
    summary: 'file-input "Upload CSV"',
  };
  const uploadSnap: Snapshot = { ...snap, controls: [...snap.controls, file] };

  function capturing(answer: string): {
    judge: { systemOne(args: { state: { controls: string[] }; questions: Record<string, Question> }): Promise<Record<string, Answer>> };
    seen: { controls: string[]; options: readonly string[] }[];
  } {
    const seen: { controls: string[]; options: readonly string[] }[] = [];
    return {
      seen,
      judge: {
        async systemOne(args) {
          const q = args.questions.action;
          seen.push({ controls: args.state.controls, options: q?.kind === "choice" ? q.options : [] });
          return { action: choice(answer) };
        },
      },
    };
  }

  it("upload is a target-requiring op", () => {
    expect(OPS).toContain("upload");
    expect(OPS_NEEDING_TARGET.has("upload")).toBe(true);
  });

  it("is offered — with its guide line right after the injection guard — only when uploadAvailable", async () => {
    const withFixture = capturing("upload:2");
    const d = await decide(withFixture.judge, { goal: "x", snapshot: uploadSnap, history: [], uploadAvailable: true });
    expect(withFixture.seen[0]?.options).toContain("upload:2");
    expect(withFixture.seen[0]?.controls.slice(0, 2)).toEqual([PROMPT_INJECTION_GUARD, UPLOAD_OP_GUIDE]);
    expect(d.op).toBe<Op>("upload");
    expect(d.control?.index).toBe(2);

    const without = capturing("wait");
    await decide(without.judge, { goal: "x", snapshot: uploadSnap, history: [] });
    expect(without.seen[0]?.options.some((o) => o.startsWith("upload"))).toBe(false);
    expect(without.seen[0]?.controls).not.toContain(UPLOAD_OP_GUIDE);
  });

  it("never pairs upload with a non-file control (upload:<button> is inexpressible)", async () => {
    const c = capturing("upload:1");
    const d = await decide(c.judge, { goal: "x", snapshot: uploadSnap, history: [], uploadAvailable: true });
    expect(c.seen[0]?.options).not.toContain("upload:1");
    expect(d.targetMissing).toBe(true);
    expect(d.control).toBeNull();
  });
});
