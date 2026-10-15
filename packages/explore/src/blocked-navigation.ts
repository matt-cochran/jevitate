/**
 * #521 option A: reading the opt-in navigation guard (`OpenOptions.blockOffAllowlistNavigation`) from
 * a mission. The guard answers an off-allowlist navigation `204`, so the page stays where it was and
 * the post-settle URL check sees nothing: every mission loop drains the session's record after each
 * settle and treats a MAIN-frame block as a departure, exactly like a settled off-scope URL. A
 * subframe block (an embedded off-allowlist iframe) is advisory only — never a departure.
 *
 * A session opened without the option drains `[]`, so every caller is a no-op there.
 */

import { BrowseTheWebToken, tryAbility, type Actor } from "@jevitate/screenplay";
import { redactUrl } from "@jevitate/ai-core";
import { seedRedirectReason, type SeedRedirect } from "./seed-redirect.js";

/** Blocks already drained from a session by a peek, kept for its next drain. */
const peeked = new WeakMap<object, string[]>();

/** The page-level (main-frame) navigations the guard stopped since the last drain, oldest first. */
export function drainBlockedDepartures(actor: Actor): readonly string[] {
  // An actor with no browser has no guard to drain.
  const session = tryAbility(actor, BrowseTheWebToken)?.session;
  if (session === undefined) return [];
  const kept = peeked.get(session) ?? [];
  peeked.delete(session);
  return [...kept, ...(session.drainBlockedNavigations?.() ?? []).filter((b) => b.frame === "main").map((b) => b.url)];
}

/**
 * The last main-frame block so far WITHOUT consuming it (the next drain still returns it). A seed
 * load cut short by a blocked script redirect fails with `net::ERR_ABORTED`: the seed loaders peek
 * here so that is never reported as "target unreachable" — the departure is judged after the settle.
 */
export function peekBlockedDeparture(actor: Actor): string | undefined {
  const all = drainBlockedDepartures(actor);
  const session = tryAbility(actor, BrowseTheWebToken)?.session;
  if (session !== undefined && all.length > 0) peeked.set(session, [...all]);
  return all.at(-1);
}

/** The last main-frame block since the last drain (the departure to report), or undefined. */
export function drainBlockedDeparture(actor: Actor): string | undefined {
  return drainBlockedDepartures(actor).at(-1);
}

/** The transcript wording of a blocked departure (the URL already has no query or fragment). */
export function blockedDepartureReason(url: string): string {
  return `navigation to ${redactUrl(url)} blocked: off the allowlist (--block-off-allowlist-navigation)`;
}

/**
 * #82 under the guard: the seed's own departure. A seed that redirects by script (to a login IdP,
 * most often) is stopped in place, so its landed URL is the seed; the blocked target is then where it
 * "landed" — the same login-like reason as without the guard, never a silent pass. A block whose path
 * equals the seed's (another origin, same path) still fails closed with a plain redirect reason.
 */
export function seedLandingReason(seedUrl: string, landedUrl: string, blocked: string | undefined): SeedRedirect | null {
  if (blocked === undefined) return seedRedirectReason(seedUrl, landedUrl);
  return seedRedirectReason(seedUrl, blocked) ?? { reason: `seed ${redactUrl(seedUrl)} navigated to ${redactUrl(blocked)} (blocked: off the allowlist)`, loginLike: false };
}
