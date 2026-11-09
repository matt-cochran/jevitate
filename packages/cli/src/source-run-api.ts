import { prepareMcpRunGuard } from "./mcp-run-guard.js";
import { guardRequestWithMode, resolveSurfaceRunMode, runModeRecord, type RunModeRecord } from "./run-surface-mode.js";
import type { RunTarget } from "./journey-run-mode-gate.js";
import { journeyParamSchema, secretParamNames, secretParamValues, validateParams } from "@jevitate/journey";
import { createHttpProbe, httpCheckRefs } from "./http-probe.js";
import type { SiteGateDeps } from "@jevitate/runtime";
import { gateJourney } from "./site-gate-cli.js";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type EmulationSpec } from "@jevitate/playwright";
import { sessionLaunchOptions } from "./browser-run-options.js";
import { JourneyOutcomeChecks } from "./journey-network-checks.js";
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
import { inMcpInvocation } from "./approval-provenance.js";
import { SecretParamOverMcpError, secretParamArgvWarning, secretParamsCarriedBy, withSecretParamsFor } from "./secret-params.js";
import { JourneyRequiresAuthError, journeyFixtureBaseDir, redactErrorSecrets, redactSecretParams } from "./journey-api.js";

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
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`, #118) — the
   * deterministic authenticated pre-step. Contains live session cookies: handed only to the
   * browser, never logged, never sent to a model.
   */
  storageState?: string,
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  emulation?: EmulationSpec,
  /** Chromium launch options (CLI `--browser-executable` / `--browser-channel` / `--browser-arg`). */
  browser?: BrowserLaunchOptions,
  /** The site-policy gate (`jevitate site policy set`): pacing, throttles, budgets, quiet hours. */
  siteGate?: SiteGateDeps,
  /** 0.30.0 §5: the run mode `runSourceJourney` decided for the Journey's site; the #789 guard is given it. */
  runMode?: RunTarget,
  /** Where test mode's relaxations are noted, for the result's `run.notes`. */
  modeNotes?: string[],
) => Promise<JourneyRunResult>;

/**
 * The real, Playwright-backed runner for a gated source Journey. Mirrors
 * `journey-api.ts`'s `runJourneyProgrammatically` exactly:
 *  - validates params UP FRONT (`journeyParamSchema`/`validateParams`) before
 *    any browser launch, so bad params never pay the cost/risk of a browser;
 *  - opens a real `PlaywrightBrowserPort` scoped to the Journey's authorized
 *    origins (the gate has already proven `declaredOrigins ⊆ manifest`);
 *  - ALWAYS closes the session and removes the temp profile dir in `finally`
 *    (matches the just-fixed profile-dir-leak pattern).
 * A `SharedJourneyFile` IS a `Journey` (+ `declaredOrigins`), so it runs
 * through the standard `JourneyRunner` unchanged.
 */
export const realResolvedJourneyRunner: RunResolvedJourney = async (file, params, policy, storageState, emulation, browser, siteGate, runMode, modeNotes = []) => {
  // #118: a Journey that declares it needs auth refuses BEFORE any browser launch when no
  // storageState was given — a clear, typed failure instead of a deep `replay-target-not-found`.
  if (file.metadata.requiresAuth === true && storageState === undefined) {
    throw new JourneyRequiresAuthError(
      `journey '${file.metadata.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`,
    );
  }

  validateParams(journeyParamSchema(file), params);

  // The browser allowlist is the Journey's authorized origin set — the base
  // site plus every gate-approved declared origin.
  const allowedOrigins = [...new Set([file.recording.site, ...file.declaredOrigins])];

  // #789: under an MCP invocation (`sources run`), this run's guard: a production target is refused here.
  const guardReq = { site: file.recording.site, allowedOrigins };
  const runGuard = prepareMcpRunGuard(runMode === undefined ? guardReq : guardRequestWithMode(guardReq, runMode, modeNotes));

  // The site policy for the Journey's origin, decided before the browser opens.
  const gate = await gateJourney(siteGate, file.recording, { enforceLimits: true });
  const port = new PlaywrightBrowserPort();
  const session = await port.open({
    ...sessionLaunchOptions(browser),
    allowedOrigins,
    baseUrl: file.recording.site,
    ...emulation,
    ...(storageState !== undefined ? { storageState } : {}),
  });
  try {
    await runGuard?.arm(session, params);
    const actor = CastActor.named("source-runner").whoCan(new BrowseTheWeb(session, allowedOrigins), ...gate.abilities);
    // #322/#400: a trusted remote Journey's end state and step request checks hold for its replay too.
    // #543: its http end-state checks request only origins in this same allowlist.
    const refs = httpCheckRefs({ params, secretParams: secretParamNames(file, params) });
    const outcomeChecks = new JourneyOutcomeChecks(session.page, file, {
      httpProbe: createHttpProbe({ allowlist: allowedOrigins }),
      resolveRef: refs,
    });
    const observer = outcomeChecks.observer();
    // #565: a step expectation's references resolve from the same names (a secret one refused).
    const runner = new JourneyRunner(actor, new RecordingInterpreter({ ...(observer === undefined ? {} : { observer }), ...(runGuard === undefined ? {} : { actionGuard: runGuard }), fixtureBaseDir: journeyFixtureBaseDir(), refLookup: refs }));
    try {
      const result = await outcomeChecks.run(actor, () => runner.run({ journey: file, params, policy }));
      runGuard?.check();
      return result;
    } finally {
      await gate.done();
    }
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
  /** Told when a secret parameter's value came from `--param`, on the command line. */
  warn?: (line: string) => void;
  /** Defaults to `safeRunPolicy()` (Slice 1 fail-closed secret mode). */
  policy?: RunPolicy;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`, #118) — the
   * deterministic authenticated pre-step. Contains live session cookies: handed only to the
   * browser, never logged, never sent to a model.
   */
  storageState?: string;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  emulation?: EmulationSpec;
  /** Chromium launch options (CLI `--browser-*`). */
  browser?: BrowserLaunchOptions;
  /** The site-policy gate (`jevitate site policy set`); absent = no site policy. */
  siteGate?: SiteGateDeps;
  /**
   * #827: `source run --secret-field` bindings (CLI only): a secret parameter from the environment, off the
   * command line, typed only inside the run's allowlist (the Journey's site and its gate-approved origins).
   */
  secretFields?: readonly string[];
  /** Where a `--secret-field` `env:` source is read (default `process.env`). */
  secretEnv?: Readonly<Record<string, string | undefined>>;
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
/** The result carries `run` (`run.mode`, `run.target.trust`, 0.30.0 §5) beside the replay's own fields. */
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

  // A secret parameter's value never travels through an MCP request; on the CLI it is on the command line.
  if (inMcpInvocation()) {
    const carried = secretParamsCarriedBy(file, req.params);
    if (carried.length > 0) throw new SecretParamOverMcpError(carried);
  } else {
    const warning = secretParamArgvWarning(file, req.params, "source run");
    if (warning !== undefined) req.warn?.(warning);
  }
  // #827: on the CLI, a --secret-field binding supplies a secret parameter from the environment. Never over MCP:
  // a source's Journey is someone else's, so nothing of the operator's is typed into it from a tool call.
  const params = inMcpInvocation() || (req.secretFields ?? []).length === 0 ? req.params : withSecretParamsFor(file, { id: req.journeyId, params: req.params, flags: req.secretFields ?? [], targetFields: undefined, targetOrigin: undefined, env: req.secretEnv ?? process.env }).params;

  // 0.30.0 §5: the run mode of the Journey's site, from the person-written files only. The approval-channel
  // rule does not apply: a source Journey runs only once a person trusted it (`source trust`, a CLI act no
  // MCP tool has), which is the person's approval. The mode reaches the #789 guard and the result.
  const decided = resolveSurfaceRunMode({ surface: "source", origin: file.recording.site });
  const modeNotes: string[] = [];
  const run = deps.runJourney ?? realResolvedJourneyRunner;
  // #399: a secret parameter (e.g. a token in a navigate URL) never comes back — not in the
  // result, not in an escaping error — exactly as `journey run` redacts it.
  try {
    const result = await run(file, params, req.policy ?? safeRunPolicy(), req.storageState, req.emulation, req.browser, req.siteGate, decided, modeNotes);
    const withMode: JourneyRunResult & { readonly run: RunModeRecord } = { ...result, run: runModeRecord(decided, modeNotes) };
    return redactSecretParams(withMode, file, params);
  } catch (err) {
    throw redactErrorSecrets(err, secretParamValues(file, params));
  }
}
