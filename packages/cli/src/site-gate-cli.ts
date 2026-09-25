import { existsSync } from "node:fs";
import { openDatabase, migrateToLatest, SqliteActivityRepository, SqliteBudgetRepository, SqliteSitePolicyRepository } from "@jevitate/storage-sqlite";
import { randomUUID } from "node:crypto";
import type { Recording } from "@jevitate/recording";
import type { Ability } from "@jevitate/screenplay";
import { SiteGateRefusedError, enterSiteGate, throttleClassOf, type SiteGateDeps } from "@jevitate/runtime";

/**
 * The site-policy gate's repositories (`jevitate site policy set`), opened from the policy database
 * for the duration of `fn`. No database file means no policy was ever set: `fn` gets `undefined`,
 * and nothing is created on disk.
 */
export async function withSiteGate<T>(dbPath: string | undefined, fn: (deps: SiteGateDeps | undefined) => Promise<T>): Promise<T> {
  if (dbPath === undefined || !existsSync(dbPath)) return fn(undefined);
  const db = openDatabase(dbPath);
  try {
    await migrateToLatest(db);
    const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() };
    return await fn({
      policies: new SqliteSitePolicyRepository(db, clock),
      budgets: new SqliteBudgetRepository(db),
      activity: new SqliteActivityRepository(db),
    });
  } finally {
    await db.destroy();
  }
}

/** A site policy's key: the origin of a URL (`https://app.example.com/login` → `https://app.example.com`); any other id as given. */
export function sitePolicyKey(site: string): string {
  try {
    const u = new URL(site);
    return u.origin === "null" ? site : u.origin;
  } catch {
    return site;
  }
}

/** What a gated Journey run gives its actor, and records once it has run. */
export interface JourneyGate {
  /** The pacing ability (none when no policy declares pacing), spread into `whoCan(...)`. */
  readonly abilities: Ability[];
  /** Records the run against the site's throttle class; call once the run executed, pass or fail. */
  readonly done: () => Promise<void>;
}

const UNGATED: JourneyGate = { abilities: [], done: async () => undefined };

/**
 * The site-policy gate for one Journey run on `recording.site`'s origin — before any fixture or
 * browser. Throws `SiteGateRefusedError` (quiet hours, min interval, budget) with when to retry.
 * `enforceLimits: false` (a load run) applies only the pacing.
 */
export async function gateJourney(
  siteGate: SiteGateDeps | undefined,
  recording: Recording,
  opts: { readonly account?: string; readonly enforceLimits: boolean; readonly runId?: string },
): Promise<JourneyGate> {
  if (siteGate === undefined) return UNGATED;
  const site = sitePolicyKey(recording.site);
  const gate = await enterSiteGate(siteGate, {
    site,
    account: opts.account ?? "primary",
    throttleClass: throttleClassOf(recording),
    runId: opts.runId ?? randomUUID(),
    enforceLimits: opts.enforceLimits,
  });
  if (!gate.ok) throw new SiteGateRefusedError(site, gate.reason, gate.retryAfter);
  return { abilities: gate.pace === null ? [] : [gate.pace], done: gate.done };
}
