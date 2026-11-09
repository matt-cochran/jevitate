import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openModelSecretScope, type JevClientCall, type UsageSink } from "@jevitate/ai-core";
import type { Journey } from "@jevitate/journey";
import { resetRunHooksForTests, runBeforeWriteHooks, hasRunHookOwner } from "./journey-run-hooks.js";
import { JourneyRunEvidenceWriter } from "./journey-run-evidence.js";
import { registerSentinelShadowHook, registerSentinelShadowHookOnce, SENTINEL_HOOK_OWNER, SENTINEL_WOULD_HOLD_THRESHOLD, sentinelShadowGateway } from "./sentinel-hook.js";

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

describe("GAPS 17: the real gateway, opt-in shadow", () => {
  const KEY = "sk-or-sentinel-test-key-not-real-0001";
  const VALUE = "VALUE_contact_4471";
  const SECRET = "SECRET_hunter2_sentinel";
  const PAGE_TEXT = "MARKER_PAGE_TEXT_sentinel";
  const env = { JEVITATE_WRITE_SENTINEL: "shadow", OPENROUTER_API_KEY: KEY };
  const noCreds = () => ({});

  it("is off without the explicit opt-in, or without a Jev key; the threshold is 0.5", () => {
    expect(SENTINEL_WOULD_HOLD_THRESHOLD).toBe(0.5);
    expect(sentinelShadowGateway({ env: { OPENROUTER_API_KEY: KEY }, loadCredentials: noCreds })).toBeUndefined();
    expect(sentinelShadowGateway({ env: { JEVITATE_WRITE_SENTINEL: "enforce", OPENROUTER_API_KEY: KEY }, loadCredentials: noCreds })).toBeUndefined();
    expect(sentinelShadowGateway({ env: { JEVITATE_WRITE_SENTINEL: "shadow" }, loadCredentials: noCreds })).toBeUndefined();
    expect(sentinelShadowGateway({ env, loadCredentials: noCreds })).toBeDefined();
  });

  it("sends no param value, declared secret, page text or key to the Jev call; passes the catalog title; records usage; never holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-sentinel-gw-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "jobs.json"), JSON.stringify({ jobs: [{ id: "the-job", trigger: "a contact moved", motivation: "update the contact's email", outcome: "they get my mail" }] }));
      const wire: string[] = [];
      let built = 0;
      const clientCall = async (usage: UsageSink): Promise<JevClientCall> => {
        built += 1;
        return async (args) => {
          wire.push(JSON.stringify({ state: args.state, questions: args.questions }));
          usage.recordJudgment({ inputTokens: 300, outputTokens: 0, model: "jev-1.14.0" });
          return { "write.destructive": { kind: "noul", probability: 0.99 }, "write.outside-intent": { kind: "noul", probability: 0.99 } } as never;
        };
      };
      const gateway = sentinelShadowGateway({ env, loadCredentials: noCreds, clientCall, catalogDir: dir })!;
      expect(built).toBe(0); // lazy: nothing is built until a write
      const shadow = registerSentinelShadowHook({ gateway });
      const scope = openModelSecretScope();
      scope.add([SECRET]);
      try {
        const j = {
          ...journey,
          recording: { ...journey.recording, pages: [{ url: "/", steps: [{ step: { kind: "click", target: { role: "button", name: `Delete ${SECRET}` } } }] }] },
        } as unknown as Journey;
        const w = new JourneyRunEvidenceWriter({ origin: "http://x.test", journey: { id: "j", hash: "h" }, params: {}, secretParamNames: [], channel: "cli" } as never);
        const c = {
          journey: j,
          params: { contact: VALUE },
          channel: "cli",
          mode: "automation",
          evidence: w,
          step: 1,
          kind: "click",
          locator: { page: () => ({ url: () => `http://x.test/contacts/${VALUE}?q=${SECRET}`, content: async () => PAGE_TEXT, textContent: async () => PAGE_TEXT }) },
        } as never;
        await expect(runBeforeWriteHooks(c)).resolves.toBeUndefined();
        await expect(runBeforeWriteHooks(c)).resolves.toBeUndefined();
        expect(built).toBe(1); // memoized
        expect(shadow.result).toEqual({ wouldHaveHeld: 2, judged: 2 });
        expect(wire).toHaveLength(2);
        for (const p of wire) {
          for (const leak of [VALUE, SECRET, PAGE_TEXT, KEY]) expect(p).not.toContain(leak);
          expect(p).toContain("the-job: update the contact's email");
          expect(p).toContain("delete, erase, overwrite, revoke or cancel");
        }
        expect(gateway.usage.snapshot()).toMatchObject({ judgments: 2, inputTokens: 600, priced: "full" });
        const evidence = w.build(Buffer.alloc(32)) as unknown as { notes?: readonly string[] };
        const notes = JSON.stringify(evidence);
        expect(notes).toContain("write sentinel (step 1): 1 Jev call, 300 input tokens");
        for (const leak of [VALUE, SECRET, PAGE_TEXT, KEY]) expect(notes).not.toContain(leak);
      } finally {
        scope.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a gateway whose client cannot be built degrades to jev-unavailable and still never holds", async () => {
    const gateway = sentinelShadowGateway({ env, loadCredentials: noCreds, clientCall: () => Promise.reject(new Error("no sdk")) })!;
    const shadow = registerSentinelShadowHook({ gateway, jobTitle: () => "t" });
    const w = new JourneyRunEvidenceWriter({ origin: "http://x.test", journey: { id: "j", hash: "h" }, params: {}, secretParamNames: [], channel: "cli" } as never);
    await expect(runBeforeWriteHooks(ctx(w, "automation"))).resolves.toBeUndefined();
    expect(shadow.result).toEqual({ wouldHaveHeld: 0, judged: 0 });
    expect(JSON.stringify(w.build(Buffer.alloc(32)))).toContain("jev-unavailable");
  });
});
