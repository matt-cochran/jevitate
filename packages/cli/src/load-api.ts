import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry, deriveParamSchema, validateParams } from "@jevitate/journey";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { JourneyRunner } from "@jevitate/runtime";
import { runLoadTest, type CapacityReport, type LoadActorRunner } from "@jevitate/load";

/** Distinct from `@jevitate/journey`'s ParamValidationError-style "unknown id" cases elsewhere, so CLI callers can branch without string-matching. */
export class UnknownLoadJourneyError extends Error {}

export interface RunJourneyLoadTestOptions {
  dir: string;
  id: string;
  params: Record<string, string>;
  concurrency: number;
  iterationsPerActor: number;
  /**
   * Governs deterministic actor fan-out/scheduling only (see
   * `@jevitate/load`'s `RunLoadTestConfig.seed` doc comment) — the real
   * `JourneyRunner` this function drives per pool member has no pacing
   * hook, so this `seed` does NOT (yet) produce human-speed pacing of the
   * real run the way `modeledCapacityReport`'s `seed` drives
   * `simulateTiming()`. Known gap, deferred to a future slice.
   */
  seed: number;
  authorizedOrigins: readonly string[];
  /** Defaults to `safeRunPolicy()`, same convention as `journey-api.ts`'s `runJourneyProgrammatically`. */
  policy?: RunPolicy;
  /**
   * Testing seam: overrides the real `PlaywrightBrowserPort` used per pool
   * member with a fake, so the per-actor browser-session lifecycle (see
   * `runnerFactory` below) can be unit-tested with no real browser. Defaults
   * to `() => new PlaywrightBrowserPort()`.
   */
  browserPortFactory?: () => BrowserPort;
}

/**
 * The programmatic surface behind `jevitate load run` — resolves a published
 * Journey (unknown id -> `UnknownLoadJourneyError`), validates params UP
 * FRONT, then hands `@jevitate/load`'s `runLoadTest` a factory that opens ONE
 * real headless Playwright session + `JourneyRunner` per pool member. The
 * authorized-target check happens inside `runLoadTest` itself — this
 * function does not duplicate or bypass it.
 *
 * NOTE on "seeded ⇒ reproducible / human-paced" (corrected post-review):
 * `opts.seed` makes the ACTOR POOL's composition reproducible (via
 * `deriveActorSeeds` inside `runLoadTest`) — it does not yet make the real
 * run human-paced, because `JourneyRunner` (constructed below) has no
 * pacing hook to seed. Only the offline `modeledCapacityReport` path is
 * genuinely human-paced today, via `@jevitate/domain`'s `simulateTiming()`.
 */
export async function runJourneyLoadTest(opts: RunJourneyLoadTestOptions): Promise<CapacityReport> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const journey = await registry.get(opts.id);
  if (!journey) {
    throw new UnknownLoadJourneyError(`unknown journey '${opts.id}'`);
  }

  validateParams(deriveParamSchema(journey.recording), opts.params);

  const policy = opts.policy ?? safeRunPolicy();
  const browserPortFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());

  return runLoadTest({
    targetOrigin: journey.recording.site,
    authorizedOrigins: opts.authorizedOrigins,
    concurrency: opts.concurrency,
    iterationsPerActor: opts.iterationsPerActor,
    seed: opts.seed,
    runnerFactory: async (actorIndex): Promise<LoadActorRunner> => {
      const profileDir = await mkdtemp(join(tmpdir(), `doit-load-actor-${actorIndex}-`));
      const port = browserPortFactory();
      const session = await port.open({
        profileDir,
        headless: true,
        allowedOrigins: [journey.recording.site],
        baseUrl: journey.recording.site,
      });
      const actor = CastActor.named(`load-actor-${actorIndex}`).whoCan(
        new BrowseTheWeb(session, [journey.recording.site]),
      );
      const runner = new JourneyRunner(actor, new RecordingInterpreter());

      // `runLoadTest` calls `run()` exactly `iterationsPerActor` times for
      // this actor — success or failure, never more, never fewer (see
      // measured-load-runner.ts's per-actor loop). Closing the real browser
      // session on EVERY `run()` would defeat pooling (a fresh browser
      // launch per iteration); never closing it leaks a Chromium process +
      // tmp profile dir per actor per invocation, worse as `--concurrency`
      // scales — the whole point of a load harness. So: reuse one session
      // across this actor's iterations, and close it in a `finally` once
      // the LAST iteration finishes OR throws — mirroring `journey-api.ts`'s
      // `try { ... } finally { await session.close(); }`.
      let remainingIterations = opts.iterationsPerActor;
      return {
        run: async () => {
          try {
            return await runner.run({ journey, params: opts.params, policy });
          } finally {
            remainingIterations--;
            if (remainingIterations <= 0) {
              await session.close();
            }
          }
        },
      };
    },
  });
}
