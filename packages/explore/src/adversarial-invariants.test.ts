import { describe, expect, test } from "vitest";
import { FakeJudgmentGateway, FakeGenerationGateway, GEN_TASKS } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "./index.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { pickMisuseAction } from "./adversarial/misuse.js";
import type { Control, Snapshot } from "./index.js";

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

describe("adversarial mission — guardrail invariants", () => {
  test("#1 refuses an undeclared origin before touching a Page", async () => {
    const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    await expect(
      runAdversarialMission({
        page: {} as never,
        actor: {} as never,
        judgment,
        generation,
        seedUrl: "https://not-authorized.test/checkout",
        allowlist: ["https://authorized.test"],
        strategies: ["ordering-violation"],
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#2/#6 misuse strategies only ever choose click/type/select/scroll — never navigate off-origin or an irreversible op", () => {
    const snapshot: Snapshot = {
      url: "https://x.test/checkout",
      truncated: false,
      signature: "s",
      controls: [
        ctrl({ index: 0, role: "textbox", tag: "input", inputType: "text", name: "Email" }),
        ctrl({ index: 1, role: "button", name: "Pay now" }),
        ctrl({ index: 2, role: "button", name: "Cancel" }),
      ],
    };
    const strategies = ["ordering-violation", "boundary-input", "nav-during-pending", "contradictory-actions"] as const;
    for (const strategy of strategies) {
      const decision = pickMisuseAction({ snapshot, strategy, lastDecision: { op: "click", targetIndex: 1 }, rng: () => 0 });
      if (decision) expect(["click", "type", "select", "scroll_up", "scroll_down", "wait"]).toContain(decision.op);
    }
  });

  test("#3 the generation port's triage.narrative schema is closed — cannot carry raw form state", () => {
    const parseResult = GEN_TASKS["triage.narrative"].input.safeParse({
      failureSummary: "x",
      url: "https://x.test",
      formValues: { username: "s3cr3t" },
    });
    // .strict() (packages/ai-core/src/generation.ts) rejects the unknown
    // "formValues" key outright — this is what makes "never sends raw form
    // state to the model" a STRUCTURAL guarantee, not a convention.
    expect(parseResult.success).toBe(false);
  });
});
