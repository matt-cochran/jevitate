import { expect, test, describe } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import {
  FederatedJourneyRegistry,
  FsAckStore,
  FsTrustStore,
  RemoteSource,
  UnknownSourceError,
  readLock,
  type GhPort,
  type GitExec,
  type JevitateManifest,
  type SharedJourneyFile,
} from "@jevitate/sources";
import { UnknownJourneyError } from "./journey-api.js";
import {
  addSource,
  listSources,
  pullSource,
  updateSource,
  removeSource,
  trustJourney,
  publishJourneyToSource,
  NotPromotedError,
  NoDeclaredOriginsError,
  type SourceApiDeps,
} from "./source-api.js";

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

function localJourney(
  id: string,
  opts: { promoted?: boolean; secret?: boolean; navUrl?: string } = {},
): Journey {
  const steps: Journey["recording"]["pages"][number]["steps"] = [
    { step: { kind: "navigate", url: opts.navUrl ?? `${ORIGIN}/`, expect: { kind: "visible", target: { label: "Home" } } } },
  ];
  if (opts.secret) {
    steps.push({
      step: {
        kind: "fill",
        target: { label: "Password" },
        value: { redacted: false, value: "hunter2" },
        expect: { kind: "visible", target: { testId: "ok" } },
      },
    });
  }
  return {
    metadata: { id, name: id, description: "local", promoted: opts.promoted ?? true, params: [], createdAtIso: "2026-01-01T00:00:00Z" },
    recording: { version: "1.0.0", site: ORIGIN, pages: [{ url: "/", steps }] },
  };
}

async function seedRemote(dir: string, files: SharedJourneyFile[], manifest: JevitateManifest = MANIFEST): Promise<void> {
  await writeFile(join(dir, "jevitate.json"), JSON.stringify(manifest));
  await mkdir(join(dir, "journeys"), { recursive: true });
  for (const f of files) {
    await writeFile(join(dir, "journeys", `${f.metadata.id}.journey.json`), JSON.stringify(f));
  }
}

/** Fake `GitExec` (args-array only, no network): `clone` populates the target
 *  dir via `seed`; `rev-parse HEAD` returns the current sha; `merge` advances
 *  it to `afterUpdate`. Records every call so tests can assert call shape. */
function makeFakeGit(opts: { seed?: (dir: string) => Promise<void>; head?: string; afterUpdate?: string }) {
  let head = opts.head ?? "a".repeat(40);
  const calls: string[][] = [];
  const git: GitExec = async (args) => {
    calls.push(args);
    if (args[0] === "clone") {
      const dir = args[2];
      await mkdir(dir, { recursive: true });
      if (opts.seed) await opts.seed(dir);
      return { stdout: "" };
    }
    if (args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (args[0] === "merge") {
      head = opts.afterUpdate ?? head;
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  return { git, calls, currentHead: () => head };
}

async function makeStores() {
  const root = await mkdtemp(join(tmpdir(), "src-api-"));
  return {
    root,
    sourcesDir: join(root, "sources"),
    lockPath: join(root, "jevitate.lock"),
    trust: new FsTrustStore(join(root, "trust")),
    ack: new FsAckStore(join(root, "trust", "acks")),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// #18 — jevitate source (add / list / pull / update / remove / trust)
// ---------------------------------------------------------------------------
describe("#18 jevitate source", () => {
  test("add clones, pins in the lock, surfaces ToU, and records NEITHER trust NOR ack without --accept-tou", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("checkout")]), head: "c".repeat(40) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };

    const res = await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });

    expect(res.pinnedCommit).toBe("c".repeat(40));
    expect(res.touSurface.gitUrl).toBe("https://git.test/shop.git");
    expect(res.touSurface.sites).toHaveLength(1);
    expect(res.touAccepted).toBe(false);

    const lock = await readLock(s.lockPath);
    expect(lock.sources).toEqual([{ name: "shop", gitUrl: "https://git.test/shop.git", pinnedCommit: "c".repeat(40) }]);

    // Adding a source NEVER trusts its Journeys and NEVER acks its ToU.
    expect(await s.trust.list()).toEqual([]);
    expect(await s.ack.get("shop")).toBeNull();
  });

  test("add --accept-tou records a Terms-of-Use ack (explicit user act)", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("checkout")]) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git, now: () => "2026-02-02T00:00:00Z" };

    const res = await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git", acceptTou: true, ackedBy: "matthew" });
    expect(res.touAccepted).toBe(true);
    const ack = await s.ack.get("shop");
    expect(ack).toMatchObject({ sourceName: "shop", gitUrl: "https://git.test/shop.git", ackedBy: "matthew", origins: [ORIGIN] });
  });

  test("list returns registered sources annotated with trusted journeys", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("checkout")]), head: "d".repeat(40) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });

    const listing = await listSources(deps);
    expect(listing).toEqual([
      { name: "shop", gitUrl: "https://git.test/shop.git", pinnedCommit: "d".repeat(40), trustedJourneys: [] },
    ]);
  });

  test("pull fetches but NEVER advances the pin", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("checkout")]), head: "e".repeat(40), afterUpdate: "f".repeat(40) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });

    const res = await pullSource(deps, "shop");
    expect(res).toEqual({ name: "shop", pulled: true, pinnedCommit: "e".repeat(40), pinAdvanced: false });
    expect(fake.calls).toContainEqual(["fetch"]);
    // Lock pin is unchanged by a pull.
    expect((await readLock(s.lockPath)).sources[0].pinnedCommit).toBe("e".repeat(40));
  });

  test("update advances the pin and rewrites the lock", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("checkout")]), head: "1".repeat(40), afterUpdate: "2".repeat(40) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });

    const res = await updateSource(deps, "shop");
    expect(res.pinnedCommit).toBe("2".repeat(40));
    expect((await readLock(s.lockPath)).sources[0].pinnedCommit).toBe("2".repeat(40));
  });

  test("remove deletes the clone and the lock entry", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("checkout")]) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });
    expect(await exists(join(s.sourcesDir, "shop"))).toBe(true);

    const res = await removeSource(deps, "shop");
    expect(res).toEqual({ name: "shop", removed: true });
    expect((await readLock(s.lockPath)).sources).toEqual([]);
    expect(await exists(join(s.sourcesDir, "shop"))).toBe(false);
  });

  test("pull/update/remove/trust on an unregistered source fail closed (UnknownSourceError)", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({});
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    await expect(pullSource(deps, "ghost")).rejects.toBeInstanceOf(UnknownSourceError);
    await expect(updateSource(deps, "ghost")).rejects.toBeInstanceOf(UnknownSourceError);
    await expect(removeSource(deps, "ghost")).rejects.toBeInstanceOf(UnknownSourceError);
    await expect(trustJourney(deps, { sourceName: "ghost", journeyId: "x", approvedBy: "m" })).rejects.toBeInstanceOf(UnknownSourceError);
  });

  test("trust records a hash-bound TrustRecord; unknown journey fails closed", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("risky", { risky: true })]) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git, now: () => "2026-03-03T00:00:00Z" };
    await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });

    const rec = await trustJourney(deps, { sourceName: "shop", journeyId: "risky", approvedBy: "matthew" });
    expect(rec).toMatchObject({ sourceId: "shop", journeyId: "risky", approvedBy: "matthew", approvedAtIso: "2026-03-03T00:00:00Z" });
    expect(rec.contentHash).toMatch(/^sha256:/);
    // Persisted.
    expect(await s.trust.get("shop", "risky")).toMatchObject({ contentHash: rec.contentHash });

    await expect(trustJourney(deps, { sourceName: "shop", journeyId: "nope", approvedBy: "m" })).rejects.toBeInstanceOf(UnknownJourneyError);
  });

  test("SECURITY: an untrusted source's risky journey is GATED until an explicit, hash-bound trust; a content change re-gates it (TOCTOU)", async () => {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, [sharedJourney("risky", { risky: true })]) });
    const deps: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    const added = await addSource(deps, { name: "shop", gitUrl: "https://git.test/shop.git" });

    const remote = new RemoteSource("shop", join(s.sourcesDir, "shop"), added.pinnedCommit);
    const fed = new FederatedJourneyRegistry([remote], s.trust);

    // Before trust: the remote risky journey surfaces as UNtrusted.
    const before = await fed.find("");
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ source: "shop", id: "risky", riskClass: "risky", trusted: false });

    // Explicit user act.
    await trustJourney(deps, { sourceName: "shop", journeyId: "risky", approvedBy: "matthew" });
    const after = await fed.find("");
    expect(after[0].trusted).toBe(true);

    // Content changes underneath the pin -> the prior review no longer applies.
    await seedRemote(join(s.sourcesDir, "shop"), [sharedJourney("risky", { risky: true }), sharedJourney("extra")]);
    // Mutate the trusted journey's bytes so its hash differs from the record.
    const mutated = sharedJourney("risky", { risky: true });
    mutated.metadata.description = "changed after review";
    await writeFile(join(s.sourcesDir, "shop", "journeys", "risky.journey.json"), JSON.stringify(mutated));
    const reGated = (await fed.find("")).find((m) => m.id === "risky");
    expect(reGated?.trusted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #19 — jevitate journey publish
// ---------------------------------------------------------------------------
describe("#19 jevitate journey publish", () => {
  const fakeGhAbsent: GhPort = { available: async () => false, createPr: async () => "" };

  async function withTargetSource() {
    const s = await makeStores();
    const fake = makeFakeGit({ seed: (dir) => seedRemote(dir, []) });
    const base: SourceApiDeps = { sourcesDir: s.sourcesDir, lockPath: s.lockPath, trust: s.trust, ack: s.ack, git: fake.git };
    await addSource(base, { name: "shop", gitUrl: "https://git.test/shop.git" });
    const journeysDir = join(s.root, "journeys");
    await mkdir(journeysDir, { recursive: true });
    return { s, fake, base, journeysDir };
  }

  async function writeLocal(journeysDir: string, j: Journey): Promise<void> {
    await writeFile(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
  }

  test("publishes a promoted journey onto a NEW publish/<id> branch and writes the file (gh absent -> instructions)", async () => {
    const { fake, base, journeysDir, s } = await withTargetSource();
    await writeLocal(journeysDir, localJourney("checkout"));

    const res = await publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "checkout", toSource: "shop" });

    expect(res.branch).toBe("publish/checkout");
    expect(res.pushed).toBe(true);
    expect(res.instructions).toBeTruthy();
    expect(res.prUrl).toBeUndefined();
    // Wrote the shared journey file into the clone, on a new branch, and pushed.
    expect(await exists(join(s.sourcesDir, "shop", "journeys", "checkout.journey.json"))).toBe(true);
    expect(fake.calls).toContainEqual(["checkout", "-b", "publish/checkout"]);
    expect(fake.calls).toContainEqual(["push", "-u", "origin", "publish/checkout"]);
    // The written file declares the derived origin.
    const written = JSON.parse(await readFile(join(s.sourcesDir, "shop", "journeys", "checkout.journey.json"), "utf8"));
    expect(written.declaredOrigins).toEqual([ORIGIN]);
  });

  test("opens a PR when gh is available", async () => {
    const { base, journeysDir } = await withTargetSource();
    await writeLocal(journeysDir, localJourney("checkout"));
    const gh: GhPort = { available: async () => true, createPr: async () => "https://git.test/shop/pull/1" };
    const res = await publishJourneyToSource({ ...base, gh }, { journeysDir, id: "checkout", toSource: "shop" });
    expect(res.prUrl).toBe("https://git.test/shop/pull/1");
  });

  test("refuses an unregistered target source (UnknownSourceError)", async () => {
    const { base, journeysDir } = await withTargetSource();
    await writeLocal(journeysDir, localJourney("checkout"));
    await expect(
      publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "checkout", toSource: "ghost" }),
    ).rejects.toBeInstanceOf(UnknownSourceError);
  });

  test("refuses an unknown journey id (UnknownJourneyError)", async () => {
    const { base, journeysDir } = await withTargetSource();
    await expect(
      publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "missing", toSource: "shop" }),
    ).rejects.toBeInstanceOf(UnknownJourneyError);
  });

  test("refuses an unpromoted journey (NotPromotedError)", async () => {
    const { base, journeysDir } = await withTargetSource();
    await writeLocal(journeysDir, localJourney("draft", { promoted: false }));
    await expect(
      publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "draft", toSource: "shop" }),
    ).rejects.toBeInstanceOf(NotPromotedError);
  });

  test("SECURITY: refuses a journey carrying a materialized secret value, and NEVER pushes", async () => {
    const { fake, base, journeysDir } = await withTargetSource();
    await writeLocal(journeysDir, localJourney("login", { secret: true }));
    await expect(
      publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "login", toSource: "shop" }),
    ).rejects.toMatchObject({ name: "EmbeddedSecretError" });
    // The guard fires BEFORE any git write/push.
    expect(fake.calls.some((c) => c[0] === "push")).toBe(false);
    expect(fake.calls.some((c) => c[0] === "commit")).toBe(false);
  });

  test("SECURITY: refuses an under-declared origin (UndeclaredOriginError)", async () => {
    const { base, journeysDir } = await withTargetSource();
    await writeLocal(journeysDir, localJourney("multi", { navUrl: "https://evil.test/" }));
    await expect(
      publishJourneyToSource(
        { ...base, gh: fakeGhAbsent },
        { journeysDir, id: "multi", toSource: "shop", declareOrigins: [ORIGIN] },
      ),
    ).rejects.toMatchObject({ name: "UndeclaredOriginError" });
  });

  test("#125: derives the origin from recording.site when navigate urls are all relative (explore-authored journeys)", async () => {
    const { base, journeysDir, s } = await withTargetSource();
    // Relative-only navigate -> collectNavigateOrigins yields nothing; the origin is derived
    // from recording.site instead of refusing.
    await writeLocal(journeysDir, localJourney("rel", { navUrl: "/home" }));
    const res = await publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "rel", toSource: "shop" });
    expect(res.pushed).toBe(true);
    const written = JSON.parse(await readFile(join(s.sourcesDir, "shop", "journeys", "rel.journey.json"), "utf8"));
    expect(written.declaredOrigins).toEqual([ORIGIN]);
  });

  test("refuses a journey with no declarable origins at all (NoDeclaredOriginsError)", async () => {
    const { base, journeysDir } = await withTargetSource();
    // Relative navigate AND a `site` that isn't a resolvable absolute URL -> nothing to derive.
    const journey: Journey = {
      metadata: { id: "norigin", name: "norigin", promoted: true, params: [], createdAtIso: "2026-01-01T00:00:00Z" },
      recording: {
        version: "1.0.0",
        site: "not-a-url",
        pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/home", expect: { kind: "visible", target: { label: "Home" } } } }] }],
      },
    };
    await writeLocal(journeysDir, journey);
    await expect(
      publishJourneyToSource({ ...base, gh: fakeGhAbsent }, { journeysDir, id: "norigin", toSource: "shop" }),
    ).rejects.toBeInstanceOf(NoDeclaredOriginsError);
  });
});
