import { describe, expect, test } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError, buildJudgmentState, REDACTION_MASK } from "./index.js";
import { runInductionMission } from "./missions/induction.js";

/**
 * Guardrail refusal contract for the proof-by-induction mission (spec §6),
 * mirroring the one-test-per-invariant style of the other slice-invariants
 * suites. These prove the mission REFUSES — they are not happy-path tests.
 */
describe("induction mission — guardrail invariants", () => {
  test("#1 refuses an undeclared origin before touching a Page", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    // page/actor are never touched — the authorization guard throws first.
    await expect(
      runInductionMission({
        page: {} as never,
        actor: {} as never,
        judgment,
        generation: new FakeGenerationGateway(),
        seedUrl: "https://not-authorized.test/inbox",
        allowlist: ["https://authorized.test"],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExploreTargetError);
  });

  test("#3 the judgment payload is built through the redaction choke point — a registered secret never survives, and controls are always string summaries", () => {
    // The mission builds its per-state defect payload with buildJudgmentState
    // (guardrail #3), the same choke point decide.ts uses. `JudgmentState.controls`
    // is structurally `string[]` (role/name summaries), never raw Control objects
    // carrying values — so a form value cannot reach the model by shape. And any
    // registered secret that leaked into a summary is masked here, or the build
    // throws. Prove it: a secret embedded in a summary is redacted, never sent.
    const secret = "s3cr3t-value";
    const state = buildJudgmentState({
      goal: "state coverage",
      url: "https://authorized.test/inbox",
      controls: ["button \"Sign in\"", `textbox "token" (value="${secret}")`],
      history: [],
      secrets: [secret],
    });
    const payload = JSON.stringify(state);
    expect(payload).not.toContain(secret);
    expect(payload).toContain(REDACTION_MASK);
    for (const c of state.controls) {
      expect(typeof c).toBe("string");
    }
  });
});
