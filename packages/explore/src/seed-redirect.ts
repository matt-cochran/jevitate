/**
 * Detects a redirected seed (#82): the mission's first settled page landed on a different PATH than
 * the seed URL it was asked to test — most commonly a lost/expired `--storage-state` session bounced
 * to a login page. Shared by every mission (coverage, exploratory, adversarial, feature) so a lost
 * session is caught the same way everywhere, instead of silently exploring the logged-out app as if
 * it were the one asked for.
 *
 * A login-like landed path gets the explicit "session is not authenticated" hypothesis — the actual
 * symptom this was written for. Any OTHER different-path landing still fails closed (the run cannot
 * test what it was asked to) without guessing why.
 */
const LOGIN_LIKE_PATH = /(?:^|\/)(?:log[-]?in|sign[-]?in|sign[-]?up|auth|authenticate|sso)(?:\/|$)/i;

export interface SeedRedirect {
  /** Why to report `inconclusive`, ready to use as a `MissionFailure.message` / transcript reason. */
  readonly reason: string;
  /** True when the landed path matched the login-like pattern (the #82 symptom this exists for) —
   *  lets a caller with its OWN generic "left scope" detection (adversarial's route-glob check)
   *  prefer this more specific/actionable reason only for the case it was written for, and keep its
   *  existing generic message for every other kind of departure. */
  readonly loginLike: boolean;
}

/**
 * Returns the redirect to report `inconclusive` with, or null when the landed page's path matches
 * the seed's (the mission is testing what it was asked to). Malformed URLs never throw — treated as
 * "no redirect detected" (fail open on THIS check only; other guards handle an unparsable URL).
 */
export function seedRedirectReason(seedUrl: string, landedUrl: string): SeedRedirect | null {
  let seedPath: string;
  let landedPath: string;
  try {
    seedPath = new URL(seedUrl).pathname;
    landedPath = new URL(landedUrl).pathname;
  } catch {
    return null;
  }
  if (seedPath === landedPath) return null;
  const loginLike = LOGIN_LIKE_PATH.test(landedPath);
  const reason = loginLike
    ? `seed ${seedPath} redirected to ${landedPath} — the --storage-state session is not authenticated`
    : `seed ${seedPath} redirected to ${landedPath}`;
  return { reason, loginLike };
}

/**
 * True when `url`'s path looks like a login/sign-in/sign-up page (#159) — reuses the exact pattern
 * `seedRedirectReason` uses to name the #82 symptom. Used by the `--save-storage-state` snapshotter
 * (`packages/cli/src/storage-state-snapshot.ts`) to decide whether the CURRENT page is a safe moment
 * to refresh the in-memory "last known-good" storageState snapshot: a run that has (even temporarily)
 * bounced to a login-like page is not one whose session is worth persisting over a previous good one.
 * Malformed URLs are treated as "not login-like" (fail open), consistent with `seedRedirectReason`.
 */
export function isLoginLikeUrl(url: string): boolean {
  try {
    return LOGIN_LIKE_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
