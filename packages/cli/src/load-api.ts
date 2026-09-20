import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry, deriveParamSchema, validateParams } from "@doit/journey";
import { safeRunPolicy, type RunPolicy } from "@doit/domain";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { RecordingInterpreter } from "@doit/interpreter";
import { JourneyRunner } from "@doit/runtime";
import { runLoadTest, type CapacityReport, type LoadActorRunner } from "@doit/load";

/** Distinct from `@doit/journey`'s ParamValidationError-style "unknown id" cases elsewhere, so CLI callers can branch without string-matching. */
export class UnknownLoadJourneyError extends Error {}

export interface RunJourneyLoadTestOptions {
  dir: string;
  id: string;
  params: Record<string, string>;
  concurrency: number;
  iterationsPerActor: number;
  seed: number;
  authorizedOrigins: readonly string[];
  /** Defaults to `safeRunPolicy()`, same convention as `journey-api.ts`'s `runJourneyProgrammatically`. */
  policy?: RunPolicy;
}

/**
 * The programmatic surface behind `brauto load run` — resolves a published
 * Journey (unknown id -> `UnknownLoadJourneyError`), validates params UP
 * FRONT, then hands `@doit/load`'s `runLoadTest` a factory that opens ONE
 * real headless Playwright session + `JourneyRunner` per pool member. The
 * authorized-target check happens inside `runLoadTest` itself — this
 * function does not duplicate or bypass it.
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

  return runLoadTest({
    targetOrigin: journey.recording.site,
    authorizedOrigins: opts.authorizedOrigins,
    concurrency: opts.concurrency,
    iterationsPerActor: opts.iterationsPerActor,
    seed: opts.seed,
    runnerFactory: async (actorIndex): Promise<LoadActorRunner> => {
      const profileDir = await mkdtemp(join(tmpdir(), `doit-load-actor-${actorIndex}-`));
      const port = new PlaywrightBrowserPort();
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
      return {
        run: () => runner.run({ journey, params: opts.params, policy }),
      };
    },
  });
}
