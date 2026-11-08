import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsJourneyStore, flatJourneySteps, journeyParamSchema, type Journey } from "@jevitate/journey";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { registerRunHooks, resetRunHooksForTests } from "./journey-run-hooks.js";
import { E_HUMAN_STEP_IN_TEST_MODE, E_SECRET_MODE_UNAVAILABLE, E_SECRET_ORIGIN_REFUSED, RunModeRefusedError, registerRunModeHooks } from "./journey-run-mode-gate.js";
import { planSecretRun, withSecretHandbacks, type SecretRunRequest } from "./journey-secret-mode.js";

/** 0.30.0 §5.3: how a run meets a step only a person (or the operator's vault) can do, chosen before any browser. */

const SITE = "https://app.example.test";
const OTHER = "https://other.example.test";
const VAR = "JEV_SECRET_MODE_TEST";
const VALUE = "MARKER_S-unit-41";

let dir: string;
let journeysDir: string;
let targetsFile: string;

/** A login: navigate, a handback at the password field (or a secret parameter typed into it), sign in. */
function journey(id: string, opts: { readonly secretParam?: boolean; readonly channel?: string | null } = {}): Journey {
  const channel = opts.channel === null ? undefined : (opts.channel ?? "tty");
  const pw = opts.secretParam === true
    ? { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } } }
    : { step: { kind: "handback", prompt: "Enter your password", resume: { kind: "visible", target: { label: "Password" } } } };
  return {
    metadata: {
      id,
      name: id,
      promoted: true,
      params: opts.secretParam === true ? ["password"] : [],
      ...(opts.secretParam === true ? { parameters: [{ name: "password", secret: true }] } : {}),
      createdAtIso: "2026-11-08T00:00:00.000Z",
      ...(channel === undefined ? {} : { approval: { contentHash: "0".repeat(64), at: "2026-11-08T00:00:00.000Z", provenance: { channel, agentSignals: [] } } }),
    },
    recording: {
      version: "1.0.0",
      site: SITE,
      pages: [
        {
          url: "/login",
          steps: [
            { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Password" } } } },
            pw,
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Signed in" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

function req(j: Journey, over: Partial<SecretRunRequest> = {}): SecretRunRequest {
  return { stored: j, journey: j, params: {}, origin: SITE, targetsFile, mode: undefined, mcp: true, surface: true, env: { [VAR]: VALUE }, ...over } as SecretRunRequest;
}

async function targets(body: Record<string, unknown>): Promise<void> {
  await writeFile(targetsFile, JSON.stringify(body));
}

function refusalOf(fn: () => unknown): RunModeRefusedError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RunModeRefusedError);
    return err as RunModeRefusedError;
  }
  throw new Error("not refused");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-secret-mode-"));
  journeysDir = join(dir, "journeys");
  targetsFile = join(dir, "targets.json");
  await targets({});
  resetRunHooksForTests();
  // A surface that can make a hold durable (journey-hold.ts registers this in production).
  registerRunHooks("test-holds", { onHold: () => undefined });
});

afterEach(async () => {
  resetRunHooksForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("planSecretRun: the secret mode, per run, from human-written configuration only", () => {
  it("automation mode, nothing bound: visible-handback, the handback step held as kind 'handback'", () => {
    const plan = planSecretRun(req(journey("login")));
    expect(plan.secretMode).toBe("visible-handback");
    expect([...plan.holdKinds]).toEqual([[1, "handback"]]);
    expect(plan.values).toEqual([]);
    expect(plan.trust).toBe("unknown");
  });

  it("automation mode, targets.json binds the field on the run's origin: vault-autofill, origin-bound, the value only in the manager", async () => {
    await targets({ [SITE]: { secretFields: [`label=Password=env:${VAR}`] } });
    const plan = planSecretRun(req(journey("login")));
    expect(plan.secretMode).toBe("vault-autofill");
    expect(plan.secretRefs).toEqual([{ manager: "targets.json", key: "label=Password", origin: SITE, field: "label=Password" }]);
    expect(JSON.stringify(plan.secretRefs)).not.toContain(VALUE);
    expect((await plan.secretManager!.fetch(plan.secretRefs![0]!)).reveal()).toBe(VALUE);
    // Masked wherever the run writes.
    expect(plan.values).toEqual([VALUE]);
  });

  it("bound to another origin only: E_SECRET_ORIGIN_REFUSED, naming origins and never the value", async () => {
    await targets({ [OTHER]: { secretFields: [`label=Password=env:${VAR}`] } });
    const err = refusalOf(() => planSecretRun(req(journey("login"))));
    expect(err.code).toBe(E_SECRET_ORIGIN_REFUSED);
    expect(err.message).toContain(OTHER);
    expect(err.message).not.toContain(VALUE);
    // The same for a secret parameter nobody supplied.
    expect(refusalOf(() => planSecretRun(req(journey("login-p", { secretParam: true })))).code).toBe(E_SECRET_ORIGIN_REFUSED);
  });

  it("a test-mode target never waits for a person: E_HUMAN_STEP_IN_TEST_MODE", async () => {
    await targets({ [SITE]: { trust: "test" } });
    expect(refusalOf(() => planSecretRun(req(journey("login")))).code).toBe(E_HUMAN_STEP_IN_TEST_MODE);
    expect(refusalOf(() => planSecretRun(req(journey("login-p", { secretParam: true })))).code).toBe(E_HUMAN_STEP_IN_TEST_MODE);
  });

  it("over MCP, a secret parameter nobody supplied is held as kind 'secret' at the step that types it, which becomes a handback", () => {
    const j = journey("login-p", { secretParam: true });
    const plan = planSecretRun(req(j));
    expect(plan.secretMode).toBe("visible-handback");
    expect(plan.heldSecretParams).toEqual(["password"]);
    expect([...plan.holdKinds]).toEqual([[1, "secret"]]);
    const held = withSecretHandbacks(j, plan.heldSecretParams);
    const steps = flatJourneySteps(held).map(({ recorded: { step } }) => step.kind);
    expect(steps).toEqual(["navigate", "handback", "click"]);
    // Nothing requires a value any more: none is asked of the model.
    expect(journeyParamSchema(held).required).toEqual([]);
  });

  it("over MCP, a secret parameter bound on the run's origin is supplied to the browser, bound there", async () => {
    await targets({ [SITE]: { secretFields: [`label=Password=env:${VAR}`] } });
    const plan = planSecretRun(req(journey("login-p", { secretParam: true })));
    expect(plan.heldSecretParams).toEqual([]);
    expect(plan.bound).toEqual({ password: [SITE] });
    expect(plan.values).toEqual([VALUE]);
  });

  it("leaves a run as it was: no human step, a run no surface started, --secret-mode fail-closed, or nowhere to hold", () => {
    const plain = { ...journey("x"), recording: { ...journey("x").recording, pages: [{ url: "/", steps: [] }] } } as unknown as Journey;
    expect(planSecretRun(req(plain)).secretMode).toBeUndefined();
    expect(planSecretRun(req(journey("login"), { surface: false })).secretMode).toBeUndefined();
    expect(planSecretRun(req(journey("login"), { flag: "fail-closed" })).secretMode).toBeUndefined();
    // On the CLI a missing secret parameter is the CLI's own error (--secret-field), never a hold.
    expect(planSecretRun(req(journey("login-p", { secretParam: true }), { mcp: false })).heldSecretParams).toEqual([]);
    resetRunHooksForTests();
    expect(planSecretRun(req(journey("login"))).secretMode).toBeUndefined();
  });

  it("over MCP, a Journey no person approved never reads targets.json or holds: the run keeps its fail-closed policy", async () => {
    await targets({ [SITE]: { secretFields: [`label=Password=env:${VAR}`] } });
    for (const channel of ["mcp", null] as const) {
      const plan = planSecretRun(req(journey("login", { channel })));
      expect(plan.secretMode).toBeUndefined();
      expect(plan.values).toEqual([]);
    }
  });

  it("--secret-mode vault-autofill without a binding refuses E_SECRET_MODE_UNAVAILABLE; visible-handback holds even with one", async () => {
    expect(refusalOf(() => planSecretRun(req(journey("login"), { flag: "vault-autofill" }))).code).toBe(E_SECRET_MODE_UNAVAILABLE);
    await targets({ [SITE]: { secretFields: [`label=Password=env:${VAR}`] } });
    expect(planSecretRun(req(journey("login"), { flag: "visible-handback" })).secretMode).toBe("visible-handback");
  });

  it("an unset variable binds nothing: the run holds for a person", async () => {
    await targets({ [SITE]: { secretFields: [`label=Password=env:${VAR}`] } });
    expect(planSecretRun(req(journey("login"), { env: {} })).secretMode).toBe("visible-handback");
  });
});

describe("acceptance 3: a handback Journey on a trust 'test' target", () => {
  it("returns E_HUMAN_STEP_IN_TEST_MODE with launch count 0, over MCP and on the CLI", async () => {
    await targets({ [SITE]: { trust: "test" } });
    await new FsJourneyStore(journeysDir).put(journey("login", { channel: "tty" }));
    registerRunModeHooks();
    for (const mcp of [true, false]) {
      const launches = { count: 0 };
      const browserPortFactory = (() => {
        launches.count += 1;
        throw new Error("no browser in this test");
      }) as never;
      const run = () => runJourneyProgrammatically({ dir: journeysDir, id: "login", params: {}, runGuardTargetsFile: targetsFile, browserPortFactory });
      const err = await (mcp ? runAsMcpInvocation(run) : run()).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(RunModeRefusedError);
      expect((err as RunModeRefusedError).code).toBe(E_HUMAN_STEP_IN_TEST_MODE);
      expect(launches.count).toBe(0);
    }
  });

  it("without the run-mode hook too, the secret mode refuses it before any browser", async () => {
    await targets({ [SITE]: { trust: "test" } });
    await new FsJourneyStore(journeysDir).put(journey("login", { channel: "tty" }));
    const launches = { count: 0 };
    const browserPortFactory = (() => {
      launches.count += 1;
      throw new Error("no browser in this test");
    }) as never;
    const err = await runAsMcpInvocation(() => runJourneyProgrammatically({ dir: journeysDir, id: "login", params: {}, runGuardTargetsFile: targetsFile, browserPortFactory, resumeAtStep: 2 })).then(() => undefined, (e: unknown) => e);
    expect((err as RunModeRefusedError).code).toBe(E_HUMAN_STEP_IN_TEST_MODE);
    expect(launches.count).toBe(0);
  });
});
