import { FsJourneyStore, JourneyRegistry, ParamValidationError, deriveParamSchema, describeStep, flatJourneySteps, journeyPrefix, lintJourney, secretParamValues, validateParams, type Journey, type JourneyApproval, type JourneyLintFinding, type ApprovalProvenance } from "@jevitate/journey";
import { programmaticProvenance, type ApprovalConfirm } from "./approval-provenance.js";
import { checkProposal, deleteJourneyProposal, proposedJourney, rejectJourneyProposal, requireJourneyProposal } from "./journey-proposal-store.js";
import { journeyReviewHash } from "./journey-review.js";
import { writeApprovedSnapshot } from "./journey-review-store.js";
import { journeyCatalogGate, resolveCatalogDir } from "./catalog-api.js";
import type { JevSetup } from "./jev-advisor.js";
import { redactText } from "@jevitate/ai-core";
import { safeRunPolicy, runTagsOf, type RunPolicy, clock } from "@jevitate/domain";
import { dirname, join } from "node:path";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession, type EmulationSpec } from "@jevitate/playwright";
import { assertSameExtensionBuild, closeOnce, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter, type StepObserver } from "@jevitate/interpreter";
import { ReadOnlyGuard, ReplayDeltas, monitorFor, replayDeltaSummary, type BlockedWrite, type ReplayDeltaSummary } from "@jevitate/explore";
import { writeClassifier } from "@jevitate/recording";
import type { Page } from "playwright";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { SecretPixelMask, maskingPort } from "./demo-capture.js";
import { RunScreenshots, composeObservers, screenshotObserver, screenshotsDirFor, type ScreenshotsResult, type ScreenshotsSpec } from "./run-screenshots.js";
import { JourneyRunner, type ChangeScope, type JourneyHealOptions, type JourneyRunResult, type SelfHealer, type SiteGateDeps } from "@jevitate/runtime";
import { journeyStepRisk } from "./journey-heal.js";
import { installHealProbeGuard } from "./heal-probe-guard.js";
import { journeyResultRecord, type JourneyResultProposal } from "./journey-result-record.js";
import { JourneyProposalProofError, writeJourneyProposal } from "./journey-proposal-store.js";
import { stampRunMetadata } from "./run-metadata.js";
import { recordRun } from "./run-index.js";
import { captureStepScreenshot } from "./demo-capture.js";
import { mkdir, writeFile } from "node:fs/promises";
import { gateJourney } from "./site-gate-cli.js";
import { substituteSetupRefs, type FixtureRecord, type MissionFixtures } from "./mission-fixtures.js";
import { applyJourneyEnvironment, type ResolvedJourneyEnvironment } from "./environments.js";
import { JourneyOutcomeChecks, type OutcomeCheckFailure } from "./journey-network-checks.js";

/**
 * Distinct from `@jevitate/journey`'s `ParamValidationError` so CLI/API callers
 * can tell "no such journey" apart from "params didn't match the journey's
 * schema" without string-matching error messages.
 */
export class UnknownJourneyError extends Error {}

/**
 * A Journey declares `metadata.requiresAuth: true` (#118) but the run was given no
 * `storageState` — refused BEFORE any browser launches, with a message that names the
 * actual problem instead of a confusing `replay-target-not-found` deep into the steps.
 */
export class JourneyRequiresAuthError extends Error {}

/**
 * #401: the Journey's assertions cannot prove its outcome (the `lintJourney` errors). `promote`
 * refuses unless the reviewer accepts it with a non-empty `--accept-weak <reason>`.
 */
/** #432: `journey promote --reviewed-hash`: the Journey changed after the reviewer's sheet was produced. */
export class StaleReviewError extends Error {
  readonly code = "E_JOURNEY_REVIEW_STALE";
}

/** #453: a bad combination of proposal flags (`--proposal` with `--reject-proposal`; a rejection with no reason). Exit 64. */
export class JourneyProposalArgsError extends Error {
  readonly code = "E_JOURNEY_PROPOSAL_ARGS";
}

export class WeakJourneyError extends Error {
  constructor(message: string, readonly findings: readonly JourneyLintFinding[] = []) {
    super(message);
  }
}

/** #401: the assertion-strength lint's verdict for one Journey (`journey lint`). */
export interface JourneyLintResult {
  id: string;
  findings: JourneyLintFinding[];
  errors: number;
  warnings: number;
}

export interface RunJourneyProgrammaticallyOptions {
  /** Directory a `FsJourneyStore` reads Journey JSON files from. */
  dir: string;
  id: string;
  params: Record<string, string>;
  /** Defaults to `safeRunPolicy()` (Slice 1: fail-closed secret mode) when omitted. */
  policy?: RunPolicy;
  /**
   * Optional gated self-heal port (Ticket #7). Only relevant when
   * `policy.selfHeal.mode !== "fail-closed"`; wired as the `JourneyRunner`'s
   * 5th constructor arg. When omitted (the default), a divergence quarantines
   * exactly as before — identical to Slice 1's fail-closed behavior. The
   * caller (CLI) is responsible for its credential preflight; this surface
   * never builds AI gateways itself. Writes never auto-heal regardless of
   * this port (enforced by `JourneyRunner`'s write floor).
   */
  selfHealer?: SelfHealer;
  /**
   * #453: the change context a `hybrid`/`full` self-heal is explained by (`readJourneyChangeScope`).
   * With it the runner gets the risky-control classification (`journeyStepRisk`) and a per-step write
   * blocker, so a guarded click/fill may be retargeted. Absent: every break is unexplained (never healed).
   */
  heal?: { readonly scope: ChangeScope };
  /**
   * Mission fixtures (#140/#144), built for the journey's own site once it is known: set up before
   * the browser opens (a failure throws `FixtureSetupError` — the journey never runs on unknown
   * state), `${setup.<name>}` in params bound to its outputs, and restored after the run.
   */
  fixtures?: (site: string) => MissionFixtures | undefined;
  /**
   * Playwright storageState JSON to seed the session from (CLI/MCP `--storage-state`, #118) —
   * the deterministic authenticated pre-step a Journey authored behind a login needs to
   * replay. Contains live session cookies: handed only to the browser, never logged, never
   * returned in the result, and never sent to a model.
   */
  storageState?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args) and shown (#245 demo mode). Default: pinned Chromium, headless. */
  browser?: BrowserRunOptions;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  emulation?: EmulationSpec;
  /**
   * The site-policy gate's repositories (`jevitate site policy set`): pacing, throttles, budgets and
   * quiet hours for the Journey's origin. Absent (no policy database) means no site policy applies.
   */
  siteGate?: SiteGateDeps;
  /** The site-policy account (default `primary`, as `jevitate site policy` uses). */
  account?: string;
  /**
   * #246 seam: the interpreter the run replays with — `journey annotate` passes one carrying a
   * `StepObserver` (before/after page evidence). Default: a plain `RecordingInterpreter`.
   */
  interpreter?: RecordingInterpreter;
  /**
   * The environment to run against (#247, `--env`/`--base-url`, from `resolveJourneyEnvironment`):
   * the Journey's recorded same-origin URLs move onto its `baseUrl` and the run's allowlist is its
   * `allowedOrigins`; a step on any other origin is refused before any fixture or browser.
   * Absent: the Journey's recorded site, exactly as before.
   */
  environment?: ResolvedJourneyEnvironment;
  /**
   * #251 `--screenshots`: one masked screenshot per distinct screen (or per step) + `index.md`;
   * the paths come back as `screenshotPaths`. Absent: none.
   */
  screenshots?: ScreenshotsSpec;
  /** #251 seam: a per-step observer composed into the default interpreter (annotate, demo). Ignored with `interpreter`. */
  observer?: StepObserver;
  /**
   * #250/#251: the run's pixel mask (default: one over the Journey's secret parameters) — installed
   * on the session before its first navigation whenever it records video or screenshots.
   */
  mask?: SecretPixelMask;
  /**
   * #293 journey-anchored exploration: replay in THIS already-open session and leave it open (the
   * caller's mission continues in the same page, form contents and session). No browser is opened
   * or closed here; video/screenshots belong to the caller's session.
   */
  session?: BrowserSession;
  /**
   * #293: replay only the first N top-level steps — the prefix up to an anchor. A `--param` the
   * Journey does not take is still refused; one only a later step uses is not required (and unused).
   */
  stopAfterStep?: number;
  /**
   * #303 `--action-deltas` (opt-in): record what each replayed step changed (redacted, code verdict)
   * and compare it with the delta the Journey's Recording stored — returned as `actionDeltas`.
   * Observation only: it never changes the replay. Off: nothing is captured.
   */
  actionDeltas?: boolean;
}

/**
 * #402: how a mutation-proof replay (`journey verify --mutate`) differs from `journey run` — a
 * separate argument, never a surface option: no other caller passes it.
 */
export interface MutationReplayOptions {
  /**
   * #402 `journey verify --mutate`: replay a MUTATED copy of the Journey. Applied after params are
   * validated against the stored Journey (a mutation may stop a step reading a param), and never to
   * an anchored prefix. Indices must be kept: a mutation changes a step, never removes one.
   */
  mutateJourney?: (journey: Journey) => Journey;
  /** #402: leave this flat step (0-based) out of the replay — `RecordingInterpreter`'s `skipStep`. */
  skipStep?: (index: number) => boolean;
  /**
   * #402: ABORT the write requests (the #110 classifier, first-party only — `ReadOnlyGuard`) that
   * start while this flat step (0-based) runs, until the network settles after it. Never answered,
   * never sent; what was blocked comes back as `blockedWrites`.
   */
  blockWritesAtStep?: number;
  /** #402: also return the outcome checks' structured failures (`outcomeFailures`). */
  structuredFailures?: boolean;
}

/** #402: what a mutation-proof replay returns beyond `journey run`'s result. */
export interface MutationReplayFields {
  /** The step-request / end-state checks that failed (`structuredFailures`). */
  outcomeFailures?: OutcomeCheckFailure[];
  /** The writes aborted in `blockWritesAtStep`'s window. */
  blockedWrites?: BlockedWrite[];
}

/** #453: what a self-heal run adds to its result — the proposal it wrote and the persisted result file. */
export interface HealRunFields {
  proposal?: JourneyResultProposal & { reviewCommand: string; acceptCommand: string };
  resultPath?: string;
}

/**
 * #246: a secret parameter's value (declared `secret: true`, or a credential-like name) never comes
 * back in a run's output — the interpreter's vars start as the params, so the value is masked there.
 */
export function redactSecretParams<T>(result: T, journey: Journey, params: Record<string, string>): T {
  return redactSecretValues(result, secretParamValues(journey, params));
}

/** Every string in `result` (deeply) with each secret, in each of its URL forms, masked. */
export function redactSecretValues<T>(result: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return result;
  const scrub = (v: unknown): unknown =>
    typeof v === "string"
      ? redactText(v, secrets)
      : Array.isArray(v)
        ? v.map(scrub)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
          : v;
  return scrub(result) as T;
}

/**
 * #293: the params a Journey PREFIX runs with — a `--param` the whole Journey does not take is
 * refused (`ParamValidationError`), one only a later step uses is dropped; the prefix's own required
 * params are then checked by `validateParams` as usual.
 */
export function prefixParams(full: Journey, prefix: Journey, params: Record<string, string>): Record<string, string> {
  const known = deriveParamSchema(full.recording).required;
  const unknown = Object.keys(params).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new ParamValidationError(`param mismatch — missing: [], unknown: [${unknown.join(", ")}]`);
  const needed = deriveParamSchema(prefix.recording).required;
  return Object.fromEntries(Object.entries(params).filter(([k]) => needed.includes(k)));
}

/**
 * #401: the assertion-strength lint (#401) for one Journey by id — an unknown id is refused,
 * exactly as `journey run`/`promote` refuse one (`UnknownJourneyError`). Pure read; no browser.
 */
export async function lintJourneyById(
  dir: string,
  id: string,
  opts: { readRequests?: readonly string[] } = {},
): Promise<JourneyLintResult> {
  const registry = new JourneyRegistry(new FsJourneyStore(dir));
  const journey = await registry.get(id);
  if (!journey) {
    throw new UnknownJourneyError(`unknown journey '${id}'`);
  }
  const findings = lintJourney(journey, opts.readRequests === undefined ? {} : { readRequests: opts.readRequests });
  return {
    id,
    findings,
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
  };
}

/**
 * Promotes a local Journey (#124, mirrors `promoteMissionTarget` in
 * `mission-api.ts`) so it becomes discoverable via `journey find`/MCP
 * `find_capabilities` and runnable via `run_journey` — a human-approval gate,
 * same as `mission target promote`. An unknown id is refused with
 * `UnknownJourneyError` (never silently created). Returns the persisted,
 * now-promoted Journey.
 *
 * #401: lints first — a Journey whose assertions cannot prove its outcome is refused
 * (`WeakJourneyError`) unless the reviewer accepts it with a non-empty `--accept-weak <reason>`,
 * which is recorded on the Journey (`metadata.acceptedWeak`). Warnings never block.
 *
 * #432: records the approval (`metadata.approval`: the review hash, when, the waiver) and keeps a
 * snapshot of the approved Journey (`.approved/<id>.json`). Given `reviewedHash` (what the reviewer's
 * sheet showed), a Journey that changed since is refused (`StaleReviewError`) before anything else.
 *
 * #433: then the catalog gate (`journeyCatalogGate`): a Journey linking a job/persona that is not
 * approved is refused (`UnvettedLinksError`) unless `acceptUnvetted` (recorded in
 * `approval.waivers`), and the shared pre-approval findings are acknowledged (`acceptFindings`,
 * recorded in `approval.acceptedFindings`) — the same pipeline `persona|job approve` and
 * `demo approve` use. `catalogDir` (default: the project's `.jevitate/`) holds personas/jobs.
 */
export interface PromoteJourneyOptions {
  acceptWeak?: string;
  reviewedHash?: string;
  acceptUnvetted?: string;
  acceptFindings?: string;
  /** The catalog's directory; undefined: the project's `.jevitate/` (none outside a project). */
  catalogDir?: string | null;
  /** Which approval path asks (`demo approve` promotes through here too). */
  action?: "journey promote" | "demo approve";
  /** #434/#435: the advisory Jev layer of the pre-approval readiness and analysis (`--real`), or why it is skipped. */
  jev?: JevSetup;
  /**
   * #437: confirms the approval (after every gate, before anything is written) and returns its
   * provenance — the CLI's `makeApprovalConfirm` (a typed confirmation on a TTY, the escape hatch,
   * or the MCP channel). Omitted: recorded as `non-interactive` (`programmaticProvenance`).
   */
  confirm?: ApprovalConfirm;
  /**
   * #453: accept this pending self-heal proposal (its id) instead of promoting the stored Journey as
   * is. The proposal is re-checked (stale / proof untouched), goes through every gate as the
   * Journey it would make, is confirmed with the proposal shown, and `reviewedHash` is compared with
   * ITS `proposedHash`. Only this writes the stored Journey.
   */
  proposal?: string;
  /** #453: reject this pending proposal (its id) — needs `reason`; the stored Journey is untouched. */
  rejectProposal?: string;
  reason?: string;
  /** #453: how the rejection was made (`rejectionProvenance`); omitted: the programmatic one. */
  rejectProvenance?: ApprovalProvenance;
}

export async function promoteJourney(dir: string, id: string, opts: PromoteJourneyOptions = {}): Promise<Journey> {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);

  const existing = await registry.get(id);
  if (!existing) {
    throw new UnknownJourneyError(`unknown journey '${id}'`);
  }
  if (opts.proposal !== undefined && opts.rejectProposal !== undefined) {
    throw new JourneyProposalArgsError("--proposal and --reject-proposal are exclusive: accept or reject, not both");
  }
  if (opts.rejectProposal !== undefined) {
    const why = opts.reason?.trim() ?? "";
    if (why === "") throw new JourneyProposalArgsError("--reject-proposal needs --reason <text> (it is recorded with the rejection)");
    await rejectJourneyProposal(dir, id, opts.rejectProposal, { reason: why, provenance: opts.rejectProvenance ?? programmaticProvenance() });
    return existing;
  }
  // #453: the proposal being accepted, re-checked against the stored Journey; the gates below judge the Journey it would make.
  const proposal = opts.proposal === undefined ? null : await requireJourneyProposal(dir, id, opts.proposal);
  if (proposal !== null) {
    const problem = checkProposal(existing, proposal);
    if (problem !== null) throw problem;
  }
  const subject: Journey = proposal === null ? existing : proposedJourney(existing, proposal);
  // #432: approval binds to what the reviewer read — refused when the Journey changed since.
  const contentHash = journeyReviewHash(subject);
  if (opts.reviewedHash !== undefined && opts.reviewedHash.trim().toLowerCase() !== contentHash) {
    throw new StaleReviewError(
      `journey '${id}' changed after its review sheet was produced (reviewed ${opts.reviewedHash.trim()}, now ${contentHash}) — review it again: jevitate journey review ${id}`,
    );
  }
  const errors = lintJourney(subject).filter((f) => f.level === "error");
  const reason = opts.acceptWeak?.trim() ?? "";
  if (errors.length > 0 && reason === "") {
    throw new WeakJourneyError(
      [
        `journey '${id}' has ${errors.length} assertion-strength error(s):`,
        ...errors.map((f) => f.message),
        "strengthen the Journey or pass --accept-weak <reason>",
      ].join("\n"),
      errors,
    );
  }
  const acceptedWeak = errors.length > 0 ? { reason, rules: [...new Set(errors.map((f) => f.rule))] } : undefined;
  const gate = await journeyCatalogGate(subject, {
    catalogDir: opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir,
    journeysDir: dir,
    action: opts.action ?? "journey promote",
    ...(opts.acceptUnvetted === undefined ? {} : { acceptUnvetted: opts.acceptUnvetted }),
    ...(opts.acceptFindings === undefined ? {} : { acceptFindings: opts.acceptFindings }),
    ...(opts.jev === undefined ? {} : { jev: opts.jev }),
  });
  // #437: the person confirms the approval and each waiver given with it (or it is refused) — then it is recorded with how it was made.
  const provenance =
    opts.confirm === undefined
      ? programmaticProvenance()
      : await opts.confirm({
          kind: opts.action === "demo approve" ? "demo" : "journey",
          id,
          contentHash,
          ...(proposal === null
            ? {}
            : {
                proposal: {
                  id: proposal.proposalId,
                  baseHash: proposal.baseHash,
                  steps: proposal.steps.map((st) => ({ number: st.index + 1, before: describeStep(st.before), after: describeStep(st.after) })),
                },
              }),
          waivers: [
            ...(acceptedWeak === undefined ? [] : [{ flag: "--accept-weak", reason: acceptedWeak.reason, detail: acceptedWeak.rules.join(", ") }]),
            ...(gate.waivers ?? []).map((w) => ({ flag: "--accept-unvetted", reason: w.reason, detail: w.items.join(", ") })),
            ...(gate.acceptedFindings === undefined ? [] : [{ flag: "--accept-findings", reason: gate.acceptedFindings.reason, detail: gate.acceptedFindings.findings.join(", ") }]),
          ],
        });
  const approval: JourneyApproval = {
    contentHash,
    at: clock.nowIso(),
    provenance,
    ...(acceptedWeak === undefined ? {} : { acceptedWeak: { ...acceptedWeak, provenance } }),
    ...(gate.waivers === undefined ? {} : { waivers: gate.waivers.map((w) => ({ ...w, provenance })) }),
    ...(gate.acceptedFindings === undefined ? {} : { acceptedFindings: { ...gate.acceptedFindings, provenance } }),
    ...(proposal === null ? {} : { proposal: { id: proposal.proposalId, baseHash: proposal.baseHash, steps: proposal.steps.map((st) => st.index) } }),
  };
  const promoted: Journey = {
    ...subject,
    metadata: { ...existing.metadata, promoted: true, ...(acceptedWeak === undefined ? {} : { acceptedWeak }), approval },
  };
  await store.put(promoted);
  // #432: the Journey as approved — the next review diffs against it ("change since last approval").
  await writeApprovedSnapshot(dir, promoted);
  // #453: an accepted proposal is spent.
  if (proposal !== null) await deleteJourneyProposal(dir, id);
  return (await registry.get(id)) ?? promoted;
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
  mutation: MutationReplayOptions = {},
): Promise<JourneyRunResult & { fixtures?: FixtureRecord; videoPaths?: string[]; actionDeltas?: ReplayDeltaSummary } & Partial<ScreenshotsResult> & MutationReplayFields & HealRunFields> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const stored = await registry.get(opts.id);
  if (!stored) {
    throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  }
  // #247: onto the chosen environment (a step on an origin it does not allow is refused here).
  const full = applyJourneyEnvironment(stored, opts.environment);
  // #293: only the prefix up to the anchor runs (its params are the ones those steps take).
  const journey = opts.stopAfterStep === undefined ? full : journeyPrefix(full, opts.stopAfterStep);
  const allowedOrigins = opts.environment === undefined ? [journey.recording.site] : [...opts.environment.allowedOrigins];
  // #256: a Journey recorded with extensions replays only under that same build (ExtensionMismatchError, exit 64).
  if ((journey.recording.extensions ?? []).length > 0) assertSameExtensionBuild(journey.recording.extensions, opts.browser, `journey '${opts.id}'`);

  // #118: a Journey that declares it needs auth refuses BEFORE any browser launch when no
  // storageState was given — a clear, typed failure instead of a deep `replay-target-not-found`.
  if (journey.metadata.requiresAuth === true && opts.storageState === undefined) {
    throw new JourneyRequiresAuthError(
      `journey '${opts.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`,
    );
  }

  // Fail fast: validate BEFORE any browser launch, so bad params never pay
  // the cost (or risk) of opening a browser.
  const inputParams = journey === full ? opts.params : prefixParams(full, journey, opts.params);
  validateParams(deriveParamSchema(journey.recording), inputParams);
  // #402: the mutated copy replays (and is judged); the stored Journey still names, redacts and gates.
  const replayed = mutation.mutateJourney === undefined || journey !== full ? journey : mutation.mutateJourney(journey);

  const policy = opts.policy ?? safeRunPolicy();

  // The site policy (`jevitate site policy set <origin>`): pacing, throttles, budgets, quiet hours —
  // decided before any fixture or browser; a refusal says why and when to retry.
  const gate = await gateJourney(opts.siteGate, journey.recording, { ...(opts.account === undefined ? {} : { account: opts.account }), enforceLimits: true });

  const fx = opts.fixtures?.(journey.recording.site);
  let params = inputParams;
  try {
    if (fx !== undefined) {
      await fx.setup();
      const b = fx.bindings();
      params = Object.fromEntries(Object.entries(inputParams).map(([k, v]) => [k, substituteSetupRefs(v, b, { where: `--param ${k}` })]));
    }
    // #140 order: fixture setup (above) → open the browser (#137 launch options, #118 storageState) → run → restore.
    // #250/#251: a recorded or screenshotted run carries the live pixel mask from its first paint.
    const secrets = secretParamValues(journey, params);
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
    const videoDir =
      opts.browser?.recordVideo === undefined || opts.session !== undefined
        ? undefined
        : runVideoDir(opts.browser, join(opts.browser.recordVideo.dir ?? logsDirFor(), artifactName));
    const flat = flatJourneySteps(journey);
    const shots =
      opts.screenshots === undefined || opts.session !== undefined
        ? undefined
        : new RunScreenshots({
            spec: opts.screenshots,
            dir: screenshotsDirFor(opts.screenshots, join(logsDirFor(), artifactName)),
            secrets,
            title: `journey ${journey.metadata.name}`,
            mask,
          });
    const whatOf = (i: number): string => {
      const s = flat[i];
      if (s === undefined) return `step ${i + 1}`;
      const pick = [s.recorded.objective, s.recorded.step.label].map((t) => (t ?? "").trim()).find((t) => t !== "");
      return pick ?? describeStep(s.recorded.step);
    };
    // #293: a given session is the caller's — replayed into, never opened or closed here.
    const session =
      opts.session ??
      (await openPort().open({
        ...sessionLaunchOptions(opts.browser, videoDir),
        allowedOrigins,
        baseUrl: journey.recording.site,
        ...opts.emulation,
        ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
      }));
    const closeSession = opts.session === undefined ? closeOnce(() => session.close()) : async (): Promise<void> => undefined;
    try {
      const actor = CastActor.named("cli-runner").whoCan(
        new BrowseTheWeb(session, allowedOrigins),
        ...gate.abilities,
      );
      const replayDeltas = opts.actionDeltas === true ? new ReplayDeltas({ secrets, recorded: flat.map((f) => f.recorded) }) : undefined;
      // #322/#400: a full replay (never an anchored prefix) must also satisfy the Journey's end state
      // and each step's request expectations.
      const outcomeChecks = new JourneyOutcomeChecks(session.page, journey === full ? replayed : undefined, { secrets });
      const blocker = mutation.blockWritesAtStep === undefined ? undefined : await stepWriteBlocker(session.page, mutation.blockWritesAtStep, allowedOrigins);
      // #453 (Q2): a guarded click/fill heal probe runs under a per-step write blocker.
      // Context-level (popups, WebSockets), no write exemptions; see heal-probe-guard.ts.
      const healGuard = opts.heal === undefined || policy.selfHeal.mode === "fail-closed" ? undefined : await installHealProbeGuard(session.page);
      const observer = composeObservers(
        outcomeChecks.observer(),
        blocker?.observer,
        replayDeltas?.observer(),
        opts.observer,
        shots === undefined ? undefined : screenshotObserver(shots, (a) => a.ability(BrowseTheWebToken).session.page, whatOf),
      );
      const skipStep = mutation.skipStep;
      const interpreter =
        opts.interpreter ??
        (opts.observer === undefined && shots === undefined && replayDeltas === undefined && outcomeChecks.observer() === undefined && blocker === undefined && healGuard === undefined && skipStep === undefined
          ? new RecordingInterpreter()
          : new RecordingInterpreter({ observer, ...(skipStep === undefined ? {} : { skipStep: (i: number) => skipStep(i) }) }));
      const heal: JourneyHealOptions | undefined =
        opts.heal === undefined || healGuard === undefined
          ? undefined
          : { scope: opts.heal.scope, riskOf: journeyStepRisk(), writeGuard: healGuard.guard, allowedOrigins, observe: healObserver(healDir, mask) };
      const runner = new JourneyRunner(actor, interpreter, undefined, undefined, opts.selfHealer, heal);
      let result: JourneyRunResult;
      try {
        result = redactSecretParams(
          await outcomeChecks.run(actor, () => runner.run({ journey: replayed, params, policy })),
          journey,
          params,
        );
      } finally {
        await gate.done();
        await blocker?.guard.disarm();
        await healGuard?.guard.disarm();
        await healGuard?.dispose();
      }
      // #453: a self-heal run persists its record (heal attempts, the proposal) and indexes it.
      const healFields = policy.selfHeal.mode === "fail-closed" ? {} : await persistHealRun({ result, stored, journey, params, secrets, opts, stampBase, startedAt, replayedIsStored: journey === full && opts.environment === undefined && mutation.mutateJourney === undefined });
      const mutationFields: MutationReplayFields = {
        ...(mutation.structuredFailures === true ? { outcomeFailures: redactSecretParams([...outcomeChecks.lastFailures], journey, params) } : {}),
        ...(blocker === undefined ? {} : { blockedWrites: blocker.guard.drain() }),
      };
      const shotFields = shots === undefined ? {} : await shots.finish();
      const deltaFields = replayDeltas === undefined ? {} : { actionDeltas: redactSecretParams(replayDeltaSummary(replayDeltas), journey, params) };
      // #245: the context closed (its video finalized) before the result naming it is returned.
      const videos = await finalizeVideos(videoDir, closeSession);
      if (fx === undefined) return { ...result, ...healFields, ...videos, ...shotFields, ...deltaFields, ...mutationFields };
      await fx.restore();
      // #399: a fixture output passed in as a secret param (`--param t='${setup.t}'`) is redacted here too.
      return { ...result, ...healFields, ...videos, ...shotFields, ...deltaFields, ...mutationFields, fixtures: redactSecretParams(fx.record(), journey, params) };
    } finally {
      await closeSession();
    }
  } catch (err) {
    // #399: an error escaping the run (a crash, a closed page) may echo a navigated URL that
    // carried a secret parameter — its message and stack are redacted, its class kept.
    throw redactErrorSecrets(err, secretParamValues(journey, { ...inputParams, ...params }));
  } finally {
    await fx?.restore();
  }
}

/** The heal probe's evidence: a masked screenshot of the page after each candidate, under `<logs>/journey-<id>-<stamp>.heal/`. */
function healObserver(dir: string, mask: SecretPixelMask): NonNullable<JourneyHealOptions["observe"]> {
  return async (actor, at) => {
    const page = actor.ability(BrowseTheWebToken).session.page;
    await mkdir(dir, { recursive: true });
    const path = join(dir, `step-${at.stepIndex + 1}-attempt-${at.attempt}.png`);
    await captureStepScreenshot(page, path, { step: at.stepIndex }, [mask.layer()]);
    return { screenshot: path };
  };
}

/**
 * #453: writes the proposal of a `healed-pending-review` run (the stored Journey is never written)
 * and the run's `journey-<id>-<stamp>.result.json` (recorded in the run index). Returns the fields
 * to put on the result: the `proposal` handle, the `resultPath`.
 */
async function persistHealRun(a: {
  result: JourneyRunResult;
  stored: Journey;
  journey: Journey;
  params: Record<string, string>;
  secrets: readonly string[];
  opts: RunJourneyProgrammaticallyOptions;
  stampBase: string;
  startedAt: string;
  replayedIsStored: boolean;
}): Promise<{ proposal?: JourneyResultProposal & { reviewCommand: string; acceptCommand: string }; resultPath: string }> {
  const resultPath = join(logsDirFor(a.startedAt), `${a.stampBase}.result.json`);
  const id = a.opts.id;
  let proposal: (JourneyResultProposal & { reviewCommand: string; acceptCommand: string }) | undefined;
  if (a.result.outcome === "healed-pending-review" && a.replayedIsStored && a.result.heal !== undefined) {
    const scope = a.opts.heal?.scope;
    try {
      const written = await writeJourneyProposal(a.opts.dir, {
        journeyId: id,
        base: a.stored,
        draft: a.result.revision,
        attempts: a.result.heal.attempts,
        changes: {
          ...(scope?.range === undefined ? {} : { range: scope.range }),
          ...(scope?.baseSha === undefined ? {} : { baseSha: scope.baseSha }),
          ...(scope?.headSha === undefined ? {} : { headSha: scope.headSha }),
          notes: (scope?.evidence ?? []).flatMap((e) => (e.kind === "note" && e.note !== undefined ? [e.note] : [])),
        },
        runResultPath: resultPath,
        secrets: a.secrets,
      });
      proposal = {
        id: written.proposalId,
        path: written.path,
        steps: a.result.revision.steps.map((c) => ({ number: c.index + 1, before: describeStep(c.before), after: describeStep(c.after) })),
        reviewCommand: `jevitate journey review ${id}`,
        acceptCommand: `jevitate journey promote ${id} --proposal ${written.proposalId}`,
      };
    } catch (err) {
      // A revision that touches proof is never stored; the run still reports its outcome.
      if (!(err instanceof JourneyProposalProofError)) throw err;
    }
  }
  const record = journeyResultRecord(a.result, { journey: a.stored, params: a.params, startedAt: a.startedAt, ...(proposal === undefined ? {} : { proposal }) });
  const stamped = { ...record, result: stampRunMetadata(record.result) };
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  recordRun(resultPath, { tags: runTagsOf(stamped.result) });
  return { ...(proposal === undefined ? {} : { proposal }), resultPath };
}

/** How long one blocked step's window stays open for the writes its action triggers (network settle). */
const BLOCK_WINDOW_SETTLE_MS = 5_000;

/**
 * #402 block-write: a `ReadOnlyGuard` armed on the page whose action window is ONLY the given step —
 * opened as it begins, closed once the network settled after it. Every held write is aborted (a
 * write navigation too: never answered with a status that could read as a success).
 */
async function stepWriteBlocker(page: Page, index: number, allowedOrigins: readonly string[]): Promise<{ guard: ReadOnlyGuard; observer: StepObserver }> {
  const guard = new ReadOnlyGuard(writeClassifier({}), { allowlist: [...allowedOrigins], navigationWrites: "abort" });
  await guard.arm(page);
  const monitor = monitorFor(page);
  await monitor.instrument();
  return {
    guard,
    observer: {
      beforeStep: async ({ index: i }) => {
        if (i === index) guard.beginAction();
      },
      afterStep: async ({ index: i }) => {
        if (i !== index) return;
        try {
          await monitor.waitSettled({ ceilingMs: BLOCK_WINDOW_SETTLE_MS });
        } finally {
          guard.settled();
        }
      },
    },
  };
}

/** `err` with every secret (and its URL-encoded forms) masked in its message and stack — same object, same class. */
export function redactErrorSecrets(err: unknown, secrets: readonly string[]): unknown {
  if (!(err instanceof Error) || secrets.length === 0) return err;
  err.message = redactText(err.message, secrets);
  if (err.stack !== undefined) err.stack = redactText(err.stack, secrets);
  return err;
}
