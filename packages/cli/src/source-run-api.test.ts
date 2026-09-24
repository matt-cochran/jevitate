import { expect, test, describe } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsAckStore,
  FsTrustStore,
  HashMismatchError,
  UndeclaredTouError,
  UnknownSourceError,
  UntrustedRiskyJourneyError,
  type GitExec,
  type JevitateManifest,
  type SharedJourneyFile,
} from "@jevitate/sources";
import type { JourneyRunResult } from "@jevitate/runtime";
import { safeRunPolicy } from "@jevitate/domain";
import { addSource, trustJourney, type SourceApiDeps } from "./source-api.js";
import { runSourceJourney, realResolvedJourneyRunner, type RunResolvedJourney } from "./source-run-api.js";
import { JourneyRequiresAuthError } from "./journey-api.js";

const ORIGIN = "https://shop.test";

const MANIFEST: JevitateManifest = {
  version: 1,
  source: "shop",
  sites: [{ origin: ORIGIN, automationPolicy: "allowed", touBasis: "public terms" }],
};

function sharedJourney(id: string, opts: { risky?: boolean } = {}): SharedJourneyFile {
  const steps: SharedJourneyFile["recording"]["pages"][number]["steps"] = [
    { step: { kind: "navigate", url: `${ORIGIN}/`, expect: { kind: "visible", target: { label: "Home" } } } },
  ];
  if (opts.risky) {
    steps.push({
      step: { kind: "click", target: { role: "button", name: "Buy" }, expect: { kind: "visible", target: { testId: "cart" } } },
    });
  }
  return {
    metadata: { id, name: id, description: "shared", promoted: true, params: [], createdAtIso: "2026-01-01T00:00:00Z" },
    recording: { version: "1.0.0", site: ORIGIN, pages: [{ url: "/", steps }] },
    declaredOrigins: [ORIGIN],
  };
}

async function seedRemote(dir: string, files: SharedJourneyFile[], manifest: JevitateManifest = MANIFEST): Promise<void> {
  await writeFile(join(dir, "jevitate.json"), JSON.stringify(manifest));
  await mkdir(join(dir, "journeys"), { recursive: true });
  for (const f of files) {
    await writeFile(join(dir, "journeys", `${f.metadata.id}.journey.json`), JSON.stringify(f));
  }
}

/** Fake `GitExec` (args-array only, no network): `clone` seeds the target dir;
 *  `rev-parse HEAD` returns a fixed sha; everything else is a no-op. */
function makeFakeGit(seed?: (dir: string) => Promise<void>): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitExec = async (args) => {
    calls.push(args);
    if (args[0] === "clone") {
      await mkdir(args[2], { recursive: true });
      if (seed) await seed(args[2]);
      return { stdout: "" };
    }
    if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n` };
    return { stdout: "" };
  };
  return { git, calls };
}

async function makeStores() {
  const root = await mkdtemp(join(tmpdir(), "src-run-api-"));
  return {
    root,
    sourcesDir: join(root, "sources"),
    lockPath: join(root, "jevitate.lock"),
    trust: new FsTrustStore(join(root, "trust")),
    ack: new FsAckStore(join(root, "trust", "acks")),
  };
}

/** A runner seam spy: records whether it ran and what it was handed, so the
 *  asserts-it-refuses tests can prove NO browser/run happened past a gate. */
function makeRunnerSpy() {
  const calls: { file: SharedJourneyFile; params: Record<string, string>; storageState?: string }[] = [];
  const runJourney: RunResolvedJourney = async (file, params, _policy, storageState) => {
    calls.push({ file, params, storageState });
    return { outcome: "ok", output: { ran: file.metadata.id } } satisfies JourneyRunResult;
  };
  return { runJourney, calls };
}

describe("#26 runSourceJourney (run-gate wired)", () => {
  test("runs a read-only journey from a trusted, ToU-acked source through the gate", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("checkout")]));
    const spy = makeRunnerSpy();
    const deps: SourceApiDeps & { runJourney: RunResolvedJourney } = {
      sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney,
    };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true, ackedBy: "matthew" });

    const result = await runSourceJourney(deps, { sourceName: "shop", journeyId: "checkout", params: {} });

    expect(result).toMatchObject({ outcome: "ok" });
    expect(spy.calls).toHaveLength(1);
    // The gate handed the runner the resolved SharedJourneyFile itself.
    expect(spy.calls[0].file.metadata.id).toBe("checkout");
    expect(spy.calls[0].file.declaredOrigins).toEqual([ORIGIN]);
  });

  test("#118: passes an optional storageState PATH through to the runner seam", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("checkout")]));
    const spy = makeRunnerSpy();
    const deps: SourceApiDeps & { runJourney: RunResolvedJourney } = {
      sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney,
    };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true, ackedBy: "matthew" });

    await runSourceJourney(deps, { sourceName: "shop", journeyId: "checkout", params: {}, storageState: "/tmp/state.json" });

    expect(spy.calls[0].storageState).toBe("/tmp/state.json");
  });

  test("SECURITY: refuses an UNREGISTERED source (UnknownSourceError) and NEVER runs", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit();
    const spy = makeRunnerSpy();
    const deps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney };
    await expect(
      runSourceJourney(deps, { sourceName: "ghost", journeyId: "checkout", params: {} }),
    ).rejects.toBeInstanceOf(UnknownSourceError);
    expect(spy.calls).toHaveLength(0);
  });

  test("SECURITY: refuses an unknown journey id within a known source and NEVER runs", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("checkout")]));
    const spy = makeRunnerSpy();
    const deps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true });
    await expect(
      runSourceJourney(deps, { sourceName: "shop", journeyId: "nope", params: {} }),
    ).rejects.toBeInstanceOf(UnknownSourceError);
    expect(spy.calls).toHaveLength(0);
  });

  test("SECURITY: refuses an UNTRUSTED risky journey (UntrustedRiskyJourneyError) and NEVER runs", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("risky", { risky: true })]));
    const spy = makeRunnerSpy();
    const deps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true });
    await expect(
      runSourceJourney(deps, { sourceName: "shop", journeyId: "risky", params: {} }),
    ).rejects.toBeInstanceOf(UntrustedRiskyJourneyError);
    expect(spy.calls).toHaveLength(0);
  });

  test("runs a risky journey once it is explicitly, hash-bound trusted", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("risky", { risky: true })]));
    const spy = makeRunnerSpy();
    const deps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true });
    await trustJourney(deps, { sourceName: "shop", journeyId: "risky", approvedBy: "matthew" });

    const result = await runSourceJourney(deps, { sourceName: "shop", journeyId: "risky", params: {} });
    expect(result).toMatchObject({ outcome: "ok" });
    expect(spy.calls).toHaveLength(1);
  });

  test("SECURITY: TOCTOU — a content change after trust re-gates the journey (HashMismatchError) and NEVER runs", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("risky", { risky: true })]));
    const spy = makeRunnerSpy();
    const deps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true });
    await trustJourney(deps, { sourceName: "shop", journeyId: "risky", approvedBy: "matthew" });

    // Mutate the trusted journey's bytes under the pin -> its hash no longer
    // matches the recorded TrustRecord.
    const mutated = sharedJourney("risky", { risky: true });
    mutated.metadata.description = "changed after review";
    await writeFile(join(s.sourcesDir, "shop", "journeys", "risky.journey.json"), JSON.stringify(mutated));

    await expect(
      runSourceJourney(deps, { sourceName: "shop", journeyId: "risky", params: {} }),
    ).rejects.toBeInstanceOf(HashMismatchError);
    expect(spy.calls).toHaveLength(0);
  });

  test("SECURITY: refuses to run when the source's Terms of Use are not acknowledged (UndeclaredTouError) and NEVER runs", async () => {
    const s = await makeStores();
    const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("checkout")]));
    const spy = makeRunnerSpy();
    const deps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git, runJourney: spy.runJourney };
    // add WITHOUT --accept-tou: no TouAck recorded.
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });
    await expect(
      runSourceJourney(deps, { sourceName: "shop", journeyId: "checkout", params: {} }),
    ).rejects.toBeInstanceOf(UndeclaredTouError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("#118 realResolvedJourneyRunner: metadata.requiresAuth fails fast with no storageState", () => {
  test("refuses BEFORE any browser launch when the file declares requiresAuth and no storageState is given", async () => {
    const file: SharedJourneyFile = { ...sharedJourney("checkout"), metadata: { ...sharedJourney("checkout").metadata, requiresAuth: true } };
    await expect(realResolvedJourneyRunner(file, {}, safeRunPolicy())).rejects.toBeInstanceOf(JourneyRequiresAuthError);
  });
});
