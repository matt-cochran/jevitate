import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import type { JourneyChainRunner } from "./journey-chain.js";
import { assertParamTypes } from "./journey-param-types.js";

/**
 * #796: a chain handoff binds a producer's output to a consumer parameter. `guardChainRunner` wraps the
 * chain's runner (`JourneyChainDeps.runJourney`) so every run's params are checked against that Journey's
 * declared parameter types BEFORE the wrapped runner (so before a browser) is reached. A bound value of the
 * wrong type refuses that run with `ParamTypeError` (names and expected types only, never the value); the
 * run is never attempted, so it fails closed.
 */
export function guardChainRunner(runner: JourneyChainRunner, loadJourney?: (dir: string, id: string) => Promise<Journey | null>): JourneyChainRunner {
  const load = loadJourney ?? (async (dir, id) => (await new JourneyRegistry(new FsJourneyStore(dir)).get(id)) as Journey | null);
  return async (options) => {
    const journey = await load(options.dir, options.id);
    if (journey !== null) assertParamTypes(journey, options.params);
    return runner(options);
  };
}
