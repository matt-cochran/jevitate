/**
 * Per-target settle and hang configuration (owner rulings 3/4/7 follow-up) — the knobs a target
 * gives jevitate so long-lived and live-updating apps are not mistaken for hung ones.
 *
 *  - `settle.ignoreRequests`: URL patterns of requests the target marks as BACKGROUND (a poller, a
 *    heartbeat, a long-poll): they never count as in-flight work for the settle rule.
 *  - `settle.longPollMs`: long-poll auto-detection — a request pending longer than this WHILE the
 *    page is otherwise interactive (a control is rendered and no busy indicator shows) is treated as
 *    a long-lived connection. A request pending that long on a page that is NOT interactive still
 *    counts: that is what a stuck page looks like.
 *  - `hangs.ignoreNoProgress`: patterns (matched against the route, the action label, or the busy
 *    indicator) for which `ui-no-progress` is never reported (a UI that legitimately returns to an
 *    earlier state, a spinner that is decorative).
 *
 * Patterns: `*` matches any run of characters; a pattern containing `://` is matched against the
 * full URL, any other pattern against the path (+ query). Matching is anchored (whole string).
 */

export interface SettleConfig {
  readonly ignoreRequests?: readonly string[];
  readonly longPollMs?: number;
}

export interface HangConfig {
  readonly ignoreNoProgress?: readonly string[];
}

/** Default long-poll threshold (ms): below the 15s ceiling, so a long-poll never reads as a hang. */
export const DEFAULT_LONG_POLL_MS = 5_000;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Compiles URL patterns into one predicate. An empty list matches nothing. */
export function urlMatcher(patterns: readonly string[] | undefined): (url: string) => boolean {
  const compiled = (patterns ?? []).map((p) => ({ full: p.includes("://"), re: globToRegExp(p) }));
  if (compiled.length === 0) return () => false;
  return (url: string): boolean => {
    let pathAndQuery = url;
    try {
      const u = new URL(url);
      pathAndQuery = `${u.pathname}${u.search}`;
    } catch {
      // not absolute: match as given
    }
    return compiled.some((c) => c.re.test(c.full ? url : pathAndQuery));
  };
}

/** Compiles plain-text patterns (route, action label, indicator) into one predicate. */
export function textMatcher(patterns: readonly string[] | undefined): (text: string) => boolean {
  const compiled = (patterns ?? []).map(globToRegExp);
  return (text: string): boolean => compiled.some((re) => re.test(text));
}

/**
 * Per-target timing configuration: `apiPrefixes` are path prefixes whose requests are always the
 * app's API (e.g. `/api/`, `/graphql`), whatever their content type — the timing summary ranks API
 * endpoints separately from documents and static/dev-server assets.
 */
export interface TimingConfig {
  readonly apiPrefixes?: readonly string[];
}
