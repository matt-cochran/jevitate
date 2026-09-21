import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import {
  GitSourceManager,
  RemoteSource,
  UnknownSourceError,
  collectNavigateOrigins,
  loadManifest,
  publishJourney,
  readLock,
  surfaceForAck,
  writeLock,
  type AckStore,
  type GhPort,
  type GitExec,
  type PublishResult,
  type SiteDeclaration,
  type SourceEntry,
  type TrustRecord,
  type TrustStore,
} from "@jevitate/sources";
import { UnknownJourneyError } from "./journey-api.js";

const execFileAsync = promisify(execFile);

/**
 * A publish was requested for a Journey that exists locally but has not been
 * promoted. Publishing shares a Journey with the world — only reviewed,
 * promoted Journeys may leave this machine (spec §7). Kept distinct from
 * `UnknownJourneyError` so the CLI can emit a precise error code without
 * string-matching.
 */
export class NotPromotedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPromotedError";
  }
}

/**
 * A publish request resolved to zero declared origins — the Journey has no
 * absolute `navigate` origin and none were supplied with `--declare-origin`.
 * A `SharedJourneyFile` MUST declare at least one origin, so this fails
 * closed BEFORE `validateForPublish` (whose Zod error would be opaque).
 */
export class NoDeclaredOriginsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoDeclaredOriginsError";
  }
}

/**
 * Injected seams for the distributed-sources CLI (`jevitate source ...` and
 * `jevitate journey publish`). Every filesystem root, the git port, and the
 * clock are injectable so unit tests never touch the network, the real home
 * dir, or the real `git`/`gh` binaries. Mirrors the `*-api.ts` port-injection
 * convention already used by `explore-api.ts` / `journey-api.ts`.
 */
export interface SourceApiDeps {
  /** Root holding one clone subdir per source (prod: `~/.jevitate/sources`). */
  sourcesDir: string;
  /** Path to the team-shared `jevitate.lock` (prod: `<cwd>/jevitate.lock`). */
  lockPath: string;
  /** Local, per-user, content-hash-bound trust store (prod: `FsTrustStore`). */
  trust: TrustStore;
  /** Local, per-user Terms-of-Use acknowledgment store (prod: `FsAckStore`). */
  ack: AckStore;
  /** Injectable git execution port — a fake in tests (args-array only). */
  git?: GitExec;
  /** Injectable clock for `approvedAtIso` / `ackedAtIso` timestamps. */
  now?: () => string;
}

function mgrOf(deps: SourceApiDeps): GitSourceManager {
  return new GitSourceManager(deps.sourcesDir, deps.git);
}

function nowIso(deps: SourceApiDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

/**
 * Resolves a source `name` to its recorded `SourceEntry`, or throws
 * `UnknownSourceError` (fail-closed, FMECA #5) — a source the lock does not
 * know about is never silently treated as empty/absent. Reused by every
 * command that operates on an existing source (pull/update/remove/trust/
 * publish).
 */
async function requireEntry(lockPath: string, name: string): Promise<SourceEntry> {
  const lock = await readLock(lockPath);
  const entry = lock.sources.find((s) => s.name === name);
  if (!entry) {
    throw new UnknownSourceError(`source '${name}' is not registered (run 'jevitate source add' first)`);
  }
  return entry;
}

export interface AddSourceRequest {
  name: string;
  gitUrl: string;
  /** Whether the user explicitly accepted the source's Terms of Use. Without
   *  it, the source is still cloned/pinned/locked, but no `TouAck` is
   *  recorded, so the run-gate keeps refusing its Journeys (fail-closed). */
  acceptTou?: boolean;
  ackedBy?: string;
}

export interface AddSourceResult {
  name: string;
  gitUrl: string;
  pinnedCommit: string;
  /** The full `gitUrl` + declared sites shown to a human BEFORE acking —
   *  never truncated (spec §8, FMECA #5). Carries no secret values. */
  touSurface: { gitUrl: string; sites: SiteDeclaration[] };
  touAccepted: boolean;
}

/**
 * Clones a remote Journey source, pins it at its current HEAD, and records the
 * pin in the lock. Adding a source NEVER trusts its Journeys (trust is a
 * separate, explicit `source trust` act) — it only registers the source.
 * The source's Terms of Use are surfaced for the human; a `TouAck` is
 * recorded ONLY when `acceptTou` is set, so the run-gate stays fail-closed
 * until the user has explicitly accepted.
 */
export async function addSource(deps: SourceApiDeps, req: AddSourceRequest): Promise<AddSourceResult> {
  const mgr = mgrOf(deps);
  await mkdir(deps.sourcesDir, { recursive: true });
  const pinnedCommit = await mgr.add(req.name, req.gitUrl);
  const manifest = await loadManifest(mgr.resolveDir(req.name));
  const touSurface = surfaceForAck(manifest, req.gitUrl);

  let touAccepted = false;
  if (req.acceptTou) {
    await deps.ack.put({
      sourceName: req.name,
      gitUrl: req.gitUrl,
      origins: manifest.sites.map((s) => s.origin),
      ackedBy: req.ackedBy ?? "local",
      ackedAtIso: nowIso(deps),
    });
    touAccepted = true;
  }

  const lock = await readLock(deps.lockPath);
  const sources = lock.sources.filter((s) => s.name !== req.name);
  sources.push({ name: req.name, gitUrl: req.gitUrl, pinnedCommit });
  await writeLock(deps.lockPath, { version: 1, sources });

  return { name: req.name, gitUrl: req.gitUrl, pinnedCommit, touSurface, touAccepted };
}

export interface SourceListing extends SourceEntry {
  /** Journey ids in this source that carry a hash-bound `TrustRecord`. */
  trustedJourneys: string[];
}

/** Lists every registered source (from the lock), annotated with which of its
 *  Journeys the local user has explicitly trusted. */
export async function listSources(deps: SourceApiDeps): Promise<SourceListing[]> {
  const lock = await readLock(deps.lockPath);
  const trustRecords = await deps.trust.list();
  return lock.sources.map((s) => ({
    ...s,
    trustedJourneys: trustRecords
      .filter((t) => t.sourceId === s.name)
      .map((t) => t.journeyId)
      .sort(),
  }));
}

export interface PullSourceResult {
  name: string;
  pulled: boolean;
  pinnedCommit: string;
  /** Always `false`: `pull` fetches refs but NEVER advances the pin — that is
   *  `update`'s explicit job (spec §7/§9.9, no implicit auto-advance). */
  pinAdvanced: false;
}

/** Fetches new refs for a registered source without moving its pin. */
export async function pullSource(deps: SourceApiDeps, name: string): Promise<PullSourceResult> {
  const entry = await requireEntry(deps.lockPath, name);
  await mgrOf(deps).pull(name);
  return { name, pulled: true, pinnedCommit: entry.pinnedCommit, pinAdvanced: false };
}

export interface UpdateSourceResult {
  name: string;
  pinnedCommit: string;
}

/** The ONLY way a pin advances: fetch + fast-forward, then record the new pin
 *  in the lock. Explicit and per-source — never automatic. */
export async function updateSource(deps: SourceApiDeps, name: string): Promise<UpdateSourceResult> {
  await requireEntry(deps.lockPath, name);
  const pinnedCommit = await mgrOf(deps).update(name);
  const lock = await readLock(deps.lockPath);
  const sources = lock.sources.map((s) => (s.name === name ? { ...s, pinnedCommit } : s));
  await writeLock(deps.lockPath, { version: 1, sources });
  return { name, pinnedCommit };
}

export interface RemoveSourceResult {
  name: string;
  removed: boolean;
}

/** Removes a source's clone and its lock entry. Local `TrustRecord`s are left
 *  intact (they are hash-bound and harmless; re-adding the same content
 *  re-uses them, a content change invalidates them). */
export async function removeSource(deps: SourceApiDeps, name: string): Promise<RemoveSourceResult> {
  await requireEntry(deps.lockPath, name);
  await mgrOf(deps).remove(name);
  const lock = await readLock(deps.lockPath);
  const sources = lock.sources.filter((s) => s.name !== name);
  await writeLock(deps.lockPath, { version: 1, sources });
  return { name, removed: true };
}

export interface TrustJourneyRequest {
  sourceName: string;
  journeyId: string;
  approvedBy: string;
}

/**
 * Records an explicit, human trust decision for one Journey in a source,
 * BOUND to the Journey's CURRENT content hash at the recorded pin (spec §5,
 * FMECA #2 TOCTOU). Trust is the single explicit user act that lets a source's
 * risky Journey run: it never happens implicitly on `add`/`pull`/`update`, and
 * a later content change invalidates it (the run-gate recomputes the hash).
 */
export async function trustJourney(deps: SourceApiDeps, req: TrustJourneyRequest): Promise<TrustRecord> {
  const entry = await requireEntry(deps.lockPath, req.sourceName);
  const mgr = mgrOf(deps);
  // Pin the clone to the exact recorded commit before reading, so the hash we
  // bind trust to is the content AT the pin, not a drifted working tree.
  await mgr.checkout(req.sourceName, entry.pinnedCommit);
  const remote = new RemoteSource(req.sourceName, mgr.resolveDir(req.sourceName), entry.pinnedCommit);
  const sourced = await remote.get(req.journeyId);
  if (!sourced) {
    throw new UnknownJourneyError(`source '${req.sourceName}' has no journey '${req.journeyId}'`);
  }
  const record: TrustRecord = {
    sourceId: req.sourceName,
    journeyId: req.journeyId,
    contentHash: sourced.meta.contentHash,
    approvedBy: req.approvedBy,
    approvedAtIso: nowIso(deps),
  };
  await deps.trust.put(record);
  return record;
}

export interface PublishJourneyToSourceRequest {
  journeysDir: string;
  id: string;
  toSource: string;
  /** Explicit origin declarations. When empty, they are DERIVED from the
   *  Journey's absolute `navigate` origins (the author IS the trust boundary
   *  for their own content). */
  declareOrigins?: string[];
  asId?: string;
}

/**
 * Publishes a promoted local Journey to a registered distributed source via
 * `@jevitate/sources`' `publishJourney`. Preserves every publish-side guard:
 *  - the target source must be REGISTERED (`UnknownSourceError` otherwise);
 *  - the Journey must exist and be PROMOTED (`NotPromotedError`);
 *  - `publishJourney`/`validateForPublish` then hard-block a materialized
 *    (non-redacted) secret value (`EmbeddedSecretError`) and any origin the
 *    steps touch but `declaredOrigins` does not cover (`UndeclaredOriginError`).
 * The write always lands on a NEW `publish/<id>` branch — never a default
 * branch — and degrades gracefully to instructions when `gh` is absent.
 */
export async function publishJourneyToSource(
  deps: SourceApiDeps & { gh: GhPort },
  req: PublishJourneyToSourceRequest,
): Promise<PublishResult> {
  await requireEntry(deps.lockPath, req.toSource);
  const registry = new JourneyRegistry(new FsJourneyStore(req.journeysDir));
  const journey = await registry.get(req.id);
  if (!journey) {
    throw new UnknownJourneyError(`unknown journey '${req.id}'`);
  }
  if (!journey.metadata.promoted) {
    throw new NotPromotedError(`journey '${req.id}' is not promoted; promote it before publishing`);
  }
  const declaredOrigins =
    req.declareOrigins && req.declareOrigins.length > 0
      ? req.declareOrigins
      : collectNavigateOrigins(journey.recording);
  if (declaredOrigins.length === 0) {
    throw new NoDeclaredOriginsError(
      `journey '${req.id}' declares no origins and navigates to no absolute origin; pass --declare-origin <origin>`,
    );
  }
  return publishJourney(mgrOf(deps), deps.gh, {
    journey,
    declaredOrigins,
    toSource: req.toSource,
    asId: req.asId,
  });
}

/**
 * Real `gh` CLI port for `publishJourney`. Degrades gracefully: `available()`
 * is false when `gh` isn't installed/authenticated, so publish falls back to
 * printed branch+push instructions instead of failing (spec §14.3). Shells via
 * `execFile` with an ARGS ARRAY only — never a shell string.
 */
export const realGhPort: GhPort = {
  async available(): Promise<boolean> {
    try {
      await execFileAsync("gh", ["auth", "status"]);
      return true;
    } catch {
      return false;
    }
  },
  async createPr(cwd: string, branch: string, title: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "create", "--head", branch, "--title", title, "--body", title],
      { cwd },
    );
    return stdout.trim();
  },
};
