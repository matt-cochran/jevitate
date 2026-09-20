import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { safeRunPolicy } from "@jevitate/domain";
import {
  StubSecretManager,
  SecretUnresolvableError,
  SecretOriginMismatchError,
  SecretAmbiguousBindingError,
} from "@jevitate/secrets";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";

function fakeLocator() {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    pressSequentially: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>, url: string) {
  return {
    goto: vi.fn(async () => {}),
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

describe("JourneyRunner — vault-autofill preflight", () => {
  it("§9a invariant #4: an unresolvable declared secretRef fails at PREFLIGHT, before any step runs", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({}); // "login-password" not present
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretUnresolvableError);
    expect(interp.run).not.toHaveBeenCalled(); // fail-fast BEFORE execution
  });

  it("missing SecretManagerPort under vault-autofill fails closed (PolicyEnforcementError), never a permissive skip", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const runner = new JourneyRunner(actor, interp); // no secretManager passed at all — backward-compatible 2-arg call

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(PolicyEnforcementError);
    expect(interp.run).not.toHaveBeenCalled();
  });

  it("a journey with no declared secretRefs under vault-autofill has nothing to preflight and proceeds", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter({ outcome: "completed", vars: {} });
    const manager = new StubSecretManager({});
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([]), params: {}, policy: vaultPolicy });
    expect(result).toEqual({ outcome: "ok", output: {} });
  });
});

describe("JourneyRunner — vault-autofill fill", () => {
  it("fetches the secret via the SecretManagerPort and types it into the recorded field, then resumes", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });

    expect(result).toEqual({ outcome: "ok", output: {} });
    expect(locator.fill).toHaveBeenCalledWith("hunter2");
    expect(interp.resumeFrom).toHaveBeenCalledWith(actor, expect.anything(), 1, {});
  });

  it("never puts the secret plaintext into the JourneyRunResult (JSON round-trips clean)", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });

    const serialized = JSON.stringify(result); // must not throw — would, if a raw Secret object had leaked in
    expect(serialized).not.toContain("hunter2");
  });

  it("§9a invariant #3: no declared secretRef matches the current page's origin — throws SecretOriginMismatchError and never fills", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://evil.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretOriginMismatchError);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it("review-round-1 adjacent minor: two secretRefs bound to the SAME origin is ambiguity, not an origin mismatch — throws SecretAmbiguousBindingError (still fail-closed)", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const secondRef = { ...ref, key: "login-username", field: "username" };
    const manager = new StubSecretManager({ "login-password": "hunter2", "login-username": "matthew" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref, secondRef]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretAmbiguousBindingError);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it("a handback resume that isn't a 'visible' target assertion cannot be auto-filled — quarantines rather than guessing", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter({ ...handback, resume: { kind: "urlIncludes", text: "/home" } });
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });
    expect(result).toMatchObject({ outcome: "quarantined", at: 0 });
  });
});
