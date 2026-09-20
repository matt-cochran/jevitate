import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";
import { ParamValidationError, JourneyRegistry, FsJourneyStore } from "@doit/journey";
import { safeRunPolicy } from "@doit/domain";

/**
 * Slice 1 §9a — invariant refusal contract.
 *
 * This file re-asserts, as ONE readable contract, the fail-fast/refusal
 * behavior for invariants #1, #5, #6 and #7. It adds NO new production
 * logic — it re-uses the same fakes/fixtures as the existing unit tests
 * (`journey-runner.test.ts` for the fake interpreter/actor + `journeyNoVars`
 * shape, `registry.test.ts` for the registry fixture). Those unit test files
 * remain the source of truth for the exhaustive cases; this file exists so
 * a reviewer can read one place and see all four invariants refuse.
 *
 * Reminder: the REAL interpreter's success outcome is `"completed"`, never
 * `"ok"` — fakes below use `"completed"` for any success path.
 */

const journeyNoVars = {
  metadata: { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" },
  recording: { version: "1", site: "s", pages: [] },
} as any;

function fakeInterpreter(result: any) {
  return {
    run: vi.fn().mockResolvedValue(result),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "completed", vars: {} }),
  } as any;
}
const fakeActor = {} as any;

describe("Slice 1 §9a — invariant refusal contract", () => {
  it("#1 absent RunPolicy: JourneyRunner.run throws PolicyEnforcementError", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "completed", vars: {} }));
    await expect(
      r.run({ journey: journeyNoVars, params: {}, policy: undefined as any }),
    ).rejects.toBeInstanceOf(PolicyEnforcementError);
  });

  it("#5 unknown param: JourneyRunner.run throws ParamValidationError before any step runs", async () => {
    const interp = fakeInterpreter({ outcome: "completed", vars: {} });
    const r = new JourneyRunner(fakeActor, interp);
    await expect(
      r.run({ journey: journeyNoVars, params: { bogus: "x" }, policy: safeRunPolicy() }),
    ).rejects.toBeInstanceOf(ParamValidationError);
    expect(interp.run).not.toHaveBeenCalled(); // fail-fast BEFORE execution
  });

  it("#6 unpromoted journeys are invisible to JourneyRegistry.find (the agent-facing MCP surface's source of truth)", async () => {
    // NOTE (RULING 6): #6 governs the AGENT-FACING MCP surface, not the local
    // CLI `journey run` (intentionally not promoted-only — the CLI is the
    // authoring surface). `findCapabilities`/`listNamedJourneyTools`/
    // `runJourney` in @doit/mcp-facade all delegate to `JourneyRegistry.find`
    // (or `reg.get` + a promoted check) for this filtering — see
    // packages/mcp-facade/src/journey-tools.ts.
    const dir = mkdtempSync(join(tmpdir(), "slice1-invariants-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    const rec = { version: "1", site: "example", pages: [] };
    await reg.put({
      metadata: { id: "checkout", name: "checkout", promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
      recording: rec,
    } as any);
    await reg.put({
      metadata: { id: "login", name: "login", promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
      recording: rec,
    } as any);

    expect((await reg.find("")).map((m) => m.id)).toEqual(["checkout"]);
    expect(await reg.find("login")).toEqual([]); // unpromoted stays invisible, never returned
  });

  it("#7 awaiting_human under fail-closed secretMode (no handback handler) quarantines — never assumes success", async () => {
    // The full resume-postcondition-FAIL path (a handback IS attempted, then
    // `checkAssertion` fails) needs a real actor and is covered by T7's
    // real-browser acceptance test (`journey-login-e2e.test.ts`). Faking
    // `checkAssertion` here would not exercise anything real, so this
    // contract test asserts the unit-testable half of #7: no handler wired
    // up (or fail-closed secretMode) must never be treated as success.
    const interp = fakeInterpreter({
      outcome: "awaiting_human",
      at: 1,
      prompt: "pw",
      resume: { kind: "urlIncludes", text: "/home" },
    });
    const r = new JourneyRunner(fakeActor, interp); // no HandbackHandler passed in
    const res = await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() }); // secretMode: fail-closed
    expect(res).toMatchObject({ outcome: "quarantined", at: 1 });
  });
});
