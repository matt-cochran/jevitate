import { NOT_A_CREDENTIAL_WAY_OUT, fixtureSecretNeeds, secretBoundNeeds, type BoundSecretParams } from "./secret-params.js";
import type { JourneyRunRecorder } from "./journey-run-record.js";
import { JourneyRunEvidenceWriter } from "./journey-run-evidence.js";
import { hasRunHooks, resolveRunMode, runReadDoneCheckHooks, runValidateParamsHooks, withRunHookGuard, type RunHookContext, type RunMode } from "./journey-run-hooks.js";
import { allowedOriginSet, offAllowlistWriteOrigin, prepareMcpRunGuard } from "./mcp-run-guard.js";
import { FsJourneyStore, JourneyRegistry, ParamValidationError, declaredNonSecretParams, describeStep, isSecretName, loadRefusedParamNames, flatJourneySteps, journeyEndState, journeyParamSchema, journeyPrefix, lintJourney, lintUploadFixtures, secretNamedValues, secretParamNames, secretParamValues, stampAnchorStepIds, validateParams, type Journey, type JourneyApproval, type JourneyLintFinding, type ApprovalProvenance } from "@jevitate/journey";
import { assertHttpChecksAllowed, createHttpProbe, httpCheckRefs } from "./http-probe.js";
import { programmaticProvenance, type ApprovalConfirm } from "./approval-provenance.js";
import { journeyEntry } from "./forge-verify.js";
import { checkProposal, deleteJourneyProposal, proposedJourney, rejectJourneyProposal, requireJourneyProposal } from "./journey-proposal-store.js";
import { journeyReviewHash } from "./journey-review.js";
import { readApprovedSnapshot, writeApprovedSnapshot } from "./journey-review-store.js";
import { anchorRuleMode, assertAnchorRules, journeyAnchorIssues, refLintFindings } from "./journey-anchor-gate.js";
import { journeyCatalogGate, loadCatalog, resolveCatalogDir } from "./catalog-api.js";
import { journeyDoneCheckFindings } from "./catalog-refs.js";
import type { JevSetup } from "./jev-advisor.js";
import { redactText } from "@jevitate/ai-core";
import { safeRunPolicy, runTagsOf, type RunPolicy, clock, contentHash } from "@jevitate/domain";
import { dirname, join } from "node:path";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession, type EmulationSpec } from "@jevitate/playwright";
import { assertSameExtensionBuild, closeOnce, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { artifactStamp } from "./mission-journal.js";
import { findProjectDir, logsDirFor, type LayoutDeps } from "./project-dir.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter, type StepObserver } from "@jevitate/interpreter";
import { ReadOnlyGuard, ReplayDeltas, normalizeAllowlist, monitorFor, replayDeltaSummary, resolveMissionFixture, type BlockedWrite, type ReplayDeltaSummary } from "@jevitate/explore";
import { ensureStepIds, fixtureNoRoot, writeClassifier } from "@jevitate/recording";
import type { Page } from "playwright";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { SecretPixelMask, maskingPort } from "./demo-capture.js";
import { RunScreenshots, composeObservers, screenshotObserver, screenshotsDirFor, type ScreenshotsResult, type ScreenshotsSpec } from "./run-screenshots.js";
import { JourneyRunner, flattenRecording, retargetRecording, type ProposedRevisionDraft, type ChangeScope, type JourneyHealOptions, type JourneyRunResult, type SelfHealer, type SiteGateDeps } from "@jevitate/runtime";
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
import { JourneyOutcomeChecks, type OutcomeCheckFailure, type SlowStep } from "./journey-network-checks.js";
import { assertHandbackNoHeal, attachHandback, HandbackWriteObserver } from "./journey-handback.js";
import type { HandbackOutcome } from "@jevitate/journey";

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
  /** #788: decides on the stored Journey, right after it is read and before anything else: throws to refuse the run. */
  assertRunnable?: (stored: Journey) => Promise<void>;
  /** #789: the `targets.json` an MCP run's guard reads (default: `~/.jevitate/targets.json`). */
  runGuardTargetsFile?: string;
  /** #790: told what the run resolved to and watches its writes, for its value-free record. With it the run also writes its RunEvidence (#812). */
  runRecorder?: JourneyRunRecorder;
  /**
   * The secret parameters an operator's binding supplied (secret-params.ts) → where each may be
   * typed: its origins, or `allowlist` for this run's allowlist. Checked at type time.
   */
  boundSecretParams?: BoundSecretParams;
  /** Told the run's `output` before it is redacted, for a caller that hands it on to a page (`journey chain`). Never reported. */
  onRawOutput?: (output: unknown) => void;
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
   * `allowedOrigins` (#543): the replay's effective allowlist (site/environment ∪ the Journey's
   * `metadata.allowedOrigins` ∪ `--allow`) — what `journey run`/`verify` let a fixture reach, so a
   * fixture can reset an `http` check's source (a dev outbox) on an origin the human allowed.
   * `sourceSite` is the Journey's RECORDED site (before any environment rebase), from which
   * `fixtureRebaseUrl` finds the source environment's named origins (#561).
   */
  fixtures?: (site: string, allowedOrigins: readonly string[], sourceSite: string) => MissionFixtures | undefined;
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
   * #488: the project root a relative `upload` fixture path resolves against (default: the parent
   * of the nearest `.jevitate/`, else the git root, else cwd). Testing seam.
   */
  fixtureBaseDir?: string;
  /**
   * The environment to run against (#247, `--env`/`--base-url`, from `resolveJourneyEnvironment`):
   * the Journey's recorded same-origin URLs move onto its `baseUrl` and the run's allowlist is its
   * `allowedOrigins`; a step on any other origin is refused before any fixture or browser.
   * Absent: the Journey's recorded site, exactly as before.
   */
  environment?: ResolvedJourneyEnvironment;
  /**
   * #542 (`--allow`): extra origins the replay may reach and block writes on, normalized. The
   * effective allowlist is the union of the recorded site (or the environment's origins), the
   * Journey's `metadata.allowedOrigins` and these.
   */
  allow?: readonly string[];
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
  /**
   * #486: how long (ms) a step's response check waits for a matching request that was sent but has no
   * response yet (a cold start). A late 2xx is an advisory `slowSteps` finding, never a quarantine.
   * Default 15000; a step's own `responseTimeoutMs` overrides it.
   */
  stepResponseTimeoutMs?: number;
}

/**
 * #402: how a mutation-proof replay (`journey verify --mutate`) differs from `journey run` — a
 * separate argument, never a surface option: no other caller passes it.
 */
export interface MutationReplayOptions {
  /** #708: declared proof only; original check indices/capture are preserved. Never a CLI/MCP flag. */
  relaxedStepRequests?: readonly string[];
  /**
   * #402 `journey verify --mutate`: replay a MUTATED copy of the Journey. Applied after params are
   * validated against the stored Journey (a mutation may stop a step reading a param), and never to
   * an anchored prefix. Indices must be kept: a mutation changes a step, never removes one.
   */
  mutateJourney?: (journey: Journey) => Journey;
  /** #402: leave this flat step (0-based) out of the replay — `RecordingInterpreter`'s `skipStep`. */
  skipStep?: (index: number) => boolean;
  /**
   * #579: a swap-param feeding a `select` selects a DIFFERENT enabled live option at this flat step
   * (0-based) instead of rewriting the param — `RecordingInterpreter`'s `selectAlternative`.
   */
  selectAlternativeAtStep?: { index: number; avoid: string };
  /**
   * #402: ABORT the write requests (the #110 classifier, first-party only — `ReadOnlyGuard`) that
   * start while this flat step (0-based) runs, until the network settles after it. Never answered,
   * never sent; what was blocked comes back as `blockedWrites`.
   */
  blockWritesAtStep?: number;
  /**
   * With `blockWritesAtStep`: these recorded write lines stay blocked for the rest of the replay, so a
   * client's retry of an aborted write cannot land later. `exemptSteps` (0-based) record the same line
   * as their own, so it goes through while they run.
   */
  blockAfterWindow?: { requests: readonly string[]; exemptSteps: readonly number[] };
  /** Mutation proof: runs first as each step ends, before anything that step goes on waiting for. */
  earliestObserver?: StepObserver;
  /** #402: also return the outcome checks' structured failures (`outcomeFailures`). */
  structuredFailures?: boolean;
  /** Mutation proof: awaited just before the end state's checks start. */
  beforeEndState?: () => Promise<void>;
  /** Mutation proof: called as the end state's checks end. They settle first, so only this shows when the base replay read it. */
  afterEndState?: () => void;
  /** A proof must not trust a replay after a failed restore. Called once the run's restore has ended, however the run ended. */
  onFixtureRestoreFailed?: () => void;
}

/** #402: what a mutation-proof replay returns beyond `journey run`'s result. */
export interface MutationReplayFields {
  /** The step-request / end-state checks that failed (`structuredFailures`). */
  outcomeFailures?: OutcomeCheckFailure[];
  /** The writes aborted in `blockWritesAtStep`'s window, and after it (`blockAfterWindow`). */
  blockedWrites?: BlockedWrite[];
  /** `METHOD /path` of a blocked line a server answered after the window all the same (a popup, a worker). */
  blockEscaped?: string[];
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
/**
 * #564: a run's full secret set — its secret-param values plus every value the run bound under a
 * credential-like name (an `extract as: "apiKey"` output, read from the result's `output`).
 */
const secretBoundNoHeal = (needs: readonly string[]): string =>
  `${needs.length === 0 ? "this run holds a secret (a secret parameter, a fixture secret or an extracted credential)" : `this Journey needs ${needs.join(", ")}`}, and nothing secret-bound goes to a model. Fix the step by hand, or heal a Journey that needs no secret. ${NOT_A_CREDENTIAL_WAY_OUT}`;

export function runSecretValues(secrets: readonly string[], result: unknown, nonSecret: ReadonlySet<string> = new Set()): string[] {
  const output = result !== null && typeof result === "object" && "output" in result ? (result as { output: unknown }).output : undefined;
  return [...new Set([...secrets, ...secretNamedValues(output, nonSecret)])];
}

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
  const known = journeyParamSchema(full).required;
  const unknown = Object.keys(params).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new ParamValidationError(`param mismatch — missing: [], unknown: [${unknown.join(", ")}]`);
  const needed = journeyParamSchema(prefix).required;
  return Object.fromEntries(Object.entries(params).filter(([k]) => needed.includes(k)));
}

/**
 * #488/#498: the project root relative `upload` fixture paths resolve against and must lie inside —
 * the directory holding a found `.jevitate/` project, and nothing else. No project ⇒ undefined, and
 * every upload is refused (`fixture-no-root`): a git root or the working directory (`/`, `$HOME`)
 * would confine nothing (0.12.0 review H1).
 */
export function journeyFixtureBaseDir(deps: LayoutDeps = {}): string | undefined {
  const project = findProjectDir(deps);
  return project === null ? undefined : dirname(project);
}

/**
 * #498: a mission's `--fixture`, checked at mission start against the project root — refused
 * (`fixture-no-root`) when there is no project, rather than only stat-checked (0.12.0 review H1).
 */
export async function resolveProjectMissionFixture(path: string, deps: LayoutDeps = {}): Promise<string> {
  const root = journeyFixtureBaseDir(deps);
  if (root === undefined) throw fixtureNoRoot(path);
  return resolveMissionFixture(path, root);
}

/**
 * #401: the assertion-strength lint (#401) for one Journey by id — an unknown id is refused,
 * exactly as `journey run`/`promote` refuse one (`UnknownJourneyError`). Pure read; no browser.
 */
export async function lintJourneyById(
  dir: string,
  id: string,
  opts: { readRequests?: readonly string[]; catalogDir?: string | null; baseDir?: string } = {},
): Promise<JourneyLintResult> {
  const registry = new JourneyRegistry(new FsJourneyStore(dir));
  const journey = await registry.get(id);
  if (!journey) {
    throw new UnknownJourneyError(`unknown journey '${id}'`);
  }
  // #466: the 0.10 anchor rules are warnings here (lintJourney's own, plus the catalog's jobStep/serves references).
  const { refIssues } = await journeyAnchorIssues(journey, { catalogDir: opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir: dir });
  // #488: resolve relative upload fixture paths against the project root (the `.jevitate` parent).
  const baseDir = opts.baseDir ?? journeyFixtureBaseDir();
  const lintOpts = {
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }),
  };
  // #498: with no project, every literal upload fixture is refused at run time — say so here too.
  const noRoot = baseDir === undefined ? lintUploadFixtures(journey, undefined) : [];
  // #800: the linked job's done-check findings (missing / invalid / cannot be false), about this Journey.
  const doneFindings: JourneyLintFinding[] = [];
  if (journey.metadata.job !== undefined) {
    const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
    const catalog = await loadCatalog(catalogDir, dir);
    for (const f of journeyDoneCheckFindings(catalog, journey)) {
      doneFindings.push({ rule: f.rule, level: f.level, message: f.message, ...(f.fix === undefined ? {} : { fix: f.fix }) });
    }
  }
  const findings = [...lintJourney(journey, lintOpts), ...noRoot, ...refLintFindings(refIssues), ...doneFindings];
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
  /** #498: the project root upload fixtures must lie inside; default `journeyFixtureBaseDir()`. */
  fixtureBaseDir?: string;
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
  const reviewed: Journey = proposal === null ? existing : proposedJourney(existing, proposal);
  // #467: promote mints a stable id for every step that lacks one — BEFORE hashing, so the approval
  // binds to the Journey as stored (the store's own mint is then a no-op). Only ids are added.
  const mintedRecording = ensureStepIds(reviewed.recording);
  // #466: and stamps each anchor with the id of the step it follows (its integer `step` is kept for the bundle).
  const subject: Journey = stampAnchorStepIds(mintedRecording === reviewed.recording ? reviewed : { ...reviewed, recording: mintedRecording });
  // #432: approval binds to what the reviewer read — refused when the Journey changed since. A review
  // of the Journey before promote minted its missing step ids still matches (it differs only by them).
  const contentHash = journeyReviewHash(subject);
  const reviewedNow = opts.reviewedHash?.trim().toLowerCase();
  if (reviewedNow !== undefined && reviewedNow !== contentHash && (subject === reviewed || reviewedNow !== journeyReviewHash(reviewed))) {
    throw new StaleReviewError(
      `journey '${id}' changed after its review sheet was produced (reviewed ${reviewedNow}, now ${contentHash}) — review it again: jevitate journey review ${id}`,
    );
  }
  // #498: an upload fixture outside the project root (or a sensitive one inside it) is refused at
  // run time, so it is never promoted either — not waivable by --accept-weak (no override flag).
  const refused = lintUploadFixtures(subject, opts.fixtureBaseDir ?? journeyFixtureBaseDir()).filter(
    (f) => f.rule === "upload-outside-project" || f.rule === "upload-sensitive-file",
  );
  if (refused.length > 0) {
    throw new WeakJourneyError(
      [
        `journey '${id}' uploads ${refused.length} fixture(s) that would be refused:`,
        ...refused.map((f) => f.message),
        "move the fixture into the project as a dedicated test fixture file",
      ].join("\n"),
      refused,
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
  const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
  const gate = await journeyCatalogGate(subject, {
    catalogDir,
    journeysDir: dir,
    action: opts.action ?? "journey promote",
    ...(opts.acceptUnvetted === undefined ? {} : { acceptUnvetted: opts.acceptUnvetted }),
    ...(opts.acceptFindings === undefined ? {} : { acceptFindings: opts.acceptFindings }),
    ...(opts.jev === undefined ? {} : { jev: opts.jev }),
  });
  // #466: a new promotion, or a re-promotion that changed beyond step ids, must follow the anchor rules;
  // an unchanged or step-id-only (#467 backfill) re-approval only warns (lint / the review sheet).
  const priorHash = existing.metadata.approval?.contentHash;
  const mode = anchorRuleMode(subject, priorHash === undefined ? {} : { approvedHash: priorHash, approvedSnapshot: (await readApprovedSnapshot(dir, id)) ?? existing });
  if (mode === "enforce") assertAnchorRules(id, await journeyAnchorIssues(subject, { catalogDir, journeysDir: dir, enforce: true }));
  // #437: the person confirms the approval and each waiver given with it (or it is refused) — then it is recorded with how it was made.
  // #469: in CI, the confirmation first asks the forge whether a merged, approved PR made this Journey (`pr-review`).
  const entry = journeyEntry(dir, id, contentHash);
  const provenance =
    opts.confirm === undefined
      ? programmaticProvenance()
      : await opts.confirm({
          kind: opts.action === "demo approve" ? "demo" : "journey",
          id,
          contentHash,
          ...(entry === null ? {} : { entry }),
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
    // #466: subject's metadata — the existing one plus the anchors' stamped step ids (what the approval hashed).
    metadata: { ...subject.metadata, promoted: true, ...(acceptedWeak === undefined ? {} : { acceptedWeak }), approval },
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
 * `journeyParamSchema`/`validateParams` (unknown/missing param ->
 * `ParamValidationError`, from `@jevitate/journey`) BEFORE any browser is
 * launched, then builds the real Actor + `JourneyRunner` and runs.
 */
export type RunJourneyResult = JourneyRunResult & { fixtures?: FixtureRecord; videoPaths?: string[]; actionDeltas?: ReplayDeltaSummary; slowSteps?: SlowStep[]; offAllowlistWrites?: string[]; handback?: HandbackOutcome } & Partial<ScreenshotsResult> & MutationReplayFields & HealRunFields;

/**
 * #812/#800: a surface's run (one with a `runRecorder`: `journey run` and `run_journey`) writes its
 * RunEvidence v1 record to its own directory beside the #790 record, whatever the outcome, refusals and
 * errors included. Writing it never changes the outcome: why it could not be written is `evidenceError`
 * on the result, or on the error the run threw, as `runRecordError` is.
 */
export async function runJourneyProgrammatically(opts: RunJourneyProgrammaticallyOptions, mutation: MutationReplayOptions = {}): Promise<RunJourneyResult & { evidenceError?: string }> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const stored = await registry.get(opts.id);
  if (!stored) {
    throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  }
  opts.runRecorder?.noteJourney(stored);
  const evidence = runEvidenceFor(opts, stored);
  if (evidence !== undefined) opts.runRecorder?.deriveFrom(evidence.writer);
  let result: RunJourneyResult;
  try {
    result = await runStoredJourney(opts, mutation, stored, evidence);
  } catch (err) {
    const problem = evidence?.finish(err);
    if (problem !== undefined && err !== null && typeof err === "object") (err as { evidenceError?: string }).evidenceError = problem;
    throw err;
  }
  const problem = evidence?.finish(undefined, result);
  return problem === undefined ? result : { ...result, evidenceError: problem };
}

/** The `evidenceError` a run's thrown error carries, if any. */
export function evidenceErrorOf(err: unknown): string | undefined {
  const v = err !== null && typeof err === "object" ? (err as { evidenceError?: unknown }).evidenceError : undefined;
  return typeof v === "string" ? v : undefined;
}

const STEP_KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ERROR_CODE = /^E_[A-Z0-9_]{1,62}$/;

/** One run's evidence: the writer, the steps the replay reported, and how the record is finished. */
interface RunEvidenceScope {
  readonly writer: JourneyRunEvidenceWriter;
  readonly hooks: { mode: RunMode | undefined };
  /** A StepObserver feeding the writer: the step each write belongs to, and how each step ended. */
  observer(): StepObserver;
  /** The steps of the Journey that ran (a prefix or environment changes none of their kinds). */
  ran(journey: Journey): void;
  finish(err: unknown, result?: RunJourneyResult): string | undefined;
}

function runEvidenceFor(opts: RunJourneyProgrammaticallyOptions, stored: Journey): RunEvidenceScope | undefined {
  const recorder = opts.runRecorder;
  if (recorder === undefined) return undefined;
  let dir: string;
  let writer: JourneyRunEvidenceWriter;
  try {
    const at = recorder.evidenceDir();
    // Run records are off (`JEVITATE_RUN_RECORD=off`): no evidence either, and the recorder watches for itself.
    if (at === undefined) return undefined;
    dir = at;
    writer = new JourneyRunEvidenceWriter({
      channel: recorder.channel,
      journey: { id: opts.id, hash: contentHash(stored) },
      params: opts.params,
      secretParamNames: secretParamNames(stored),
      origin: opts.environment?.baseUrl ?? stored.recording.site,
      ...(opts.environment?.name === undefined ? {} : { environment: opts.environment.name }),
      keyFile: recorder.evidenceKeyFile,
    });
  } catch {
    // A record that cannot even start never fails the run: the #790 record still says what ran.
    return undefined;
  }
  const reported = new Set<number>();
  let kinds: string[] = flatJourneySteps(stored).map((s) => s.recorded.step.kind);
  const kindOf = (index: number): string => {
    const k = kinds[index - 1] ?? "unknown";
    return STEP_KIND.test(k) ? k : "other";
  };
  const hooks: { mode: RunMode | undefined } = { mode: undefined };
  return {
    writer,
    hooks,
    observer: () => ({
      beforeStep: async ({ index }) => writer.beginStep(index + 1),
      afterStep: async ({ index, recorded, outcome }) => {
        reported.add(index + 1);
        writer.noteStep({
          index: index + 1,
          kind: kindOf(index + 1),
          outcome: outcome === "done" ? "ok" : outcome === "failed" ? "failed" : "skipped",
          // A failed step may have failed its action or its expect: which, this run does not tell.
          postcondition: outcome === "failed" ? { known: false, reason: "not-gathered" } : outcome === "done" && "expect" in recorded.step && recorded.step.expect !== undefined ? "held" : "none",
        });
      },
    }),
    ran: (journey) => {
      writer.noteJourney(journey);
      kinds = flatJourneySteps(journey).map((s) => s.recorded.step.kind);
    },
    finish: (err, result) => {
      if (err !== undefined) {
        const e = err as { code?: unknown; extra?: { at?: unknown } } | null;
        const code = typeof e?.code === "string" && ERROR_CODE.test(e.code) ? e.code : undefined;
        const at = e?.extra?.at;
        if (code !== undefined && typeof at === "number" && Number.isInteger(at) && at >= 1) {
          reported.add(at);
          writer.noteStep({ index: at, kind: kindOf(at), outcome: "refused", postcondition: "none", refusal: code });
        }
        writer.note(code === undefined ? "the run ended with an error" : `the run ended with ${code}`);
      } else if (result !== undefined) writer.note(`the run ended ${STEP_KIND.test(result.outcome) ? result.outcome : "with an outcome"}`);
      for (let i = 1; i <= kinds.length; i++) if (!reported.has(i)) writer.noteStep({ index: i, kind: kindOf(i), outcome: "not-reached", postcondition: "none" });
      return writer.finish(dir);
    },
  };
}

async function runStoredJourney(opts: RunJourneyProgrammaticallyOptions, mutation: MutationReplayOptions, stored: Journey, evidence: RunEvidenceScope | undefined): Promise<RunJourneyResult> {
  await opts.assertRunnable?.(stored);
  // #247: onto the chosen environment (a step on an origin it does not allow is refused here).
  const full = applyJourneyEnvironment(stored, opts.environment);
  // #293: only the prefix up to the anchor runs (its params are the ones those steps take).
  const journey = opts.stopAfterStep === undefined ? full : journeyPrefix(full, opts.stopAfterStep);
  opts.runRecorder?.noteJourney(journey);
  evidence?.ran(journey);
  // 0.30.0 run hooks (journey-run-hooks.ts): what every hook is told; the mode once `resolveMode` decided it.
  let mode: RunMode | undefined;
  const hookCtx = (): RunHookContext => ({ journey: stored, params: opts.params, channel: opts.runRecorder?.channel, mode, evidence: evidence?.writer });
  const allowedOrigins = effectiveAllowedOrigins(journey, opts.environment, opts.allow);
  // #543: an http end-state check reads only an origin the replay allows — refused before any
  // fixture or browser (the probe re-checks every request after substitution).
  if (journey === full) assertHttpChecksAllowed(journeyEndState(journey), allowedOrigins, `journey '${opts.id}' end state`);
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
  mode = await resolveRunMode(hookCtx());
  if (mode !== undefined) evidence?.writer.noteMode(mode);
  validateParams(journeyParamSchema(journey), inputParams);
  await runValidateParamsHooks(hookCtx());
  // #402: the mutated copy replays (and is judged); the stored Journey still names, redacts and gates.
  const replayed = mutation.mutateJourney === undefined || journey !== full ? journey : mutation.mutateJourney(journey);

  // #789: under an MCP invocation, this run's guard: a production target is refused here, before anything opens.
  const runGuard = prepareMcpRunGuard({ site: journey.recording.site, allowedOrigins, environment: opts.environment, targetsFile: opts.runGuardTargetsFile });

  const policy = opts.policy ?? safeRunPolicy();
  // #583 §3: a prepare-only boundary never self-heals — refused before any fixture or browser opens.
  assertHandbackNoHeal(journey, policy.selfHeal.mode !== "fail-closed");

  // The site policy (`jevitate site policy set <origin>`): pacing, throttles, budgets, quiet hours —
  // decided before any fixture or browser; a refusal says why and when to retry.
  const gate = await gateJourney(opts.siteGate, journey.recording, { ...(opts.account === undefined ? {} : { account: opts.account }), enforceLimits: true });

  const fx = opts.fixtures?.(journey.recording.site, allowedOrigins, stored.recording.site);
  let params = inputParams;
  try {
    if (fx !== undefined) {
      await fx.setup();
      const b = fx.bindings();
      params = Object.fromEntries(Object.entries(inputParams).map(([k, v]) => [k, substituteSetupRefs(v, b, { where: `--param ${k}` })]));
      // #812: a fixture's outputs, and the params they were bound into, are masked from the evidence's write shapes.
      for (const v of [...Object.values(b.values), ...fx.secrets(), ...Object.values(params)]) evidence?.writer.noteValue(v);
    }
    // #140 order: fixture setup (above) → open the browser (#137 launch options, #118 storageState) → run → restore.
    // #250/#251: a recorded or screenshotted run carries the live pixel mask from its first paint.
    // A fixture's credential-named output is redacted by name, wherever a param carried it.
    const secrets = [...new Set([...secretParamValues(stored, params), ...(fx?.secrets() ?? [])])];
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
    // #485: the origins outside the run's allow list that the page sent a write to (origins only —
    // never a path, query or body). The campaign preflight reads them for an allow-list slip.
    const offAllowlist = watchOffAllowlistWrites(session, allowedOrigins);
    // #812: with evidence the writer watches the run, and the #790 record is derived from what it saw.
    if (evidence === undefined) opts.runRecorder?.attach(session);
    else evidence.writer.attach(session);
    await runGuard?.arm(session, params, evidence === undefined ? opts.runRecorder?.noteRefusedWrite : (request) => evidence.writer.noteRefusedWrite(request, request.method(), request.url()));
    // #583 §3: a declared boundary watches every first-party write for the whole run (aborting them
    // only with `blockWrites`), so the typed handback state is decided from the run's own evidence.
    const handbackObserver =
      journey.metadata.boundary === undefined
        ? undefined
        : new HandbackWriteObserver(allowedOrigins, { blockWrites: journey.metadata.boundary.blockWrites === true });
    if (handbackObserver !== undefined) await handbackObserver.arm(session.page);
    try {
      const actor = CastActor.named("cli-runner").whoCan(
        new BrowseTheWeb(session, allowedOrigins),
        ...gate.abilities,
      );
      const boundOption = opts.boundSecretParams === undefined ? {} : { boundSecretParams: new Map(Object.entries(opts.boundSecretParams).map(([n, o]) => [n, o === "allowlist" ? allowedOrigins : o] as const)) };
      const replayDeltas = opts.actionDeltas === true ? new ReplayDeltas({ secrets, recorded: flat.map((f) => f.recorded) }) : undefined;
      // #322/#400: a full replay (never an anchored prefix) must also satisfy the Journey's end state
      // and each step's request expectations.
      // #543: `${name}` from the run's params (a secret param refused) and `${setup.x}` from the
      // fixture bindings — for the end state's checks and (#565) every step expectation's references.
      const refs = httpCheckRefs({ params, secretParams: loadRefusedParamNames(journey, params), ...(fx === undefined ? {} : { bindings: fx.bindings() }) });
      const outcomeChecks = new JourneyOutcomeChecks(session.page, journey === full ? replayed : undefined, {
        ...(mutation.relaxedStepRequests === undefined ? {} : { relaxedStepRequests: mutation.relaxedStepRequests }),
        secrets,
        // #543: the end state's http checks: allowlist-bound requests.
        httpProbe: createHttpProbe({ allowlist: allowedOrigins }),
        resolveRef: refs,
        ...(opts.stepResponseTimeoutMs === undefined ? {} : { stepResponseTimeoutMs: opts.stepResponseTimeoutMs }),
      });
      const blocker = mutation.blockWritesAtStep === undefined ? undefined : await stepWriteBlocker(session.page, mutation.blockWritesAtStep, allowedOrigins, mutation.blockAfterWindow);
      // #453 (Q2): a guarded click/fill heal probe runs under a per-step write blocker.
      // Context-level (popups, WebSockets), no write exemptions; see heal-probe-guard.ts.
      const healGuard = opts.heal === undefined || policy.selfHeal.mode === "fail-closed" ? undefined : await installHealProbeGuard(session.page, runGuard === undefined ? undefined : (ws) => runGuard.claimSocket(ws));
      const observer = composeObservers(
        evidence?.observer(),
        mutation.earliestObserver,
        outcomeChecks.observer(),
        blocker?.observer,
        replayDeltas?.observer(),
        opts.observer,
        shots === undefined ? undefined : screenshotObserver(shots, (a) => a.ability(BrowseTheWebToken).session.page, whatOf),
      );
      const skipStep = mutation.skipStep;
      const selectAlternative = mutation.selectAlternativeAtStep;
      const fixtureBaseDir = opts.fixtureBaseDir ?? journeyFixtureBaseDir();
      // A value extracted before the run throws has no `output` to be read from, and must still be masked. The guard hears it through the interpreter.
      // #564: a credential the run extracts joins the redaction set as it binds: the heal payload, the evidence screenshots.
      const extractedCredentials = new Set<string>();
      const nonSecretParams = declaredNonSecretParams(stored);
      const onExtracted = async (value: string, name?: string): Promise<void> => {
        opts.runRecorder?.noteValue(value);
        evidence?.writer.noteValue(value);
        if (name === undefined || !isSecretName(name) || nonSecretParams.has(name) || value.trim() === "") return;
        extractedCredentials.add(value);
        await mask.addSecret(value);
      };
      // The #789 guard, then any `beforeWrite` run hook: exactly `runGuard` while none is registered.
      const actionGuard = withRunHookGuard(runGuard, hookCtx);
      const interpreter =
        opts.interpreter ??
        (evidence === undefined && opts.observer === undefined && shots === undefined && replayDeltas === undefined && outcomeChecks.observer() === undefined && blocker === undefined && healGuard === undefined && skipStep === undefined && selectAlternative === undefined && actionGuard === undefined
          ? new RecordingInterpreter({ fixtureBaseDir, refLookup: refs, onExtracted, ...boundOption })
          : new RecordingInterpreter({
              ...boundOption,
              observer,
              fixtureBaseDir,
              refLookup: refs,
              onExtracted,
              ...(actionGuard === undefined ? {} : { actionGuard }),
              ...(skipStep === undefined ? {} : { skipStep: (i: number) => skipStep(i) }),
              ...(selectAlternative === undefined ? {} : { selectAlternative: (i: number) => (i === selectAlternative.index ? { avoid: selectAlternative.avoid } : undefined) }),
            }));
      // Decided from the Journey, before it runs: a break can come before the extract, with the value already on the page.
      const secretBound = [...secretBoundNeeds(stored, params), ...fixtureSecretNeeds(fx)];
      const heal: JourneyHealOptions | undefined =
        opts.heal === undefined || healGuard === undefined
          ? undefined
          : { scope: opts.heal.scope, riskOf: journeyStepRisk(), writeGuard: healGuard.guard, allowedOrigins, noHealBecause: () => (secretBound.length > 0 || secrets.length > 0 || extractedCredentials.size > 0 ? secretBoundNoHeal(secretBound) : undefined), observe: healObserver(healDir, mask) };
      const runner = new JourneyRunner(actor, interpreter, undefined, undefined, opts.selfHealer, heal);
      let result: JourneyRunResult;
      // #564: the run's secrets also cover every value it bound under a credential-like name (an
      // `extract as: "apiKey"`), so the output, failures and artifacts below never carry it.
      let runSecrets: readonly string[] = secrets;
      try {
        // #609: a mutated copy may no longer name a param the stored Journey takes (a targeted proof
        // relaxed the only check naming an assertion-only `expected_*` param). The supplied set was
        // validated against the stored Journey above; the copy runs with the subset it still reads.
        const replayParams = replayed === journey ? params : prefixParams(journey, replayed, params);
        const raw = await outcomeChecks.run(actor, () => runner.run({ journey: replayed, params: replayParams, policy }), {
          collectStepFailuresOnReplayFailure: mutation.structuredFailures === true,
          ...(mutation.beforeEndState === undefined ? {} : { beforeEndState: mutation.beforeEndState }),
          ...(mutation.afterEndState === undefined ? {} : { afterEndState: mutation.afterEndState }),
        });
        runGuard?.check();
        if ("output" in raw) opts.onRawOutput?.(raw.output);
        if ("output" in raw && raw.output !== null && typeof raw.output === "object") for (const v of Object.values(raw.output as Record<string, unknown>)) if (typeof v === "string") evidence?.writer.noteValue(v);
        // The page is still open: a done check reads it here (#800, a later deliverable's hook).
        if (hasRunHooks("readDoneCheck")) await runReadDoneCheckHooks({ ...hookCtx(), page: session.page, result: raw });
        runSecrets = [...new Set([...runSecretValues(secrets, raw, nonSecretParams), ...extractedCredentials])];
        result = redactSecretValues(raw, runSecrets);
      } finally {
        await gate.done();
        await healGuard?.guard.disarm();
        await healGuard?.dispose();
        await handbackObserver?.disarm();
      }
      // #453: a self-heal run persists its record (heal attempts, the proposal) and indexes it.
      // #453 review: a run that cannot write its proposal (a prefix or mutated replay, a proof error)
      // is never pending review — `persistHealRun` reports it quarantined, saying why.
      let healFields: Partial<Awaited<ReturnType<typeof persistHealRun>>["fields"]> = {};
      if (policy.selfHeal.mode !== "fail-closed") {
        const unwritable = journey !== full ? "only a prefix of the Journey ran" : mutation.mutateJourney !== undefined ? "a mutated copy of the Journey ran" : undefined;
        const persisted = await persistHealRun({ result, stored, params, secrets: runSecrets, opts, stampBase, startedAt, ...(unwritable === undefined ? {} : { unwritable }) });
        result = persisted.result;
        healFields = persisted.fields;
      }
      // #583: the typed handback state, decided from the run's own results and network evidence —
      // attached only when the Journey declares a boundary (otherwise the result is unchanged).
      result = attachHandback(result, journey, handbackObserver?.counts() ?? { writes: 0, writesBlocked: 0, observation: "unavailable" });
      const slowFields = outcomeChecks.slowSteps.length === 0 ? {} : { slowSteps: [...outcomeChecks.slowSteps] };
      const writeOrigins = offAllowlist.stop();
      const originFields = writeOrigins.length === 0 ? {} : { offAllowlistWrites: redactSecretValues(writeOrigins, runSecrets) };
      const shotFields = shots === undefined ? {} : await shots.finish();
      const deltaFields = replayDeltas === undefined ? {} : { actionDeltas: redactSecretValues(replayDeltaSummary(replayDeltas), runSecrets) };
      // #245: the context closed (its video finalized) before the result naming it is returned.
      const videos = await finalizeVideos(videoDir, closeSession);
      // After the close: a replay stays open a while before it, and a block holds until then.
      await blocker?.guard.disarm();
      const mutationFields: MutationReplayFields = {
        ...(mutation.structuredFailures === true ? { outcomeFailures: redactSecretValues([...outcomeChecks.lastFailures], runSecrets) } : {}),
        ...(blocker === undefined ? {} : { blockedWrites: blocker.guard.drain() }),
        ...(blocker === undefined || blocker.escaped().length === 0 ? {} : { blockEscaped: blocker.escaped() }),
      };
      if (fx === undefined) return { ...result, ...healFields, ...videos, ...shotFields, ...deltaFields, ...slowFields, ...originFields, ...mutationFields };
      await fx.restore();
      // #399: a fixture output passed in as a secret param (`--param t='${setup.t}'`) is redacted here too.
      return { ...result, ...healFields, ...videos, ...shotFields, ...deltaFields, ...slowFields, ...originFields, ...mutationFields, fixtures: redactSecretValues(fx.record(), runSecrets) };
    } finally {
      offAllowlist.stop();
      await runGuard?.dispose();
      await closeSession();
    }
  } catch (err) {
    // #399: an error escaping the run (a crash, a closed page) may echo a navigated URL that
    // carried a secret parameter — its message and stack are redacted, its class kept.
    throw redactErrorSecrets(err, secretParamValues(journey, { ...inputParams, ...params }));
  } finally {
    await fx?.restore();
    if (mutation.onFixtureRestoreFailed !== undefined && fx?.restoreFailed() === true) mutation.onFixtureRestoreFailed();
  }
}

/**
 * #542: a replay's allowlist — the recorded site (or the environment's origins), then the Journey's
 * `metadata.allowedOrigins`, then `--allow`, each normalized and deduplicated. Recorded origins are not
 * remapped under `--env`/`--base-url` (no per-origin remap exists; `--allow` or the environment's
 * `allow` name the replacement).
 */
export function effectiveAllowedOrigins(journey: Journey, environment: ResolvedJourneyEnvironment | undefined, allow: readonly string[] = []): string[] {
  const base = environment === undefined ? [journey.recording.site] : [...environment.allowedOrigins];
  const out = [...base];
  for (const o of normalizeAllowlist([...(journey.metadata.allowedOrigins ?? []), ...allow])) if (!out.includes(o)) out.push(o);
  return out;
}

/**
 * #485: records each distinct origin outside `allowedOrigins` that the session's context sent a
 * write (any method but GET/HEAD/OPTIONS) to. A replay never blocks them; this only observes.
 * A session whose page has no context events (a test double) observes nothing.
 */
export function watchOffAllowlistWrites(session: BrowserSession, allowedOrigins: readonly string[]): { stop(): string[] } {
  const allowed = allowedOriginSet(allowedOrigins);
  const seen: string[] = [];
  const onRequest = (request: { method(): string; url(): string }): void => {
    const origin = offAllowlistWriteOrigin(request.method(), request.url(), allowed);
    if (origin !== undefined && !seen.includes(origin)) seen.push(origin);
  };
  const page = session.page as Partial<Page> | undefined;
  const context = typeof page?.context === "function" ? page.context() : undefined;
  if (context === undefined || typeof context.on !== "function") return { stop: () => [...seen] };
  context.on("request", onRequest);
  let stopped = false;
  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        context.off("request", onRequest);
      }
      return [...seen];
    },
  };
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
 * and the run's `journey-<id>-<stamp>.result.json` (recorded in the run index). Returns the result
 * to report and the fields to put on it: the `proposal` handle, the `resultPath`.
 *
 * A run on an environment (`--env` / `--base-url`) proposes against the STORED Journey: a retarget
 * changes a target or a navigate path, and a navigate URL moved onto the environment's base URL is
 * moved back onto the recorded site. Where no proposal can be written (`unwritable`: a prefix or
 * mutated replay; or a revision the proof check refuses) the run is NOT pending review — there is
 * nothing to accept — it is reported `quarantined`, its reason saying why no proposal was written.
 * A `healed-pending-review` result never leaves here without a proposal id.
 */
async function persistHealRun(a: {
  result: JourneyRunResult;
  stored: Journey;
  params: Record<string, string>;
  secrets: readonly string[];
  opts: RunJourneyProgrammaticallyOptions;
  stampBase: string;
  startedAt: string;
  unwritable?: string;
}): Promise<{ result: JourneyRunResult; fields: { proposal?: JourneyResultProposal & { reviewCommand: string; acceptCommand: string }; resultPath: string } }> {
  const resultPath = join(logsDirFor(a.startedAt), `${a.stampBase}.result.json`);
  const id = a.opts.id;
  let result = a.result;
  let proposal: (JourneyResultProposal & { reviewCommand: string; acceptCommand: string }) | undefined;
  if (result.outcome === "healed-pending-review") {
    let why: string | undefined = a.unwritable ?? (result.heal === undefined ? "the run carries no heal record" : undefined);
    if (why === undefined && result.heal !== undefined) {
      const scope = a.opts.heal?.scope;
      try {
        const draft = draftOnStored(a.stored, result.revision, a.opts.environment);
        const written = await writeJourneyProposal(a.opts.dir, {
          journeyId: id,
          base: a.stored,
          draft,
          attempts: result.heal.attempts,
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
          steps: draft.steps.map((c) => ({ number: c.index + 1, before: describeStep(c.before), after: describeStep(c.after) })),
          reviewCommand: `jevitate journey review ${id}`,
          acceptCommand: `jevitate journey promote ${id} --proposal ${written.proposalId}`,
        };
      } catch (err) {
        // A revision that touches proof (or fails the heal floor) is never stored.
        if (!(err instanceof JourneyProposalProofError)) throw err;
        why = err.message;
      }
    }
    if (proposal === undefined) {
      result = {
        outcome: "quarantined",
        reason: `the run completed only after a heal, but no proposal was written (${why ?? "unknown"}) — there is nothing to accept; re-run on the recorded site without a prefix or mutation`,
        ...(result.waits === undefined ? {} : { waits: result.waits }),
        ...(result.heal === undefined ? {} : { heal: result.heal }),
      };
    }
  }
  const record = journeyResultRecord(result, { journey: a.stored, params: a.params, startedAt: a.startedAt, ...(proposal === undefined ? {} : { proposal }) });
  const stamped = { ...record, result: stampRunMetadata(record.result) };
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  recordRun(resultPath, { tags: runTagsOf(stamped.result) });
  return { result, fields: { ...(proposal === undefined ? {} : { proposal }), resultPath } };
}

/**
 * The revision a run on an environment proposed, onto the STORED Journey: each changed step's
 * `before` is the stored step, its `after` the retarget — a navigate URL on the environment's base
 * URL moved back onto the recorded site. Without an environment the draft is the stored Journey's.
 */
export function draftOnStored(stored: Journey, draft: ProposedRevisionDraft, env: ResolvedJourneyEnvironment | undefined): ProposedRevisionDraft {
  if (env === undefined) return draft;
  let recordedOrigin: string | undefined;
  try {
    recordedOrigin = /^https?:\/\//i.test(stored.recording.site) ? new URL(stored.recording.site).origin : undefined;
  } catch {
    recordedOrigin = undefined;
  }
  const base = env.baseUrl.replace(/\/+$/, "");
  const unbase = (url: string): string => {
    if (recordedOrigin === undefined || !url.startsWith(base)) return url;
    const rest = url.slice(base.length);
    return rest === "" || /^[/?#]/.test(rest) ? `${recordedOrigin}${rest}` : url;
  };
  const flat = flattenRecording(stored.recording);
  let recording = stored.recording;
  const steps = draft.steps.map((c) => {
    const before = flat[c.index]?.step;
    if (before === undefined) throw new JourneyProposalProofError(`the revision changes step ${c.index + 1}, which the stored Journey does not have`);
    // #467: the index must still name the step that was healed.
    const storedId = flat[c.index]?.recorded.stepId;
    if (c.stepId !== undefined && storedId !== c.stepId) {
      throw new JourneyProposalProofError(`the revision changes step ${c.index + 1} (${c.stepId}), but the stored Journey's step ${c.index + 1} is ${storedId ?? "(no id)"}`);
    }
    // A target is environment-independent; only an absolute navigate URL was moved (rebaseRecording).
    const after = c.after.kind === "navigate" ? { ...c.after, url: unbase(c.after.url) } : c.after;
    recording = retargetRecording(recording, c.index, after);
    return { ...c, before, after };
  });
  return { recording, steps };
}

/** How long one blocked step's window stays open for the writes its action triggers (network settle). */
const BLOCK_WINDOW_SETTLE_MS = 5_000;

/**
 * A write on a held line that got an answer, by `line`. A response is the answer: Chromium may never
 * report the end of a body the page does not read, and a write the server answered did not stay blocked.
 */
export function watchEscapedWrites(
  context: { on(event: "request" | "response", listener: (arg: never) => void): unknown },
  lineIfHeld: (r: { method(): string; url(): string }) => string | undefined,
): () => string[] {
  const sent = new Map<unknown, string>();
  const escaped = new Set<string>();
  context.on("request", ((r: { method(): string; url(): string }) => {
    const line = lineIfHeld(r);
    if (line !== undefined) sent.set(r, line);
  }) as (arg: never) => void);
  context.on("response", ((res: { request(): unknown }) => {
    const line = sent.get(res.request());
    if (line !== undefined) escaped.add(line);
  }) as (arg: never) => void);
  return () => [...escaped];
}

/**
 * #402 block-write: a `ReadOnlyGuard` armed on the page whose action window is the given step — opened
 * as it begins, closed once the network settled after it. Every held write is aborted (a write
 * navigation too: never answered with a status that could read as a success). The step's own lines
 * stay blocked after the window (`blockAfterWindow`). What the guard's page route cannot reach is watched
 * on the context: a matching write answered after the window means the mutation did not hold.
 */
async function stepWriteBlocker(
  page: Page,
  index: number,
  allowedOrigins: readonly string[],
  after: MutationReplayOptions["blockAfterWindow"],
): Promise<{ guard: ReadOnlyGuard; observer: StepObserver; escaped: () => string[] }> {
  const guard = new ReadOnlyGuard(writeClassifier({}), { allowlist: [...allowedOrigins], navigationWrites: "abort" });
  await guard.arm(page);
  const monitor = monitorFor(page);
  await monitor.instrument();
  let held: ReadonlySet<string> = new Set();
  let released = false;
  const lineOf = (r: { method(): string; url(): string }): string | undefined => {
    try {
      return `${r.method().toUpperCase()} ${new URL(r.url()).pathname}`;
    } catch {
      return undefined;
    }
  };
  const context = typeof page.context === "function" ? page.context() : undefined;
  const escaped =
    after !== undefined && typeof context?.on === "function"
      ? watchEscapedWrites(context as never, (r) => {
          const line = lineOf(r);
          return !released && line !== undefined && held.has(line) ? line : undefined;
        })
      : () => [];
  return {
    guard,
    escaped,
    observer: {
      beforeStep: async ({ index: i }) => {
        if (i === index) guard.beginAction();
        if (after?.exemptSteps.includes(i) === true) {
          released = true;
          guard.releaseHeldLines(true);
        }
      },
      afterStep: async ({ index: i }) => {
        if (after?.exemptSteps.includes(i) === true) {
          released = false;
          guard.releaseHeldLines(false);
        }
        if (i !== index) return;
        try {
          await monitor.waitSettled({ ceilingMs: BLOCK_WINDOW_SETTLE_MS });
        } finally {
          guard.settled();
          if (after !== undefined) held = guard.holdLines(after.requests);
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
