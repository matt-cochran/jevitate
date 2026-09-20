import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { safeRunPolicy } from "@doit/domain";
import { StubSecretManager, SecretUnresolvableError } from "@doit/secrets";
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
