import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { safeRunPolicy } from "@doit/domain";
import { StubSecretManager, SecretOriginMismatchError, SecretUnresolvableError, Secret } from "@doit/secrets";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";

/**
 * Slice 1b §9a — invariant refusal contract for the secret-VALUE
 * invariants (#2–#4), which Slice 1's visible-handback path never
 * exercised (the runner never held a value there). Adds NO new production
 * logic — re-uses the same fakes/fixtures as `vault-autofill.test.ts`. That
 * file remains the source of truth for exhaustive cases; this file exists
 * so a reviewer can read one place and see invariants #2, #3, and #4 all
 * refuse, plus Hard Floor #6 ("nothing stored at rest", covered by
 * `packages/secrets/src/no-persistence.test.ts`).
 */

function fakeLocator() {
  return { fill: vi.fn(async () => {}), isVisible: vi.fn(async () => true) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>, url: string) {
  return {
    url: vi.fn(() => url),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}
function actorWithPage(page: any) {
  return CastActor.named("test").whoCan(
    new BrowseTheWeb({ page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
  );
}
function fakeInterpreter(handbackResult: any) {
  return {
    run: vi.fn().mockResolvedValue(handbackResult),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "completed", vars: {} }),
  } as any;
}
const journeyWithSecret = (secretRefs: any[]) =>
  ({
    metadata: { id: "j", name: "j", promoted: true, params: [], secretRefs, createdAtIso: "x" },
    recording: { version: "1", site: "s", pages: [] },
  }) as any;

const ref = { manager: "stub", key: "login-password", origin: "https://mail.example.test", field: "password" };
const vaultPolicy = { ...safeRunPolicy(), secret: { secretMode: "vault-autofill" as const } };
const handback = {
  outcome: "awaiting_human",
  at: 0,
  prompt: "please enter your password",
  resume: { kind: "visible", target: { label: "Password" } },
};

describe("Slice 1b §9a — invariant refusal contract", () => {
  it("#2 Secret never serialized: toString()/JSON.stringify()/util.inspect() all throw", async () => {
    const { inspect } = await import("node:util");
    const secret = new Secret("hunter2");
    expect(() => `${secret}`).toThrow();
    expect(() => JSON.stringify(secret)).toThrow();
    expect(() => inspect(secret)).toThrow();
  });

  it("#3 origin mismatch: JourneyRunner.run rejects with SecretOriginMismatchError and never fills", async () => {
    const locator = fakeLocator();
    const actor = actorWithPage(fakePage(locator, "https://evil.example.test/login"));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretOriginMismatchError);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it("#4 unresolvable secret: JourneyRunner.run rejects with SecretUnresolvableError BEFORE any step runs", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({});
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretUnresolvableError);
    expect(interp.run).not.toHaveBeenCalled();
  });

  it("missing SecretManagerPort under vault-autofill fails closed (PolicyEnforcementError) — never a permissive skip", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const runner = new JourneyRunner(actor, interp); // no secretManager

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(PolicyEnforcementError);
    expect(interp.run).not.toHaveBeenCalled();
  });
});
