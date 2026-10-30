import { basename } from "node:path";
import { redactUrl } from "@jevitate/ai-core";
import { findAllowOriginMismatches, normalizeAllowlist } from "@jevitate/explore";
import { PlaywrightBrowserPort, probeOriginReadiness, type BrowserPort, type OriginReadiness } from "@jevitate/playwright";
import { ensurePersonaSession, type SessionCheck } from "./persona-login.js";
import { projectPersonaFor, type PersonaContext } from "./multi-run.js";
import { resourcePreflight } from "./resource-preflight.js";

/**
 * #485 — `campaign run`'s preflight: the campaign's own preconditions, checked before ANY anchored
 * mission starts, so a misconfiguration costs one refusal instead of a whole campaign:
 *
 *  1. reachability — each job's start URL answers a connect (no environment declares a health check);
 *  2. auth — each job's `storageState` is still signed in: the Journey's start page does not land on
 *     a sign-in route or form (the same code check as `explore`'s #427 pre-flight). The storage
 *     state's contents are never read into a message — only its file name;
 *  3. declared context (#746) — the persona context declared for a job's session (`{organization,
 *     role}` from the project's personas file) must agree with the context the Journey declares (its
 *     linked persona's, else its `role`), so a wrong-persona session is refused too;
 *  4. allow list — the discovery replay of each job's Journey sent no write to a loopback origin the
 *     environment's allow list misspells (`localhost` vs `127.0.0.1`) or leaves out (#484 detector):
 *     every mission's write there would be blocked. The problem names the exact origin to add.
 *
 * Every problem is collected (never just the first); the campaign refuses with all of them (exit 64).
 */

export type PreflightCheck = "reachability" | "auth" | "context" | "allow-origin";

export interface PreflightProblem {
  readonly check: PreflightCheck;
  readonly job: string;
  /** One line, naming what is wrong and the fix. */
  readonly message: string;
  /** `allow-origin`: the exact origin to add to the environment's allow list. */
  readonly origin?: string;
}

export interface CampaignPreflight {
  readonly ok: boolean;
  readonly problems: readonly PreflightProblem[];
  /** `--skip-preflight`: nothing was checked. */
  readonly skipped?: true;
}

/** What the preflight needs of one campaign job. */
export interface PreflightJob {
  readonly id: string;
  readonly journey: string;
  /** The Journey's first page on the campaign's environment. */
  readonly startUrl: string;
  /** The origins the job's runs may reach (the environment's, else the Journey's site). */
  readonly allowlist: readonly string[];
  readonly storageState?: string;
  /** #746: the persona context the job's Journey declares (its linked persona's, else its `role`). */
  readonly declaredContext?: PersonaContext;
}

/**
 * #746: the campaign was refused because the host is starved (#205). Deliberately NOT
 * `E_CAMPAIGN_PREFLIGHT`: a starved host is an environment condition, not a misconfigured
 * campaign, and the operator acts on it differently (wait, or `--ignore-host-load`).
 */
export class CampaignHostStarvedError extends Error {
  readonly code = "E_HOST_STARVED" as const;
  constructor(message: string) {
    super(message);
    this.name = "CampaignHostStarvedError";
  }
}

/** The checks' seams: the connect probe and the signed-in check (both open no real network in tests). */
export interface CampaignPreflightDeps {
  /** A reason when `url` is definitely unreachable, else null (default: `probeOriginReadiness`, an HTTP readiness probe). */
  readonly probe?: (url: string) => Promise<string | null>;
  /** The signed-in verdict of `storageState` on `url` (default: `explore`'s #427 auto check in a browser). */
  readonly checkSession: (o: { readonly storageState: string; readonly url: string; readonly allowlist: readonly string[] }) => Promise<SessionCheck>;
  /** #746: the origin's readiness (default: `probeOriginReadiness`); only its class/status decide reachability. */
  readonly readiness?: (url: string) => Promise<OriginReadiness>;
  /** #746: the persona context declared for `storageState` (default: its project personas-file entry). */
  readonly personaContext?: (storageState: string) => PersonaContext | undefined;
  /** #746: the campaign-start host readiness; a reason means starved (default: `resourcePreflight`). */
  readonly hostReadiness?: () => Promise<string | null>;
}

/**
 * #746: an origin is unreachable only when DNS or the TCP connect failed, or HTTP answered a server
 * error (>= 500) or nothing at all. A 4xx (a 401/403 auth wall on the origin root) means the app is up.
 */
function readinessReason(r: OriginReadiness): string | null {
  if (r.class === "ready") return null;
  if (r.class === "http") return r.status !== undefined && r.status < 500 ? null : r.detail;
  return r.detail;
}

/** #746's default seams (the `#205` host check's `--ignore-host-load` override). */
export interface DefaultPreflightOptions {
  /** `--ignore-host-load`: start even on a starved host (`resourcePreflight`'s own override). */
  readonly ignoreHostLoad?: boolean;
}

/** #746: the first field where the session's context and the Journey's declared context disagree. */
function contextMismatch(declared: PersonaContext, session: PersonaContext): string | null {
  for (const field of ["organization", "role"] as const) {
    const d = declared[field];
    const s = session[field];
    if (d !== undefined && s !== undefined && d !== s) return `its ${field} ${JSON.stringify(s)} does not match the Journey's ${field} ${JSON.stringify(d)}`;
  }
  return null;
}

const SESSION_CHECK_TIMEOUT_MS = 30_000;

/** The default seams: an HTTP origin-readiness probe, the #427 browser check, the project personas-file context and the #205 host check (an expired session is reported, never re-minted — a campaign names no persona login). */
export function defaultPreflightDeps(
  portFactory: () => BrowserPort = () => new PlaywrightBrowserPort(),
  opts: DefaultPreflightOptions = {},
): CampaignPreflightDeps {
  return {
    // #746: an HTTP origin-readiness probe (dns/connect/http/ready); 4xx on the origin root still means up.
    readiness: (url) => probeOriginReadiness(url),
    checkSession: async (o) => {
      const r = await ensurePersonaSession({ ...o, check: { mode: "auto" }, port: portFactory(), env: {}, timeoutMs: SESSION_CHECK_TIMEOUT_MS });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, landedUrl: r.landedUrl ?? "" };
    },
    personaContext: (storageState) => projectPersonaFor(storageState)?.context,
    hostReadiness: async () => {
      const refusal = await resourcePreflight({ ...(opts.ignoreHostLoad === true ? { ignoreHostLoad: true } : {}) });
      return refusal === null ? null : (refusal.error?.message ?? "the host is starved");
    },
  };
}

/** A start URL whose path still holds a placeholder (`${setup.x}`, `{{param}}`) is checked at its origin's root. */
function checkableUrl(url: string): string {
  try {
    const u = new URL(url);
    return /\$\{|\{\{|%7B/i.test(u.pathname + u.search) ? `${u.origin}/` : u.href;
  } catch {
    return url;
  }
}

/**
 * Checks 1–3 for every job: each distinct start origin is probed once, each reachable job's session
 * checked once per (state file, start URL), and its session's declared persona context compared with
 * the Journey's. Returns every problem.
 */
export async function checkCampaignTargets(jobs: readonly PreflightJob[], deps: CampaignPreflightDeps): Promise<{ problems: PreflightProblem[] }> {
  const probe = deps.probe ?? (async (url: string) => readinessReason(await (deps.readiness ?? probeOriginReadiness)(url)));
  const problems: PreflightProblem[] = [];
  const probed = new Map<string, string | null>();
  const sessions = new Map<string, SessionCheck | Error>();
  for (const job of jobs) {
    const url = checkableUrl(job.startUrl);
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      // probed as given
    }
    // Guardrail #1: never probe (or open a browser on) an origin outside the job's own allow list.
    if (!normalizeAllowlist(job.allowlist).includes(origin)) {
      problems.push({
        check: "allow-origin",
        job: job.id,
        origin,
        message: `job ${job.id}: the start URL ${redactUrl(url)} is not on the job's allow list (${job.allowlist.join(", ")}) — not probed; add ${origin} to the environment's allow list or fix the Journey's site`,
      });
      continue;
    }
    if (!probed.has(origin)) probed.set(origin, await probe(url));
    const down = probed.get(origin) ?? null;
    if (down !== null) {
      problems.push({ check: "reachability", job: job.id, message: `job ${job.id}: the start URL ${redactUrl(url)} is not reachable: ${down}` });
      continue;
    }
    if (job.storageState === undefined) continue;
    const key = `${job.storageState}\n${url}`;
    if (!sessions.has(key)) {
      try {
        sessions.set(key, await deps.checkSession({ storageState: job.storageState, url, allowlist: job.allowlist }));
      } catch (err) {
        sessions.set(key, err instanceof Error ? err : new Error(String(err)));
      }
    }
    const verdict = sessions.get(key)!;
    if (verdict instanceof Error) {
      problems.push({ check: "auth", job: job.id, message: `job ${job.id}: the signed-in check of ${basename(job.storageState)} could not run: ${verdict.message.split("\n")[0]}` });
    } else if (!verdict.ok) {
      problems.push({
        check: "auth",
        job: job.id,
        message: `job ${job.id}: ${verdict.reason} — every mission would start signed out; re-save it with \`jevitate login\` (or point the job's storageState at a live session)`,
      });
    }
  }
  // #746: the declared-context check, after the sessions are known to be alive. Only the file's name
  // is ever reported, never its path or contents.
  for (const job of jobs) {
    if (job.storageState === undefined || job.declaredContext === undefined) continue;
    const session = deps.personaContext?.(job.storageState);
    if (session === undefined) continue;
    const mismatch = contextMismatch(job.declaredContext, session);
    if (mismatch !== null) {
      problems.push({
        check: "context",
        job: job.id,
        message: `job ${job.id}: the persona session in ${basename(job.storageState)} declares ${mismatch} — every mission would run as the wrong persona; re-save it with \`jevitate login\` for the Journey's persona (or point the job's storageState at that session)`,
      });
    }
  }
  return { problems };
}

/**
 * Check 3 for one job: the off-allow-list origins its discovery replay wrote to, through the #484
 * detector. Only a loopback slip is a problem (a third-party beacon is not the app's); each names
 * the exact origin to add.
 */
export function allowOriginProblems(job: PreflightJob, writeOrigins: readonly string[]): PreflightProblem[] {
  return findAllowOriginMismatches(writeOrigins, job.allowlist, { startUrl: job.startUrl }).map((m) => ({
    check: "allow-origin" as const,
    job: job.id,
    origin: m.blockedOrigin,
    message: `job ${job.id}: the discovery replay of journey '${job.journey}' wrote to ${m.blockedOrigin}, which the allow list (${job.allowlist.join(", ")}) does not include — every mission's write there would be blocked; add ${m.blockedOrigin} to the environment's allow list${m.allowedOrigin === undefined ? "" : ` (${m.allowedOrigin} and ${m.blockedOrigin} are different origins to the browser)`}`,
  }));
}

/** The preflight's verdict over every problem found. */
export function preflightOf(problems: readonly PreflightProblem[]): CampaignPreflight {
  return { ok: problems.length === 0, problems: [...problems] };
}

/** The campaign was refused by its preflight: every problem listed (exit 64, no mission ran). */
export class CampaignPreflightError extends Error {
  readonly code = "E_CAMPAIGN_PREFLIGHT" as const;
  constructor(
    readonly problems: readonly PreflightProblem[],
    readonly resultPath: string,
  ) {
    super(
      `campaign preflight failed (${problems.length} problem${problems.length === 1 ? "" : "s"}) — no mission ran:\n${problems.map((p) => `  - ${p.message}`).join("\n")}\n` +
        `(result: ${resultPath}; pass --skip-preflight to run anyway)`,
    );
    this.name = "CampaignPreflightError";
  }
}
