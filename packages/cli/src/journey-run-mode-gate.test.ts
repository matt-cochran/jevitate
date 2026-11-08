import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { registerRunSurfaceHooks } from "./run-surface-hooks.js";
import { resolveJourneyEnvironment } from "./environments.js";
import { HOLD_HOOK_OWNER } from "./journey-hold.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { hasRunHookOwner, hasRunHooks, resetRunHooksForTests } from "./journey-run-hooks.js";
import { E_APPROVAL_CHANNEL_FOR_MODE, E_HUMAN_STEP_IN_TEST_MODE, RUN_MODE_HOOK_OWNER, RunModeRefusedError, draftOnAutomationTargetWarning, registerRunModeHooks, resolveRunTarget, runModeRefusalBody } from "./journey-run-mode-gate.js";
import { exitCodeForError } from "./exit-codes.js";
import { modeWriteAllowlist } from "./mcp-run-guard.js";

/** 0.30.0 §5: the run mode, decided by the target's declared trust, refuses before any browser opens. */

const SITE = "https://app.example.test";
const STAGING = "https://staging.example.test";

let dir: string;
let journeysDir: string;
let environmentsFile: string;
let targetsFile: string;

function journey(id: string, opts: { handback?: boolean; channel?: string; promoted?: boolean } = {}): Journey {
  const j = {
    metadata: { id, name: id, promoted: opts.promoted ?? true, params: [], createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: {
      version: "1.0.0",
      site: SITE,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            ...(opts.handback === true ? [{ step: { kind: "handback", prompt: "Finish the payment", resume: { kind: "urlIncludes", text: "/done" } } }] : []),
          ],
        },
      ],
    },
  } as unknown as Journey;
  const pr = opts.channel === "pr-review" ? { pr: { number: 7, mergedSha: "a".repeat(40), reviewer: "reviewer" } } : {};
  if (opts.channel !== undefined) j.metadata.approval = { contentHash: "0".repeat(64), at: "2026-11-08T00:00:00.000Z", provenance: { channel: opts.channel, agentSignals: [], ...pr } } as never;
  return j;
}

/** A browser port factory that counts launches and never opens one. */
function countingFactory() {
  const launches = { count: 0 };
  const factory = () => {
    launches.count += 1;
    throw new Error("no browser in this test");
  };
  return { launches, factory: factory as never };
}

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (e: unknown) => e,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-run-mode-"));
  journeysDir = join(dir, "journeys");
  environmentsFile = join(dir, "environments.json");
  targetsFile = join(dir, "targets.json");
  await writeFile(environmentsFile, JSON.stringify({ staging: { baseUrl: STAGING, trust: "test" }, prod: { baseUrl: "https://prod.example.test", production: true } }));
  await writeFile(targetsFile, JSON.stringify({}));
  resetRunHooksForTests();
  registerRunModeHooks();
});

afterEach(async () => {
  resetRunHooksForTests();
  await rm(dir, { recursive: true, force: true });
});

const env = (name: string, baseUrl?: string) => resolveJourneyEnvironment({ env: name, environmentsFile, targetsFile, ...(baseUrl === undefined ? {} : { baseUrl }) })!;

describe("resolveRunTarget: the mode from human-written configuration only", () => {
  it("an origin nobody declares is unknown, so automation mode", () => {
    expect(resolveRunTarget({ origin: SITE, environmentsFile, targetsFile })).toMatchObject({ trust: "unknown", mode: "automation" });
  });

  it("a named environment's trust test is test mode on its own origin only", () => {
    expect(resolveRunTarget({ origin: STAGING, environment: env("staging"), targetsFile })).toMatchObject({ trust: "test", mode: "test" });
    // --base-url onto another origin is not what the file vouches for.
    expect(resolveRunTarget({ origin: SITE, environment: env("staging", SITE), targetsFile })).toMatchObject({ trust: "unknown", mode: "automation" });
  });

  it("the operator's production wins over the repo's test; any environment's production holds its origin", async () => {
    await writeFile(targetsFile, JSON.stringify({ [STAGING]: { trust: "production" } }));
    expect(resolveRunTarget({ origin: STAGING, environment: env("staging"), targetsFile })).toMatchObject({ trust: "production", mode: "automation" });
    expect(resolveRunTarget({ origin: "https://prod.example.test", environmentsFile, targetsFile })).toMatchObject({ trust: "production" });
  });

  it("an unreadable targets file never makes a run looser than unknown: automation mode", async () => {
    const staging = env("staging");
    await writeFile(targetsFile, "{not json");
    expect(resolveRunTarget({ origin: STAGING, environment: staging, targetsFile: join(dir, "missing", "t.json") }).mode).toBe("test");
    expect(resolveRunTarget({ origin: SITE, environmentsFile, targetsFile }).mode).toBe("automation");
    // A declaration the operator's file might hold is not assumed away: unreadable reads as unknown, never test.
    expect(resolveRunTarget({ origin: STAGING, environment: staging, targetsFile })).toMatchObject({ trust: "unknown", mode: "automation" });
  });
});

describe("the run-mode hook, before any browser", () => {
  it("a target with trust 'test' and a handback step refuses E_HUMAN_STEP_IN_TEST_MODE, launch count 0 (CLI and MCP)", async () => {
    await new FsJourneyStore(journeysDir).put(journey("pay", { handback: true, channel: "tty" }));
    for (const mcp of [false, true]) {
      const { launches, factory } = countingFactory();
      const run = () => runJourneyProgrammatically({ dir: journeysDir, id: "pay", params: {}, environment: env("staging"), runGuardTargetsFile: targetsFile, browserPortFactory: factory });
      const err = await settle(mcp ? () => runAsMcpInvocation(run) : run);
      expect(err).toBeInstanceOf(RunModeRefusedError);
      expect((err as RunModeRefusedError).code).toBe(E_HUMAN_STEP_IN_TEST_MODE);
      expect(runModeRefusalBody(err as RunModeRefusedError)).toMatchObject({ outcome: "refused", code: E_HUMAN_STEP_IN_TEST_MODE, mode: "test", trust: "test", retryable: false, exitCode: 2 });
      expect(launches.count).toBe(0);
    }
  });

  it("the same handback Journey on an automation-mode target is not refused by the mode", async () => {
    await new FsJourneyStore(journeysDir).put(journey("pay", { handback: true, channel: "tty" }));
    const { launches, factory } = countingFactory();
    const err = await settle(() => runJourneyProgrammatically({ dir: journeysDir, id: "pay", params: {}, runGuardTargetsFile: targetsFile, browserPortFactory: factory }));
    expect(err).not.toBeInstanceOf(RunModeRefusedError);
    expect(launches.count).toBe(1);
  });

  it.each([["mcp"], ["non-interactive"], ["ci"], [undefined]])("over MCP on an automation-mode target, an approval over %s refuses E_APPROVAL_CHANNEL_FOR_MODE, launch count 0", async (channel) => {
    await new FsJourneyStore(journeysDir).put(journey("save", { channel }));
    const { launches, factory } = countingFactory();
    const err = await settle(() => runAsMcpInvocation(() => runJourneyProgrammatically({ dir: journeysDir, id: "save", params: {}, runGuardTargetsFile: targetsFile, browserPortFactory: factory })));
    expect((err as RunModeRefusedError).code).toBe(E_APPROVAL_CHANNEL_FOR_MODE);
    expect((err as Error).message).toContain("jevitate journey promote save");
    expect(launches.count).toBe(0);
  });

  it.each([["tty"], ["pr-review"]])("an approval over %s runs over MCP on an automation-mode target", async (channel) => {
    await new FsJourneyStore(journeysDir).put(journey("save", { channel }));
    const { launches, factory } = countingFactory();
    const err = await settle(() => runAsMcpInvocation(() => runJourneyProgrammatically({ dir: journeysDir, id: "save", params: {}, runGuardTargetsFile: targetsFile, browserPortFactory: factory })));
    expect(err).not.toBeInstanceOf(RunModeRefusedError);
    expect(launches.count).toBe(1);
  });

  it("an MCP approval authorises a test-mode run; the CLI is not held to the approval channel", async () => {
    await new FsJourneyStore(journeysDir).put(journey("save", { channel: "mcp" }));
    const test = countingFactory();
    await settle(() => runAsMcpInvocation(() => runJourneyProgrammatically({ dir: journeysDir, id: "save", params: {}, environment: env("staging"), runGuardTargetsFile: targetsFile, browserPortFactory: test.factory })));
    expect(test.launches.count).toBe(1);
    const cli = countingFactory();
    await settle(() => runJourneyProgrammatically({ dir: journeysDir, id: "save", params: {}, runGuardTargetsFile: targetsFile, browserPortFactory: cli.factory }));
    expect(cli.launches.count).toBe(1);
  });

  it("refusals exit 2 (refused); a typed-parameter error is usage (64)", () => {
    for (const code of [E_APPROVAL_CHANNEL_FOR_MODE, E_HUMAN_STEP_IN_TEST_MODE, "E_POLICY_LOOSEN_OVER_MCP", "E_TARGET_PROMOTE_OVER_MCP", "E_RUN_HELD", "E_HOLD_EXPIRED"]) expect(exitCodeForError(code), code).toBe(2);
    for (const code of ["E_JOURNEY_PARAM_TYPE", "E_HOLD_BINDING", "E_HOLD_NOT_APPROVED", "E_HOLD_REJECTED", "E_HOLD_ANSWERED", "E_HOLD_INTEGRITY", "E_HOLD_CHECKPOINT"]) expect(exitCodeForError(code), code).toBe(64);
  });
});

describe("central registration", () => {
  it("registers each surface hook once, however many programs are built, and again after a reset", () => {
    resetRunHooksForTests();
    registerRunSurfaceHooks();
    registerRunSurfaceHooks();
    for (const owner of [RUN_MODE_HOOK_OWNER, "param-types", HOLD_HOOK_OWNER]) expect(hasRunHookOwner(owner), owner).toBe(true);
    resetRunHooksForTests();
    expect(hasRunHookOwner(RUN_MODE_HOOK_OWNER)).toBe(false);
    registerRunSurfaceHooks();
    expect(hasRunHookOwner(RUN_MODE_HOOK_OWNER)).toBe(true);
  });

  it("the run-mode gate has no beforeWrite hook, so it never holds a resumed run's approved step again", () => {
    // The approved step of a resume (`isApprovedResumeStep`) is let through by the hold hooks; the gate decides
    // before the browser opens and adds nothing at a write, so it cannot re-hold it.
    resetRunHooksForTests();
    registerRunModeHooks();
    expect(hasRunHooks("beforeWrite")).toBe(false);
    expect(hasRunHooks("resolveMode")).toBe(true);
  });
});

describe("authored allowedOrigins and the write allowlist", () => {
  const base = { site: SITE, allowedOrigins: [SITE, "https://cdn.example.test", "https://pay.example.test"], authoredOrigins: ["https://pay.example.test"] };
  it("join it in test mode only", () => {
    expect(modeWriteAllowlist({ ...base, mode: "test" })).toEqual(base.allowedOrigins);
    expect(modeWriteAllowlist({ ...base, mode: "automation" })).toEqual([SITE, "https://cdn.example.test"]);
    // Unset (no run-mode hook): as 0.29.0.
    expect(modeWriteAllowlist(base)).toEqual(base.allowedOrigins);
  });

  it("the site and the environment's own origins stay, even when also authored", () => {
    expect(modeWriteAllowlist({ ...base, authoredOrigins: [SITE, "https://pay.example.test"], mode: "automation" })).toEqual([SITE, "https://cdn.example.test"]);
  });
});

describe("CLI: a draft on an automation-mode target", () => {
  it("warns once for a draft on an undeclared origin; nothing for a promoted one or a test target", async () => {
    await new FsJourneyStore(journeysDir).put(journey("draft", { promoted: false }));
    await new FsJourneyStore(journeysDir).put(journey("done", { channel: "tty" }));
    expect(await draftOnAutomationTargetWarning({ journeysDir, id: "draft", targetsFile })).toMatch(/^warning: journey 'draft' is a draft, running on https:\/\/app\.example\.test, an automation-mode target \(trust "unknown"\)/);
    expect(await draftOnAutomationTargetWarning({ journeysDir, id: "done", targetsFile })).toBeUndefined();
    expect(await draftOnAutomationTargetWarning({ journeysDir, id: "draft", environment: env("staging"), targetsFile })).toBeUndefined();
    expect(await draftOnAutomationTargetWarning({ journeysDir, id: "missing", targetsFile })).toBeUndefined();
  });
});
