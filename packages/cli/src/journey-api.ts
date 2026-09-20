import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry, deriveParamSchema, validateParams } from "@jevitate/journey";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { JourneyRunner, type JourneyRunResult } from "@jevitate/runtime";

/**
 * Distinct from `@jevitate/journey`'s `ParamValidationError` so CLI/API callers
 * can tell "no such journey" apart from "params didn't match the journey's
 * schema" without string-matching error messages.
 */
export class UnknownJourneyError extends Error {}

export interface RunJourneyProgrammaticallyOptions {
  /** Directory a `FsJourneyStore` reads Journey JSON files from. */
  dir: string;
  id: string;
  params: Record<string, string>;
  /** Defaults to `safeRunPolicy()` (Slice 1: fail-closed secret mode) when omitted. */
  policy?: RunPolicy;
}

/**
 * The one programmatic surface for "run this published Journey by id" —
 * used by BOTH the CLI `journey run` action and external callers. Builds
 * the real `FsJourneyStore` + `JourneyRegistry`, resolves the journey
 * (unknown id -> `UnknownJourneyError`), validates params UP FRONT with
 * `deriveParamSchema`/`validateParams` (unknown/missing param ->
 * `ParamValidationError`, from `@jevitate/journey`) BEFORE any browser is
 * launched, then builds the real Actor + `JourneyRunner` and runs.
 */
export async function runJourneyProgrammatically(
  opts: RunJourneyProgrammaticallyOptions,
): Promise<JourneyRunResult> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const journey = await registry.get(opts.id);
  if (!journey) {
    throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  }

  // Fail fast: validate BEFORE any browser launch, so bad params never pay
  // the cost (or risk) of opening a browser.
  validateParams(deriveParamSchema(journey.recording), opts.params);

  const policy = opts.policy ?? safeRunPolicy();

  const profileDir = await mkdtemp(join(tmpdir(), "doit-journey-run-"));
  const port = new PlaywrightBrowserPort();
  const session = await port.open({
    profileDir,
    headless: true,
    allowedOrigins: [journey.recording.site],
    baseUrl: journey.recording.site,
  });
  try {
    const actor = CastActor.named("cli-runner").whoCan(
      new BrowseTheWeb(session, [journey.recording.site]),
    );
    const runner = new JourneyRunner(actor, new RecordingInterpreter());
    return await runner.run({ journey, params: opts.params, policy });
  } finally {
    await session.close();
  }
}
