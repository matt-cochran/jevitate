import { basename } from "node:path";
import { redactUrl } from "@jevitate/ai-core";
import { findAllowOriginMismatches } from "@jevitate/explore";
import { PlaywrightBrowserPort, probeReachable, type BrowserPort } from "@jevitate/playwright";
import { ensurePersonaSession, type SessionCheck } from "./persona-login.js";

/**
 * #485 — `campaign run`'s preflight: the campaign's own preconditions, checked before ANY anchored
 * mission starts, so a misconfiguration costs one refusal instead of a whole campaign:
 *
 *  1. reachability — each job's start URL answers a connect (no environment declares a health check);
 *  2. auth — each job's `storageState` is still signed in: the Journey's start page does not land on
 *     a sign-in route or form (the same code check as `explore`'s #427 pre-flight). The storage
 *     state's contents are never read into a message — only its file name;
 *  3. allow list — the discovery replay of each job's Journey sent no write to a loopback origin the
 *     environment's allow list misspells (`localhost` vs `127.0.0.1`) or leaves out (#484 detector):
 *     every mission's write there would be blocked. The problem names the exact origin to add.
 *
 * Every problem is collected (never just the first); the campaign refuses with all of them (exit 64).
 */

export type PreflightCheck = "reachability" | "auth" | "allow-origin";

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
}

/** The checks' seams: the connect probe and the signed-in check (both open no real network in tests). */
export interface CampaignPreflightDeps {
  /** A reason when `url` is definitely unreachable, else null (default: `probeReachable`, a TCP connect). */
  readonly probe?: (url: string) => Promise<string | null>;
  /** The signed-in verdict of `storageState` on `url` (default: `explore`'s #427 auto check in a browser). */
  readonly checkSession: (o: { readonly storageState: string; readonly url: string; readonly allowlist: readonly string[] }) => Promise<SessionCheck>;
}

const SESSION_CHECK_TIMEOUT_MS = 30_000;

/** The default seams: a TCP probe and the #427 browser check (an expired session is reported, never re-minted — a campaign names no persona login). */
export function defaultPreflightDeps(portFactory: () => BrowserPort = () => new PlaywrightBrowserPort()): CampaignPreflightDeps {
  return {
    probe: (url) => probeReachable(url),
    checkSession: async (o) => {
      const r = await ensurePersonaSession({ ...o, check: { mode: "auto" }, port: portFactory(), env: {}, timeoutMs: SESSION_CHECK_TIMEOUT_MS });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, landedUrl: r.landedUrl ?? "" };
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
 * Checks 1 and 2 for every job: each distinct start origin is probed once, each reachable job's
 * session checked once per (state file, start URL). Returns every problem.
 */
export async function checkCampaignTargets(jobs: readonly PreflightJob[], deps: CampaignPreflightDeps): Promise<{ problems: PreflightProblem[] }> {
  const probe = deps.probe ?? ((url: string) => probeReachable(url));
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
