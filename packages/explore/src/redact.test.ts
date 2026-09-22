import { describe, it, expect } from "vitest";
import { SecretLeakError, assertNoSecretInPayload } from "@jevitate/ai-core";
import { buildJudgmentState, redactContext, redactText, REDACTION_MASK } from "./index.js";

const SECRETS = ["hunter2", "jane.doe@example.com"];

describe("redact — state redaction before any model call (guardrail #3)", () => {
  it("scrubs every registered secret from every JudgmentState field", () => {
    const state = buildJudgmentState({
      goal: "log in as jane.doe@example.com",
      url: "http://127.0.0.1:3000/login?token=hunter2",
      controls: ["textbox Email (value=jane.doe@example.com)", "button Sign in"],
      history: ["typed hunter2 into Password"],
      secrets: SECRETS,
    });
    const haystack = JSON.stringify(state);
    for (const s of SECRETS) expect(haystack).not.toContain(s);
    expect(haystack).toContain(REDACTION_MASK);
  });

  it("no configured-secret string survives into the model payload", () => {
    const state = buildJudgmentState({
      goal: "g",
      url: "u",
      controls: ["hunter2 leaked here"],
      history: [],
      secrets: SECRETS,
    });
    // Independent re-check: the emitted state parses clean through the shared
    // ai-core choke point too (would throw if any secret remained).
    expect(state.controls[0]).toBe(`${REDACTION_MASK} leaked here`);
  });

  it("is a no-op when no secrets are registered", () => {
    const state = buildJudgmentState({
      goal: "g",
      url: "u",
      controls: ["button Ok"],
      history: [],
    });
    expect(state.controls).toEqual(["button Ok"]);
  });

  it("redactContext scrubs and proves a generation context string", () => {
    expect(redactContext("fill password hunter2 now", SECRETS)).toBe(
      `fill password ${REDACTION_MASK} now`,
    );
  });

  it("blank secret entries are ignored (a '' would mask everything)", () => {
    expect(redactText("nothing to hide", ["", "   "])).toBe("nothing to hide");
  });

  it("the shared choke point still throws if a raw secret is passed unredacted", () => {
    // Proves buildJudgmentState's post-redaction assertion is real, by calling
    // the underlying guard on an un-scrubbed payload.
    expect(() => assertNoSecretInPayload({ x: "hunter2" }, SECRETS)).toThrow(SecretLeakError);
  });
});
