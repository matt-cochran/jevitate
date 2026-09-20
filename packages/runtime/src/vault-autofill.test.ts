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

/**
 * Unlike `fakeInterpreter` above (whose `resumeFrom` always returns a
 * hard-coded `vars: {}` — which can never surface a leak, since the
 * secret's own value never has a path into the return value regardless of
 * what the runner does), this variant ECHOES BACK whatever `resumeFrom` was
 * actually called with. That makes it a real leak detector: if a future
 * `JourneyRunner` change ever threaded the fetched secret into `req.params`
 * (or anywhere else passed to `resumeFrom`), it would show up in
 * `result.output` and this test would fail.
 */
function fakeInterpreterEcho(handbackResult: any) {
  return {
    run: vi.fn().mockResolvedValue(handbackResult),
    resumeFrom: vi.fn(async (_actor: unknown, _recording: unknown, _at: number, params: Record<string, string>) => ({
      outcome: "completed",
      vars: { ...params },
    })),
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

  it("never puts the secret plaintext into the JourneyRunResult (non-vacuous: resumeFrom echoes back whatever it was actually called with)", async () => {
    const KNOWN_SECRET = "hunter2-known-value-7f3a";
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreterEcho(handback);
    const manager = new StubSecretManager({ "login-password": KNOWN_SECRET });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({
      journey: journeyWithSecret([ref]),
      params: {},
      policy: vaultPolicy,
    });

    expect(result.outcome).toBe("ok");
    // Check outcome and output individually (per the requirement), then the
    // whole serialized result — any of these would have caught a leak, since
    // resumeFrom's echoed `vars` genuinely reflects what the runner passed it
    // (unlike `fakeInterpreter`'s hard-coded `vars: {}`, which can never
    // surface a leak regardless of what the runner actually does).
    expect(JSON.stringify(result.outcome)).not.toContain(KNOWN_SECRET);
    expect(JSON.stringify((result as { outcome: "ok"; output: unknown }).output)).not.toContain(KNOWN_SECRET);
    const serialized = JSON.stringify(result); // must not throw — would, if a raw Secret object had leaked in
    expect(serialized).not.toContain(KNOWN_SECRET);
    // Confirm this is a real assertion, not a vacuous one: resumeFrom really
    // was called, and only with the original (empty) params — never the secret.
    expect(interp.resumeFrom).toHaveBeenCalledWith(actor, expect.anything(), 1, {});
  });

  it("Playwright-tracing guard: vault-autofill never calls startTracing on the actor's browser session (secret-bearing runs must not enable tracing)", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const startTracing = vi.fn();
    const session = { page, startTracing, stopTracingToFile: vi.fn(), close: vi.fn() } as any;
    const actor = CastActor.named("test").whoCan(new BrowseTheWeb(session, []));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });

    expect(result).toEqual({ outcome: "ok", output: {} });
    expect(startTracing).not.toHaveBeenCalled();
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
