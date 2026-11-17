// journey-api-run.ts — the phases `journey-api.ts`'s `runStoredJourney` orchestrates. The original
// file keeps `runStoredJourney` (and its signature) and the public type surface; every helper here
// takes its inputs and returns its outputs explicitly. Nothing here imports `journey-api.ts`.
import { NOT_A_CREDENTIAL_WAY_OUT, assertBoundSecretsOnOrigins, currentBoundSecretParams, fixtureSecretNeeds, masksExtractedValue, resolveBoundSecretOrigins, secretBoundNeeds } from "./secret-params.js";
import { JourneyRunEvidenceWriter, type WriteReceipt } from "./journey-run-evidence.js";
import { hasRunHooks, resolveRunMode, runReadDoneCheckHooks, runValidateParamsHooks, withRunHookGuard, type RunHookContext, type RunHookTarget, type RunMode } from "./journey-run-hooks.js";
import { prepareMcpRunGuard } from "./mcp-run-guard.js";
import { declaredNonSecretParams, describeStep, flatJourneySteps, journeyEndState, journeyParamSchema, journeyPrefix, loadRefusedParamNames, secretParamValues, validateParams, type HandbackOutcome, type Journey } from "@jevitate/journey";
import { assertHttpChecksAllowed, createHttpProbe, httpCheckRefs } from "./http-probe.js";
import { inMcpInvocation } from "./approval-provenance.js";
import { mcpMayBindTargetSecrets, resolveRunTarget } from "./journey-run-mode-gate.js";
import { planSecretRun, secretHandbackHandler, secretOriginRefusalOf, withSecretHandbacks } from "./journey-secret-mode.js";
import { JourneyRequiresAuthError } from "./journey-api-errors.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { registerDeclaredSecrets } from "@jevitate/ai-core";
import { safeRunPolicy, clock, type RunPolicy } from "@jevitate/domain";
import { join } from "node:path";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import { assertSameExtensionBuild, closeOnce, finalizeVideos, runVideoDir, sessionLaunchOptions } from "./browser-run-options.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { RecordingInterpreter, type StepObserver } from "@jevitate/interpreter";
import { ReplayDeltas, replayDeltaSummary, type BlockedWrite, type ReplayDeltaSummary } from "@jevitate/explore";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { SecretPixelMask, maskingPort } from "./demo-capture.js";
import { RunScreenshots, composeObservers, screenshotObserver, screenshotsDirFor, type ScreenshotsResult } from "./run-screenshots.js";
import { JourneyRunner, type JourneyHealOptions, type JourneyRunResult } from "@jevitate/runtime";
import { journeyStepRisk } from "./journey-heal.js";
import { installHealProbeGuard } from "./heal-probe-guard.js";
import { gateJourney } from "./site-gate-cli.js";
import { substituteSetupRefs, type FixtureRecord, type MissionFixtures } from "./mission-fixtures.js";
import { applyJourneyEnvironment } from "./environments.js";
import { JourneyOutcomeChecks, type OutcomeCheckFailure, type SlowStep } from "./journey-network-checks.js";
import { assertHandbackNoHeal, attachHandback, HandbackWriteObserver } from "./journey-handback.js";
import { effectiveAllowedOrigins, prefixParams, redactSecretValues, runSecretValues } from "./journey-api-redaction.js";
import { healObserver, persistHealRun, stepWriteBlocker, watchOffAllowlistWrites } from "./journey-api-heal.js";
import type { HealRunFields, MutationReplayOptions, RunJourneyProgrammaticallyOptions } from "./journey-api-heal.js";

/** #401/#402: what a mutation-proof replay returns beyond `journey run`'s result. */
export interface MutationReplayFields {
  /** The step-request / end-state checks that failed (`structuredFailures`). */
  outcomeFailures?: OutcomeCheckFailure[];
  /** The writes aborted in `blockWritesAtStep`'s window, and after it (`blockAfterWindow`). */
  blockedWrites?: BlockedWrite[];
  /** `METHOD /path` of a blocked line a server answered after the window all the same (a popup, a worker). */
  blockEscaped?: string[];
}

/** The result `runJourneyProgrammatically` resolves with (the `journey run` surface's own). */
export type RunJourneyResult = JourneyRunResult & { fixtures?: FixtureRecord; videoPaths?: string[]; actionDeltas?: ReplayDeltaSummary; slowSteps?: SlowStep[]; offAllowlistWrites?: string[]; handback?: HandbackOutcome; writes?: WriteReceipt[] } & Partial<ScreenshotsResult> & MutationReplayFields & HealRunFields;

/** One run's evidence: the writer, the steps the replay reported, and how the record is finished. */
export interface RunEvidenceScope {
  readonly writer: JourneyRunEvidenceWriter;
  readonly hooks: { mode: RunMode | undefined };
  /** A StepObserver feeding the writer: the step each write belongs to, and how each step ended. */
  observer(): StepObserver;
  /** The steps of the Journey that ran (a prefix or environment changes none of their kinds). */
  ran(journey: Journey): void;
  finish(err: unknown, result?: RunJourneyResult): string | undefined;
}

/** The fixed inputs every phase of one stored-journey run reads. */
export interface StoredJourneyRunContext {
  readonly opts: RunJourneyProgrammaticallyOptions;
  readonly mutation: MutationReplayOptions;
  readonly stored: Journey;
  readonly evidence: RunEvidenceScope | undefined;
  /** `opts.fixtureBaseDir`, else the project root (#488/#498) — read when the interpreter is built. */
  readonly fixtureBaseDir: () => string | undefined;
  /** The origins a bound secret may be typed on for this run (`operatorAllowedOrigins`, kept in `journey-api.ts`). */
  readonly operatorAllowedOrigins: (journey: Journey) => string[];
}

/** The mutable run state the phases share: the params after fixture substitution, and the declared-secret registration. */
export interface StoredJourneyRunState {
  params: Record<string, string>;
  declaredSecrets: { release(): void } | undefined;
}

/** Everything the pre-browser phase resolved, threaded to the phases that run after it. */
export interface StoredJourneyRunPreparation {
  readonly full: Journey;
  readonly journey: Journey;
  readonly target: RunHookTarget;
  readonly allowedOrigins: string[];
  readonly inputParams: Record<string, string>;
  readonly mode: RunMode | undefined;
  readonly hookCtx: () => RunHookContext;
  readonly knownValues: Set<string>;
  readonly noteKnown: (v: string) => void;
  readonly secretPlan: ReturnType<typeof planSecretRun>;
  readonly resolvedBound: ReturnType<typeof resolveBoundSecretOrigins>;
  readonly replayed: Journey;
  readonly runGuard: ReturnType<typeof prepareMcpRunGuard>;
  readonly policy: RunPolicy;
  readonly gate: Awaited<ReturnType<typeof gateJourney>>;
}

/** #564: a run's full secret set — its secret-param values plus every value the run bound under a credential-like name. */
const secretBoundNoHeal = (needs: readonly string[]): string =>
  `${needs.length === 0 ? "this run holds a secret (a secret parameter, a fixture secret or an extracted credential)" : `this Journey needs ${needs.join(", ")}`}, and nothing secret-bound goes to a model. Fix the step by hand, or heal a Journey that needs no secret. ${NOT_A_CREDENTIAL_WAY_OUT}`;

/** Resolve the journey, its environment/prefix, params and secret plan, then the run guard, policy and site gate — all before any browser. */
export async function prepareStoredJourneyRun(ctx: StoredJourneyRunContext): Promise<StoredJourneyRunPreparation> {
  const { opts, mutation, stored, evidence } = ctx;
  // #247: onto the chosen environment (a step on an origin neither it nor #803 `--allow` allows is refused here).
  let full = applyJourneyEnvironment(stored, opts.environment, opts.allow);
  // #293: only the prefix up to the anchor runs (its params are the ones those steps take).
  let journey = opts.stopAfterStep === undefined ? full : journeyPrefix(full, opts.stopAfterStep);
  opts.runRecorder?.noteJourney(journey);
  evidence?.ran(journey);
  // 0.30.0 run hooks (journey-run-hooks.ts): what every hook is told; the mode once `resolveMode` decided it.
  let mode: RunMode | undefined;
  const target: RunHookTarget = { origin: opts.environment?.baseUrl ?? stored.recording.site, environment: opts.environment, targetsFile: opts.runGuardTargetsFile };
  // Independent check H3: every value the run knows (bound, vault, fixture outputs, extracted), whether or not it writes evidence.
  const knownValues = new Set<string>();
  const noteKnown = (v: string): void => {
    if (v !== "") knownValues.add(v);
    evidence?.writer.noteValue(v);
  };
  const hookCtx = (): RunHookContext => ({ journey: stored, params: opts.params, channel: opts.runRecorder?.channel, mode, evidence: evidence?.writer, target, knownValues: () => [...knownValues] });
  const allowedOrigins = effectiveAllowedOrigins(journey, opts.environment, opts.allow);
  // #543: an http end-state check reads only an origin the replay allows — refused before any fixture or browser.
  if (journey === full) assertHttpChecksAllowed(journeyEndState(journey), allowedOrigins, `journey '${opts.id}' end state`);
  // #256: a Journey recorded with extensions replays only under that same build (ExtensionMismatchError, exit 64).
  if ((journey.recording.extensions ?? []).length > 0) assertSameExtensionBuild(journey.recording.extensions, opts.browser, `journey '${opts.id}'`);
  // #118: a Journey that declares it needs auth refuses BEFORE any browser launch when no storageState was given.
  if (journey.metadata.requiresAuth === true && opts.storageState === undefined) {
    throw new JourneyRequiresAuthError(`journey '${opts.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`);
  }
  // Fail fast: validate BEFORE any browser launch, so bad params never pay the cost of opening a browser.
  const inputParams = journey === full ? opts.params : prefixParams(full, journey, opts.params);
  mode = await resolveRunMode(hookCtx());
  if (mode !== undefined) evidence?.writer.noteMode(mode);
  // #827: a command's bound secrets (verify, chain, demo, an exploration's prefix) reach each of its replays.
  const givenBound = opts.boundSecretParams ?? currentBoundSecretParams();
  // 0.30.0 §5.3 / H7: a human step or a secret nobody supplied, before anything opens.
  const mayBindTargetSecrets = inMcpInvocation()
    ? await mcpMayBindTargetSecrets(stored, mode ?? resolveRunTarget(target).mode, { journeysDir: opts.dir, catalogDir: resolveCatalogDir(undefined) })
    : undefined;
  const secretPlan = planSecretRun({
    mayBindTargetSecrets,
    stored,
    journey,
    params: inputParams,
    bound: givenBound,
    origin: target.origin,
    environment: opts.environment,
    targetsFile: opts.runGuardTargetsFile,
    mode,
    mcp: inMcpInvocation(),
    surface: opts.runRecorder?.channel !== undefined || opts.resumeAtStep !== undefined || inMcpInvocation(),
    flag: opts.secretMode,
    env: opts.secretEnv ?? process.env,
    heldSecretParams: opts.heldSecretParams,
  });
  if (secretPlan.heldSecretParams.length > 0) {
    const wasFull = journey === full;
    full = withSecretHandbacks(full, secretPlan.heldSecretParams);
    journey = wasFull ? full : withSecretHandbacks(journey, secretPlan.heldSecretParams);
  }
  for (const v of [...secretPlan.values, ...Object.values(secretPlan.params)]) noteKnown(v);
  const boundSecretParams = secretPlan.bound === undefined ? givenBound : { ...givenBound, ...secretPlan.bound };
  // A secret goes only to an origin a person or operator named; checked here, before any browser.
  const resolvedBound = resolveBoundSecretOrigins(boundSecretParams, ctx.operatorAllowedOrigins(journey));
  if (resolvedBound !== undefined) assertBoundSecretsOnOrigins(journey, resolvedBound, target.origin);
  validateParams(journeyParamSchema(journey), { ...secretPlan.params, ...inputParams });
  await runValidateParamsHooks(hookCtx());
  // #402: the mutated copy replays (and is judged); the stored Journey still names, redacts and gates.
  const replayed = mutation.mutateJourney === undefined || journey !== full ? journey : mutation.mutateJourney(journey);
  // #789: under an MCP invocation, this run's guard: a production target is refused here, before anything opens.
  const runGuard = prepareMcpRunGuard({
    site: journey.recording.site,
    allowedOrigins,
    environment: opts.environment,
    targetsFile: opts.runGuardTargetsFile,
    ...(mode === undefined ? {} : { mode }),
    authoredOrigins: journey.metadata.allowedOrigins ?? [],
    onRelaxed: (note) => evidence?.writer.note(note),
  });
  const policy = opts.policy ?? safeRunPolicy();
  // #583 §3: a prepare-only boundary never self-heals — refused before any fixture or browser opens.
  assertHandbackNoHeal(journey, policy.selfHeal.mode !== "fail-closed");
  // The site policy (`jevitate site policy set <origin>`): pacing, throttles, budgets, quiet hours.
  const gate = await gateJourney(opts.siteGate, journey.recording, { ...(opts.account === undefined ? {} : { account: opts.account }), enforceLimits: true });
  return { full, journey, target, allowedOrigins, inputParams, mode, hookCtx, knownValues, noteKnown, secretPlan, resolvedBound, replayed, runGuard, policy, gate };
}

/** The opened browser session's resources, armed and ready for the run body. */
export interface StoredJourneySession {
  readonly fx: MissionFixtures | undefined;
  readonly session: NonNullable<RunJourneyProgrammaticallyOptions["session"]>;
  readonly closeSession: () => Promise<void>;
  readonly offAllowlist: ReturnType<typeof watchOffAllowlistWrites>;
  readonly mask: SecretPixelMask;
  readonly shots: RunScreenshots | undefined;
  readonly secrets: string[];
  readonly flat: ReturnType<typeof flatJourneySteps>;
  readonly whatOf: (i: number) => string;
  readonly startedAt: string;
  readonly stampBase: string;
  readonly healDir: string;
  readonly videoDir: ReturnType<typeof runVideoDir>;
  readonly handbackObserver: HandbackWriteObserver | undefined;
}

/** Set up the fixture, open the browser/session and arm the run's guards (the phases between the secret plan and the replay). */
export async function openStoredJourneyRun(prep: StoredJourneyRunPreparation, state: StoredJourneyRunState, ctx: StoredJourneyRunContext, fx: MissionFixtures | undefined): Promise<StoredJourneySession> {
  const { opts, stored, evidence } = ctx;
  if (fx !== undefined) {
    await fx.setup();
    const b = fx.bindings();
    state.params = Object.fromEntries(Object.entries(state.params).map(([k, v]) => [k, substituteSetupRefs(v, b, { where: `--param ${k}` })]));
    // #812: a fixture's outputs, and the params they were bound into, are masked from the evidence's write shapes.
    for (const v of [...Object.values(b.values), ...fx.secrets(), ...Object.values(state.params)]) prep.noteKnown(v);
  }
  // #140 order: fixture setup (above) → open the browser (#137 launch options, #118 storageState) → run → restore.
  const secrets = [...new Set([...secretParamValues(stored, state.params), ...(fx?.secrets() ?? []), ...prep.secretPlan.values])];
  // Known values, not discovered ones: a declared 3-5 digit secret is masked inside a longer digit run too.
  state.declaredSecrets = registerDeclaredSecrets(secrets);
  const mask = opts.mask ?? new SecretPixelMask(secrets);
  const capturing = opts.session === undefined && (opts.browser?.recordVideo !== undefined || opts.screenshots !== undefined);
  const openPort = (): BrowserPort => {
    const rawPort = (opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()))();
    return capturing ? maskingPort(rawPort, mask) : rawPort;
  };
  const startedAt = clock.nowIso();
  const stampBase = `journey-${opts.id.replace(/[^A-Za-z0-9._-]/g, "_")}-${artifactStamp(startedAt)}`;
  const artifactName = `${stampBase}.json`;
  const healDir = join(logsDirFor(), `${stampBase}.heal`);
  // #245: `--record-video` → `journey-<id>-<stamp>.videos/` under the given dir, else the logs dir.
  const videoDir = opts.browser?.recordVideo === undefined || opts.session !== undefined ? undefined : runVideoDir(opts.browser, join(opts.browser.recordVideo.dir ?? logsDirFor(), artifactName));
  const flat = flatJourneySteps(prep.journey);
  const shots = opts.screenshots === undefined || opts.session !== undefined ? undefined : new RunScreenshots({ spec: opts.screenshots, dir: screenshotsDirFor(opts.screenshots, join(logsDirFor(), artifactName)), secrets, title: `journey ${prep.journey.metadata.name}`, mask });
  const whatOf = (i: number): string => {
    const s = flat[i];
    if (s === undefined) return `step ${i + 1}`;
    const pick = [s.recorded.objective, s.recorded.step.label].map((t) => (t ?? "").trim()).find((t) => t !== "");
    return pick ?? describeStep(s.recorded.step);
  };
  // #293: a given session is the caller's — replayed into, never opened or closed here.
  const session = opts.session ?? (await openPort().open({ ...sessionLaunchOptions(opts.browser, videoDir), allowedOrigins: prep.allowedOrigins, baseUrl: prep.journey.recording.site, ...opts.emulation, ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}) }));
  const closeSession = opts.session === undefined ? closeOnce(() => session.close()) : async (): Promise<void> => undefined;
  // #485: the origins outside the run's allow list that the page sent a write to (origins only).
  const offAllowlist = watchOffAllowlistWrites(session, prep.allowedOrigins);
  // #812: with evidence the writer watches the run, and the #790 record is derived from what it saw.
  if (evidence === undefined) opts.runRecorder?.attach(session);
  else evidence.writer.attach(session);
  await prep.runGuard?.arm(session, state.params, evidence === undefined ? opts.runRecorder?.noteRefusedWrite : (request) => evidence.writer.noteRefusedWrite(request, request.method(), request.url()));
  // #583 §3: a declared boundary watches every first-party write for the whole run.
  const handbackObserver = prep.journey.metadata.boundary === undefined ? undefined : new HandbackWriteObserver(prep.allowedOrigins, { blockWrites: prep.journey.metadata.boundary.blockWrites === true });
  if (handbackObserver !== undefined) await handbackObserver.arm(session.page);
  return { fx, session, closeSession, offAllowlist, mask, shots, secrets, flat, whatOf, startedAt, stampBase, healDir, videoDir, handbackObserver };
}

/** The runner, its checks and the per-step guards built just before the replay starts. */
export interface StoredJourneyExecution {
  readonly actor: Actor;
  readonly runner: JourneyRunner;
  readonly runPolicy: RunPolicy;
  readonly outcomeChecks: JourneyOutcomeChecks;
  readonly blocker: Awaited<ReturnType<typeof stepWriteBlocker>> | undefined;
  readonly healGuard: Awaited<ReturnType<typeof installHealProbeGuard>> | undefined;
  readonly replayDeltas: ReplayDeltas | undefined;
  readonly secrets: string[];
  readonly nonSecretParams: Set<string>;
  readonly extractedCredentials: Set<string>;
  runSecrets: readonly string[];
  result: JourneyRunResult | undefined;
}

/** Build the actor, interpreter, runner and outcome checks for the opened session. */
export async function buildStoredJourneyExecution(prep: StoredJourneyRunPreparation, state: StoredJourneyRunState, run: StoredJourneySession, ctx: StoredJourneyRunContext): Promise<StoredJourneyExecution> {
  const { opts, mutation, stored } = ctx;
  const { journey, full, resolvedBound, replayed, runGuard, policy, secretPlan, hookCtx, noteKnown } = prep;
  const { session, mask, shots, secrets, flat, whatOf, healDir, fx } = run;
  const params = state.params;
  const actor = CastActor.named("cli-runner").whoCan(new BrowseTheWeb(session, prep.allowedOrigins), ...prep.gate.abilities);
  const boundOption = resolvedBound === undefined ? {} : { boundSecretParams: new Map(Object.entries(resolvedBound)) };
  const replayDeltas = opts.actionDeltas === true ? new ReplayDeltas({ secrets, recorded: flat.map((f) => f.recorded) }) : undefined;
  // #543: `${name}` from the run's params and `${setup.x}` from the fixture bindings, for end-state checks and step expectations.
  const refs = httpCheckRefs({ params, secretParams: loadRefusedParamNames(journey, params), ...(fx === undefined ? {} : { bindings: fx.bindings() }) });
  const outcomeChecks = new JourneyOutcomeChecks(session.page, journey === full ? replayed : undefined, {
    ...(mutation.beforeFinalNetworkCaptureClose === undefined ? {} : { beforeFinalNetworkCaptureClose: mutation.beforeFinalNetworkCaptureClose }),
    ...(mutation.relaxedStepRequests === undefined ? {} : { relaxedStepRequests: mutation.relaxedStepRequests }),
    secrets,
    // #543: the end state's http checks: allowlist-bound requests.
    httpProbe: createHttpProbe({ allowlist: prep.allowedOrigins }),
    resolveRef: refs,
    ...(opts.stepResponseTimeoutMs === undefined ? {} : { stepResponseTimeoutMs: opts.stepResponseTimeoutMs }),
  });
  const blocker = mutation.blockWritesAtStep === undefined ? undefined : await stepWriteBlocker(session.page, mutation.blockWritesAtStep, prep.allowedOrigins, mutation.blockAfterWindow, mutation.readRequests);
  // #453 (Q2): a guarded click/fill heal probe runs under a per-step write blocker.
  const healGuard = opts.heal === undefined || policy.selfHeal.mode === "fail-closed" ? undefined : await installHealProbeGuard(session.page, runGuard === undefined ? undefined : (ws) => runGuard.claimSocket(ws));
  const observer = composeObservers(
    ctx.evidence?.observer(),
    mutation.earliestObserver,
    outcomeChecks.observer(),
    blocker?.observer,
    replayDeltas?.observer(),
    opts.observer,
    shots === undefined ? undefined : screenshotObserver(shots, (a) => a.ability(BrowseTheWebToken).session.page, whatOf),
  );
  const skipStep = mutation.skipStep;
  const selectAlternative = mutation.selectAlternativeAtStep;
  const fixtureBaseDir = opts.fixtureBaseDir ?? ctx.fixtureBaseDir();
  // A value extracted before the run throws has no `output` to be read from, and must still be masked.
  const extractedCredentials = new Set<string>();
  const nonSecretParams = declaredNonSecretParams(stored);
  const onExtracted = async (value: string, name?: string): Promise<void> => {
    opts.runRecorder?.noteValue(value);
    noteKnown(value);
    // A credential name, or one that names a credential and ends in a describing word with a credential-length value.
    if (name === undefined || !masksExtractedValue(name, value, nonSecretParams)) return;
    extractedCredentials.add(value);
    await mask.addSecret(value);
  };
  // The #789 guard, then any `beforeWrite` run hook: exactly `runGuard` while none is registered.
  const actionGuard = withRunHookGuard(runGuard, hookCtx);
  const interpreter = opts.interpreter ?? buildJourneyInterpreter({ opts, evidence: ctx.evidence, observer, fixtureBaseDir, refs, onExtracted, boundOption, actionGuard, skipStep, selectAlternative, shots, replayDeltas, outcomeChecks, blocker, healGuard });
  // Decided from the Journey, before it runs: a break can come before the extract, with the value already on the page.
  const secretBound = [...secretBoundNeeds(stored, params), ...fixtureSecretNeeds(fx)];
  const heal = buildJourneyHeal({ opts, healGuard, allowedOrigins: prep.allowedOrigins, healDir, mask, secretBound, secrets, extractedCredentials });
  const handback = secretPlan.secretMode === "visible-handback" ? secretHandbackHandler({ ctx: hookCtx, page: session.page, holdKinds: secretPlan.holdKinds }) : undefined;
  const runner = new JourneyRunner(actor, interpreter, handback, secretPlan.secretManager, opts.selfHealer, heal);
  const runPolicy: RunPolicy = secretPlan.secretMode === undefined ? policy : { ...policy, secret: { ...policy.secret, secretMode: secretPlan.secretMode } };
  return { actor, runner, runPolicy, outcomeChecks, blocker, healGuard, replayDeltas, secrets, nonSecretParams, extractedCredentials, runSecrets: secrets, result: undefined };
}

/** The interpreter the run replays through: the fast path when nothing observes it, the observed one otherwise. */
function buildJourneyInterpreter(i: {
  readonly opts: RunJourneyProgrammaticallyOptions;
  readonly evidence: RunEvidenceScope | undefined;
  readonly observer: ReturnType<typeof composeObservers>;
  readonly fixtureBaseDir: string | undefined;
  readonly refs: ReturnType<typeof httpCheckRefs>;
  readonly onExtracted: (value: string, name?: string) => Promise<void>;
  readonly boundOption: { readonly boundSecretParams?: ReadonlyMap<string, readonly string[]> };
  readonly actionGuard: ReturnType<typeof withRunHookGuard>;
  readonly skipStep: MutationReplayOptions["skipStep"];
  readonly selectAlternative: MutationReplayOptions["selectAlternativeAtStep"];
  readonly shots: RunScreenshots | undefined;
  readonly replayDeltas: ReplayDeltas | undefined;
  readonly outcomeChecks: JourneyOutcomeChecks;
  readonly blocker: Awaited<ReturnType<typeof stepWriteBlocker>> | undefined;
  readonly healGuard: Awaited<ReturnType<typeof installHealProbeGuard>> | undefined;
}): RecordingInterpreter {
  if (i.evidence === undefined && i.opts.observer === undefined && i.shots === undefined && i.replayDeltas === undefined && i.outcomeChecks.observer() === undefined && i.blocker === undefined && i.healGuard === undefined && i.skipStep === undefined && i.selectAlternative === undefined && i.actionGuard === undefined) {
    return new RecordingInterpreter({ fixtureBaseDir: i.fixtureBaseDir, refLookup: i.refs, onExtracted: i.onExtracted, ...i.boundOption });
  }
  const skipStep = i.skipStep;
  const selectAlternative = i.selectAlternative;
  return new RecordingInterpreter({
    ...i.boundOption,
    observer: i.observer,
    fixtureBaseDir: i.fixtureBaseDir,
    refLookup: i.refs,
    onExtracted: i.onExtracted,
    ...(i.actionGuard === undefined ? {} : { actionGuard: i.actionGuard }),
    ...(skipStep === undefined ? {} : { skipStep: (n: number) => skipStep(n) }),
    ...(selectAlternative === undefined ? {} : { selectAlternative: (n: number) => (n === selectAlternative.index ? { avoid: selectAlternative.avoid } : undefined) }),
  });
}

/** The self-heal options for the run, absent when healing is off or no heal guard was installed. */
function buildJourneyHeal(i: {
  readonly opts: RunJourneyProgrammaticallyOptions;
  readonly healGuard: Awaited<ReturnType<typeof installHealProbeGuard>> | undefined;
  readonly allowedOrigins: string[];
  readonly healDir: string;
  readonly mask: SecretPixelMask;
  readonly secretBound: string[];
  readonly secrets: string[];
  readonly extractedCredentials: Set<string>;
}): JourneyHealOptions | undefined {
  if (i.opts.heal === undefined || i.healGuard === undefined) return undefined;
  return {
    scope: i.opts.heal.scope,
    riskOf: journeyStepRisk(),
    writeGuard: i.healGuard.guard,
    allowedOrigins: i.allowedOrigins,
    noHealBecause: () => (i.secretBound.length > 0 || i.secrets.length > 0 || i.extractedCredentials.size > 0 ? secretBoundNoHeal(i.secretBound) : undefined),
    observe: healObserver(i.healDir, i.mask),
  };
}

/** Run the prepared Journey, then note the run's own secret set and stop the per-step guards. */
export async function executeStoredJourneyRun(prep: StoredJourneyRunPreparation, state: StoredJourneyRunState, run: StoredJourneySession, ctx: StoredJourneyRunContext): Promise<RunJourneyResult> {
  const { mutation } = ctx;
  const exec = await buildStoredJourneyExecution(prep, state, run, ctx);
  try {
    await runBuiltJourney(exec, prep, state, run, ctx);
  } finally {
    mutation.onRunSecrets?.([...new Set([...exec.runSecrets, ...exec.extractedCredentials])]);
    await prep.gate.done();
    await exec.healGuard?.guard.disarm();
    await exec.healGuard?.dispose();
    await run.handbackObserver?.disarm();
  }
  return assembleStoredJourneyResult(exec, prep, state, run, ctx);
}

/** One replay: the runner's result, then the done-check read and redaction. */
async function runBuiltJourney(exec: StoredJourneyExecution, prep: StoredJourneyRunPreparation, state: StoredJourneyRunState, run: StoredJourneySession, ctx: StoredJourneyRunContext): Promise<void> {
  const { opts, mutation } = ctx;
  const { replayed, journey, target, mode, secretPlan, runGuard, hookCtx, noteKnown } = prep;
  const params = state.params;
  // #609: a mutated copy may no longer name a param the stored Journey takes; the copy runs with the subset it still reads.
  const replayParams = replayed === journey ? params : prefixParams(journey, replayed, params);
  const raw = await exec.outcomeChecks.run(
    exec.actor,
    () =>
      exec.runner
        .run({
          journey: replayed,
          params: replayParams,
          policy: exec.runPolicy,
          ...(opts.resumeAtStep === undefined ? {} : { resumeAt: opts.resumeAtStep - 1 }),
          ...(secretPlan.secretRefs === undefined ? {} : { secretRefs: secretPlan.secretRefs }),
        })
        .catch((err: unknown) => {
          throw secretOriginRefusalOf(err, target.origin, mode ?? "automation", secretPlan.trust) ?? err;
        }),
    {
      collectStepFailuresOnReplayFailure: mutation.structuredFailures === true,
      ...(mutation.beforeEndState === undefined ? {} : { beforeEndState: mutation.beforeEndState }),
      ...(mutation.afterEndState === undefined ? {} : { afterEndState: mutation.afterEndState }),
    },
  );
  runGuard?.check();
  if ("output" in raw) opts.onRawOutput?.(raw.output);
  if ("output" in raw && raw.output !== null && typeof raw.output === "object") for (const v of Object.values(raw.output as Record<string, unknown>)) if (typeof v === "string") noteKnown(v);
  // The page is still open: a done check reads it here (#800).
  if (hasRunHooks("readDoneCheck")) await runReadDoneCheckHooks({ ...hookCtx(), page: run.session.page, result: raw });
  const runSecrets = [...new Set([...runSecretValues(exec.secrets, raw, exec.nonSecretParams), ...exec.extractedCredentials])];
  exec.runSecrets = runSecrets;
  exec.result = redactSecretValues(raw, runSecrets);
}

/** Persist the heal record, attach the handback verdict and assemble the run's result (heal/retry tail). */
export async function assembleStoredJourneyResult(exec: StoredJourneyExecution, prep: StoredJourneyRunPreparation, state: StoredJourneyRunState, run: StoredJourneySession, ctx: StoredJourneyRunContext): Promise<RunJourneyResult> {
  const { opts, mutation, stored } = ctx;
  const { journey, full, policy } = prep;
  const fx = run.fx;
  let withHeal = exec.result!;
  let healFields: Partial<Awaited<ReturnType<typeof persistHealRun>>["fields"]> = {};
  if (policy.selfHeal.mode !== "fail-closed") {
    const unwritable = journey !== full ? "only a prefix of the Journey ran" : mutation.mutateJourney !== undefined ? "a mutated copy of the Journey ran" : undefined;
    const persisted = await persistHealRun({ result: withHeal, stored, params: state.params, secrets: exec.runSecrets, opts, stampBase: run.stampBase, startedAt: run.startedAt, ...(unwritable === undefined ? {} : { unwritable }) });
    withHeal = persisted.result;
    healFields = persisted.fields;
  }
  // #583: the typed handback state, attached only when the Journey declares a boundary.
  const handbacked = attachHandback(withHeal, journey, run.handbackObserver?.counts() ?? { writes: 0, writesBlocked: 0, observation: "unavailable" });
  const slowFields = exec.outcomeChecks.slowSteps.length === 0 ? {} : { slowSteps: [...exec.outcomeChecks.slowSteps] };
  const writeOrigins = run.offAllowlist.stop();
  const originFields = writeOrigins.length === 0 ? {} : { offAllowlistWrites: redactSecretValues(writeOrigins, exec.runSecrets) };
  const shotFields = run.shots === undefined ? {} : await run.shots.finish();
  const deltaFields = exec.replayDeltas === undefined ? {} : { actionDeltas: redactSecretValues(replayDeltaSummary(exec.replayDeltas), exec.runSecrets) };
  // #245: the context closed (its video finalized) before the result naming it is returned.
  const videos = await finalizeVideos(run.videoDir, run.closeSession);
  // After the close: a replay stays open a while before it, and a block holds until then.
  await exec.blocker?.guard.disarm();
  const mutationFields: MutationReplayFields = {
    ...(mutation.structuredFailures === true ? { outcomeFailures: redactSecretValues([...exec.outcomeChecks.lastFailures], exec.runSecrets) } : {}),
    ...(exec.blocker === undefined ? {} : { blockedWrites: exec.blocker.guard.drain() }),
    ...(exec.blocker === undefined || exec.blocker.escaped().length === 0 ? {} : { blockEscaped: exec.blocker.escaped() }),
  };
  if (fx === undefined) return { ...handbacked, ...healFields, ...videos, ...shotFields, ...deltaFields, ...slowFields, ...originFields, ...mutationFields };
  await fx.restore();
  // #399: a fixture output passed in as a secret param (`--param t='${setup.t}'`) is redacted here too.
  return { ...handbacked, ...healFields, ...videos, ...shotFields, ...deltaFields, ...slowFields, ...originFields, ...mutationFields, fixtures: redactSecretValues(fx.record(), exec.runSecrets) };
}

/** Open the run's session, then replay and assemble it, closing the session and guard in the end. */
export async function runPreparedStoredJourney(prep: StoredJourneyRunPreparation, state: StoredJourneyRunState, fx: MissionFixtures | undefined, ctx: StoredJourneyRunContext): Promise<RunJourneyResult> {
  const run = await openStoredJourneyRun(prep, state, ctx, fx);
  try {
    return await executeStoredJourneyRun(prep, state, run, ctx);
  } finally {
    run.offAllowlist.stop();
    await prep.runGuard?.dispose();
    await run.closeSession();
  }
}
