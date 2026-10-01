import {
  FsJourneyStore,
  JourneyRegistry,
  JourneyStepError,
  deriveParamSchema,
  journeyBranchPoint,
  journeyPrefix,
  prefixLandingPath,
  resolveJourneyStep,
  secretParamValues,
  validateParams,
  type JourneyBranchPoint,
} from "@jevitate/journey";
import { assertAuthorizedExploreTarget } from "@jevitate/explore";
import type { BrowserSession } from "@jevitate/playwright";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { applyJourneyEnvironment, type ResolvedJourneyEnvironment } from "./environments.js";
import { JourneyRequiresAuthError, UnknownJourneyError, prefixParams, runJourneyProgrammatically } from "./journey-api.js";
import type { BrowserRunOptions } from "./browser-run-options.js";
import { withSiteGate } from "./site-gate-cli.js";

/**
 * #293 — journey-anchored exploration: `jevitate explore --from-journey <id> --at-step <n|name>`.
 *
 * The mission's browser session opens as usual (its storage state, emulation, demo mode); then the
 * promoted Journey's PREFIX — its first `step` top-level steps — is replayed INTO that session by the
 * one Journey replay there is (`runJourneyProgrammatically`: fail-closed, never self-healing, the
 * site policy and `--env` environment applied), and the mission starts on the live page it left:
 * same page, form contents and session, no fresh navigation. A prefix that no longer replays ends
 * the run with a typed `journey-stale` outcome (exit 2) — never a silent restart from a URL.
 *
 * Everything that can be refused is refused before any browser opens (`resolveJourneyPrefix`): an
 * unknown or unpromoted Journey, a step or anchor it does not have, params that do not fit, a
 * Journey that needs a session the run was not given.
 */

/** The strategies a mission can branch off a Journey with (`--feature` and multi-runs are refused). */
export { ANCHORED_STRATEGIES, type AnchoredStrategy } from "@jevitate/journey";

/** `--from-journey`/`--at-step` cannot be used as given (exit 64, nothing ran). */
export class JourneyPrefixArgsError extends Error {
  readonly code = "E_EXPLORE_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "JourneyPrefixArgsError";
  }
}

/**
 * The Journey prefix did not replay up to the anchor: the Journey is stale (a step's target is gone,
 * the app changed). The run ends `inconclusive` with `failure.kind: "journey-stale"` (exit 2).
 */
export class JourneyPrefixStaleError extends Error {
  readonly code = "E_JOURNEY_STALE" as const;
  constructor(
    message: string,
    readonly branch: JourneyBranchPoint,
    /** The 1-based Journey step that failed, when the replay names it. */
    readonly failedStep?: number,
  ) {
    super(message);
    this.name = "JourneyPrefixStaleError";
  }
}

export interface JourneyPrefix {
  readonly branch: JourneyBranchPoint;
  /**
   * Where the prefix is expected to land, from the Recording alone (on the environment's origin) —
   * the run's origin, allowlist and per-target settings are decided from it before any browser
   * opens. The mission itself starts from the LIVE page URL the replay leaves.
   */
  readonly startUrl: string;
  /** The origins the Journey's steps may be on: the environment's, else the Journey's own site. */
  readonly allowedOrigins: readonly string[];
  /**
   * The values of the prefix's SECRET params (declared `secret: true`, or credential-like names): the
   * replay types them into the page the mission then perceives, so the mission must redact them.
   */
  readonly secrets: readonly string[];
  /**
   * Replays the prefix into `session` (left open) and returns the live URL the mission starts on.
   * `browser` is how the run launched (a Journey recorded with extensions needs the same build).
   * Throws `JourneyPrefixStaleError` when the replay stops before the anchor.
   */
  replay(session: BrowserSession, browser?: BrowserRunOptions): Promise<string>;
}

export interface ResolveJourneyPrefixOptions {
  /** The Journey store directory. */
  readonly dir: string;
  readonly id: string;
  /** `--at-step`: a 1-based step number or an anchor name. */
  readonly atStep: string;
  readonly params: Record<string, string>;
  /** `--env`/`--base-url` (#247): the Journey's recorded URLs move onto this environment. */
  readonly environment?: ResolvedJourneyEnvironment;
  /** The mission's session file (also checked against the Journey's `requiresAuth`). */
  readonly storageState?: string;
  /** The site-policy database (`jevitate site policy`): pacing and budgets apply to the replay. */
  readonly dbPath?: string;
}

/**
 * Resolves `--from-journey <id> --at-step <n|name>` into a replayable prefix — refusing, before any
 * browser opens, an unknown Journey (`UnknownJourneyError`), an unpromoted one or a step it lacks
 * (`JourneyPrefixArgsError`), params that do not fit (`ParamValidationError`), and a Journey that
 * declares `requiresAuth` with no session (`JourneyRequiresAuthError`).
 */
export async function resolveJourneyPrefix(opts: ResolveJourneyPrefixOptions): Promise<JourneyPrefix> {
  const stored = await new JourneyRegistry(new FsJourneyStore(opts.dir)).get(opts.id);
  if (stored === null) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  if (!stored.metadata.promoted) {
    throw new JourneyPrefixArgsError(
      `journey '${opts.id}' is not promoted — missions branch only off promoted Journeys (a person promotes it: jevitate journey promote ${opts.id})`,
    );
  }
  const full = applyJourneyEnvironment(stored, opts.environment);
  let resolved: ReturnType<typeof resolveJourneyStep>;
  try {
    resolved = resolveJourneyStep(full, opts.atStep);
  } catch (err) {
    if (err instanceof JourneyStepError) throw new JourneyPrefixArgsError(err.message);
    throw err;
  }
  if (full.metadata.requiresAuth === true && opts.storageState === undefined) {
    throw new JourneyRequiresAuthError(`journey '${opts.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`);
  }
  const prefix = journeyPrefix(full, resolved.step);
  const used = prefixParams(full, prefix, opts.params);
  validateParams(deriveParamSchema(prefix.recording), used);
  const branch = journeyBranchPoint(full, resolved);
  const site = full.recording.site;
  let startUrl: string;
  try {
    startUrl = new URL(prefixLandingPath(full, resolved.step), site).href;
  } catch {
    throw new JourneyPrefixArgsError(`journey '${opts.id}' has no usable site URL (${JSON.stringify(site)})`);
  }
  const allowedOrigins = opts.environment === undefined ? [new URL(site).origin] : [...opts.environment.allowedOrigins];
  const where = `step ${branch.step}${branch.anchor === undefined ? "" : ` (anchor ${branch.anchor})`}`;
  return {
    branch,
    startUrl,
    allowedOrigins,
    secrets: secretParamValues(full, used),
    replay: async (session, browser) => {
      let run: Awaited<ReturnType<typeof runJourneyProgrammatically>>;
      try {
        run = await withSiteGate(opts.dbPath, (siteGate) =>
          runJourneyProgrammatically({
            dir: opts.dir,
            id: opts.id,
            params: opts.params,
            session,
            stopAfterStep: resolved.step,
            ...(siteGate === undefined ? {} : { siteGate }),
            ...(opts.environment === undefined ? {} : { environment: opts.environment }),
            ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
            ...(browser === undefined ? {} : { browser }),
          }),
        );
      } catch (err) {
        // The site policy's own refusal keeps its code; anything else that stopped the replay means
        // the Journey did not reach its anchor — typed, never a restart from a URL.
        if (err instanceof SiteGateRefusedError) throw err;
        const message = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
        throw new JourneyPrefixStaleError(`journey '${opts.id}' did not replay to ${where}: ${message}`, branch);
      }
      if (run.outcome !== "ok") {
        const failed = run.outcome === "quarantined" && run.at !== undefined ? run.at + 1 : undefined;
        const reason = run.outcome === "quarantined" ? run.reason : "the replay healed a step (a self-healed prefix is never a branch point)";
        throw new JourneyPrefixStaleError(`journey '${opts.id}' is stale: it no longer reaches ${where} — ${reason}`, branch, failed);
      }
      return session.page.url();
    },
  };
}

/** What an anchored run starts from: the live URL after the prefix, and its branch point. */
export interface AnchoredStart {
  readonly url: string;
  readonly branch?: JourneyBranchPoint;
}

/**
 * The runners' one call (#293): with no prefix, the mission starts at `url` as always; with one, the
 * prefix is replayed into `session` and the mission starts on the live page it left — which must
 * still be an authorized origin (`UnauthorizedExploreTargetError` otherwise).
 */
export async function startFromJourney(
  prefix: JourneyPrefix | undefined,
  session: BrowserSession,
  url: string,
  allowlist: readonly string[],
  browser?: BrowserRunOptions,
): Promise<AnchoredStart> {
  if (prefix === undefined) return { url };
  const live = await prefix.replay(session, browser);
  assertAuthorizedExploreTarget(live, allowlist);
  return { url: live, branch: prefix.branch };
}

/** The result fields an anchored run adds (#293, additive): its branch point. */
export function branchFields(start: AnchoredStart): { branch?: JourneyBranchPoint } {
  return start.branch === undefined ? {} : { branch: start.branch };
}

/** The typed result of a run whose prefix did not replay (exit 2): `inconclusive`, `failure.kind: "journey-stale"`. */
export interface JourneyStaleResult {
  readonly strategy: string;
  readonly outcome: "inconclusive";
  readonly missionOutcome: "inconclusive";
  readonly reason: string;
  readonly failure: { readonly kind: "journey-stale"; readonly message: string };
  readonly branch: JourneyBranchPoint;
  /** The 1-based Journey step whose replay failed, when known. */
  readonly failedStep?: number;
  readonly exitCode: 2;
}

export function journeyStaleResult(err: JourneyPrefixStaleError, strategy: string): JourneyStaleResult {
  return {
    strategy,
    outcome: "inconclusive",
    missionOutcome: "inconclusive",
    reason: err.message,
    failure: { kind: "journey-stale", message: err.message },
    branch: err.branch,
    ...(err.failedStep === undefined ? {} : { failedStep: err.failedStep }),
    exitCode: 2,
  };
}
