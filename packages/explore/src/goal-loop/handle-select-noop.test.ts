/**
 * #639 — when the model names the option a combobox ALREADY shows selected, that is a no-op, not a
 * refusal: the step is recorded `actOk: true` ("already selected … nothing to change"), the page is
 * left alone (no mutation noted), and the model is told the value is already set so it moves on.
 * Every other refusal (#273: a placeholder, an unmatched value) is unchanged. The handler is
 * exercised through its `RunContext`/`ActStep` seam, with `act` mocked at the module boundary.
 */
import { describe, expect, it, vi } from "vitest";
import type { Control } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { handleSelectOption } from "./handle-select.js";
import type { ActStep } from "./step.js";

vi.mock("../act.js", () => ({
  act: vi.fn(async () => ({ ok: true, mutated: true, reason: "selected" })),
}));

const control = (over: Partial<Control> = {}): Control =>
  ({
    index: 0,
    descriptor: { role: "combobox", name: "Email column" },
    stability: "medium",
    role: "combobox",
    name: "Email column",
    tag: "select",
    inputType: null,
    enabled: true,
    summary: "select Email column",
    options: ["email", "phone", "name"],
    selected: "email",
    ...over,
  }) as Control;

/** Run one select whose generated value is `text` against a combobox showing `control()`. */
async function run(text: string | null, over: Partial<Control> = {}, goal = "set the email column") {
  const history: string[] = [];
  const record = vi.fn();
  const noteMutation = vi.fn();
  const fillHelper = { valueFor: async () => ({ text, source: "model" as const }), commit: vi.fn() };
  const c = control(over);
  const blockers: { failClosed: string | null } = { failClosed: null };
  const ctx = {
    cfg: { goal },
    secrets: [],
    history,
    blockers,
    lastActedOp: null,
    fillHelper,
    recorder: { select: vi.fn() },
    tracker: { countAction: vi.fn() },
    noteMutation,
    cleared: vi.fn(),
    failNote: (reason: string | undefined) => reason ?? "failed",
    noteFailedAct: async () => false,
  } as unknown as RunContext;
  const step = { snap: { signature: "sig", controls: [c] }, record, control: c, at: 123 } as unknown as ActStep;
  await handleSelectOption(ctx, step, "select");
  return { record, noteMutation, history, blockers };
}

describe("#639 — selecting the option already selected is a no-op, not a refusal", () => {
  it("records the step as successful", async () => {
    const { record } = await run("email");
    expect(record.mock.calls[0]![0]).toBe(true);
  });

  it("notes no mutation for the unchanged page", async () => {
    const { noteMutation } = await run("email");
    expect(noteMutation).not.toHaveBeenCalled();
  });

  it("tells the model the value is already set", async () => {
    const { history } = await run("email");
    expect(history.join("\n")).toContain('"email" is already selected in Email column — nothing to change');
  });
});

describe("#639 — the other select outcomes are unchanged", () => {
  it("a different valid option still notes a mutation", async () => {
    const { noteMutation } = await run("phone");
    expect(noteMutation).toHaveBeenCalledTimes(1);
  });

  it("a value naming no option still fails closed", async () => {
    const { blockers } = await run("fax");
    expect(blockers.failClosed).toContain("no valid option");
  });

  it("a placeholder is still refused", async () => {
    const { record } = await run("—", { options: ["—", "email", "phone"] });
    expect(record.mock.calls[0]![0]).toBe(false);
  });
});
