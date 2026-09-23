import { deriveParamSchema, validateParams } from "@jevitate/journey";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { JourneyRunner, type JourneyRunResult } from "@jevitate/runtime";
import {
  FederatedJourneyRegistry,
  GitSourceManager,
  RemoteSource,
  UnknownSourceError,
  loadManifest,
  readLock,
  resolveForRun,
  type RunGateDeps,
  type SharedJourneyFile,
  type SourceEntry,
} from "@jevitate/sources";
import type { SourceApiDeps } from "./source-api.js";

/**
 * The runner seam for a source-resolved Journey. Takes the ALREADY-GATED
 * `SharedJourneyFile` (`resolveForRun`'s output) — never a raw address or a
 * store `dir` — so the security gate always runs BEFORE anything reaches this
 * function. Injected as a fake in tests so unit tests never launch a real
 * browser; production wires `realResolvedJourneyRunner`.
 */
export type RunResolvedJourney = (
  file: SharedJourneyFile,
  params: Record<string, string>,
  policy: RunPolicy,
) => Promise<JourneyRunResult>;

/**
 * The real, Playwright-backed runner for a gated source Journey. Mirrors
 * `journey-api.ts`'s `runJourneyProgrammatically` exactly:
 *  - validates params UP FRONT (`deriveParamSchema`/`validateParams`) before
 *    any browser launch, so bad params never pay the cost/risk of a browser;
 *  - opens a real `PlaywrightBrowserPort` scoped to the Journey's authorized
 *    origins (the gate has already proven `declaredOrigins ⊆ manifest`);
 *  - ALWAYS closes the session and removes the temp profile dir in `finally`
 *    (matches the just-fixed profile-dir-leak pattern).
 * A `SharedJourneyFile` IS a `Journey` (+ `declaredOrigins`), so it runs
 * through the standard `JourneyRunner` unchanged.
 */
export const realResolvedJourneyRunner: RunResolvedJourney = async (file, params, policy) => {
  validateParams(deriveParamSchema(file.recording), params);

  // The browser allowlist is the Journey's authorized origin set — the base
  // site plus every gate-approved declared origin.
  const allowedOrigins = [...new Set([file.recording.site, ...file.declaredOrigins])];

  const port = new PlaywrightBrowserPort();
  const session = await port.open({
    headless: true,
    allowedOrigins,
    baseUrl: file.recording.site,
  });
  try {
    const actor = CastActor.named("source-runner").whoCan(new BrowseTheWeb(session, allowedOrigins));
    const runner = new JourneyRunner(actor, new RecordingInterpreter());
    return await runner.run({ journey: file, params, policy });
  } finally {
    await session.close();
  }
};

/**
 * Injected seams for `jevitate source run`. Reuses the distributed-sources
 * `SourceApiDeps` (sources clone dir + lock + local trust/ack stores + the
 * injectable `git` port) and adds a runner seam. Every field is injectable so
 * unit tests never touch the network, the real home dir, `git`, or a real
 * browser.
 */
export interface SourceRunApiDeps extends SourceApiDeps {
  /** Runner seam; defaults to `realResolvedJourneyRunner` in production. */
  runJourney?: RunResolvedJourney;
}

export interface RunSourceJourneyRequest {
  sourceName: string;
  journeyId: string;
  params: Record<string, string>;
  /** Defaults to `safeRunPolicy()` (Slice 1 fail-closed secret mode). */
  policy?: RunPolicy;
}

/** Resolves a registered source's recorded pin, or throws `UnknownSourceError`
 *  (fail-closed) — a source the lock does not know about is never treated as
 *  empty/absent. Mirrors `source-api.ts`'s private `requireEntry`. */
async function requireEntry(lockPath: string, name: string): Promise<SourceEntry> {
  const lock = await readLock(lockPath);
  const entry = lock.sources.find((s) => s.name === name);
  if (!entry) {
    throw new UnknownSourceError(`source '${name}' is not registered (run 'jevitate source add' first)`);
  }
  return entry;
}

/**
 * Runs a Journey that lives in a trusted remote source — the ONE programmatic
 * surface for `jevitate source run`. It NEVER bypasses the gate: it resolves
 * the Journey through `@jevitate/sources`' real `resolveForRun`, which runs the
 * full §9.8 "reviewed, pinned, in-origin, or refuse" ladder IN ORDER and THROWS
 * a typed error on any failure (unknown source/id, hash mismatch/TOCTOU,
 * untrusted-risky, undeclared origin, unacknowledged ToU, embedded secret).
 * Only a `SharedJourneyFile` that passes EVERY gate reaches the runner seam.
 *
 * The clone is checked out to the EXACT recorded pin before the gate reads it,
 * so the content the gate hashes is the content at the pin — not a drifted
 * working tree (matches `trustJourney`).
 */
export async function runSourceJourney(
  deps: SourceRunApiDeps,
  req: RunSourceJourneyRequest,
): Promise<JourneyRunResult> {
  // Unknown/unregistered source -> UnknownSourceError, before any run.
  const entry = await requireEntry(deps.lockPath, req.sourceName);

  const mgr = new GitSourceManager(deps.sourcesDir, deps.git);
  // Pin the clone to the recorded commit before the gate reads it (fail-closed:
  // `checkout` propagates if the pinned commit is absent — never HEAD).
  await mgr.checkout(req.sourceName, entry.pinnedCommit);

  const remote = new RemoteSource(req.sourceName, mgr.resolveDir(req.sourceName), entry.pinnedCommit);
  const fed = new FederatedJourneyRegistry([remote], deps.trust);

  const gateDeps: RunGateDeps = {
    fed,
    trust: deps.trust,
    manifestFor: (source) => loadManifest(mgr.resolveDir(source)),
    ackFor: (source) => deps.ack.get(source),
  };

  // The full trust boundary: throws on any refusal, returns the validated,
  // ready-to-run file only when every gate passes.
  const file = await resolveForRun(gateDeps, `${req.sourceName}/${req.journeyId}`);

  const run = deps.runJourney ?? realResolvedJourneyRunner;
  return run(file, req.params, req.policy ?? safeRunPolicy());
}
