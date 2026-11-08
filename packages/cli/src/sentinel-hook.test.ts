import { afterEach, describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { resetRunHooksForTests, runBeforeWriteHooks, hasRunHookOwner } from "./journey-run-hooks.js";
import { JourneyRunEvidenceWriter } from "./journey-run-evidence.js";
import { registerSentinelShadowHook, registerSentinelShadowHookOnce, SENTINEL_HOOK_OWNER } from "./sentinel-hook.js";

afterEach(() => resetRunHooksForTests());

const journey = {
  metadata: { id: "j", name: "j", promoted: true, params: [], parameters: [], job: "the-job" },
  recording: { version: "1", site: "http://x.test", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "a" } } } }] }] },
} as unknown as Journey;

const ctx = (evidence: JourneyRunEvidenceWriter | undefined, mode?: "test" | "automation") =>
  ({ journey, params: {}, channel: undefined, mode, evidence, step: 1, kind: "click", locator: { page: () => ({ url: () => "http://x.test/a/b" }) } }) as never;

describe("sentinel shadow hook", () => {
  it("never holds, whatever Jev says, and counts wouldHaveHeld", async () => {
    const gateway = { systemOne: async () => ({ "write.destructive": { kind: "noul", probability: 1 }, "write.outside-intent": { kind: "noul", probability: 1 } }) };
    const shadow = registerSentinelShadowHook({ gateway });
    const w = new JourneyRunEvidenceWriter({ origin: "http://x.test", journey: { id: "j", hash: "h" }, params: {}, secretParamNames: [], channel: "cli" } as never);
    await expect(runBeforeWriteHooks(ctx(w, "automation"))).resolves.toBeUndefined();
    expect(shadow.result).toEqual({ wouldHaveHeld: 1, judged: 1 });
  });

  it("does nothing in test mode, and registers once", async () => {
    let calls = 0;
    const gateway = { systemOne: async () => (calls++, {}) };
    registerSentinelShadowHook({ gateway });
    expect(hasRunHookOwner(SENTINEL_HOOK_OWNER)).toBe(true);
    expect(registerSentinelShadowHookOnce({ gateway })).toBeUndefined();
    await runBeforeWriteHooks(ctx(undefined, "test"));
    expect(calls).toBe(0);
  });
});
