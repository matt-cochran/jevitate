import { normalizeAllowlist } from "./authorized-targets.js";

/**
 * #484: the `--allow` list names `http://localhost:<port>` but the app calls `http://127.0.0.1:<port>`
 * (or the reverse), or calls a loopback port `--allow` leaves out while the run itself is on loopback.
 * To the browser these are different origins, so the run's guard blocks every write to them — a
 * configuration slip, never an app defect. This detector says so; it never widens the allow list.
 *
 * Shared by the adversarial hunt (the first blocked write) and the campaign preflight (d485).
 */

export type AllowOriginMismatchKind =
  /** Same scheme and port as an allowed loopback origin, spelled `localhost` vs `127.0.0.1`/`[::1]`. */
  | "loopback-spelling"
  /** A loopback origin on a port no allowed origin has, while the start URL is loopback. */
  | "loopback-port";

export interface AllowOriginMismatch {
  readonly kind: AllowOriginMismatchKind;
  /** The origin the write went to (and was blocked). */
  readonly blockedOrigin: string;
  /** For `loopback-spelling`: the allowed origin it differs from only by host spelling. */
  readonly allowedOrigin?: string;
  /** A one-line, actionable warning naming the origin to add. */
  readonly message: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a URL host (as `URL.hostname` spells it) is a loopback name. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** The effective port (explicit, or the scheme's default). */
function portOf(u: URL): string {
  return u.port !== "" ? u.port : u.protocol === "https:" ? "443" : "80";
}

/**
 * The mismatch behind a blocked request to `blockedUrl` (a URL or an origin), or null when there is
 * none: the origin is not loopback, is itself allowed, or (port case) the start URL is not loopback.
 */
export function detectAllowOriginMismatch(
  blockedUrl: string,
  allowlist: readonly string[],
  opts: { readonly startUrl?: string } = {},
): AllowOriginMismatch | null {
  const blocked = parse(blockedUrl);
  if (blocked === null || !isLoopbackHost(blocked.hostname)) return null;
  const allowed = normalizeAllowlist(allowlist);
  if (allowed.includes(blocked.origin)) return null;
  for (const a of allowed) {
    const u = parse(a);
    if (u === null || !isLoopbackHost(u.hostname)) continue;
    if (u.protocol === blocked.protocol && portOf(u) === portOf(blocked) && u.hostname !== blocked.hostname) {
      return {
        kind: "loopback-spelling",
        blockedOrigin: blocked.origin,
        allowedOrigin: u.origin,
        message:
          `the app called ${blocked.origin} but --allow names ${u.origin} — localhost and 127.0.0.1 are different origins to the browser, ` +
          `so every write there is blocked and never sent; add ${blocked.origin} to --allow (or the environment's allow list)`,
      };
    }
  }
  const start = opts.startUrl === undefined ? null : parse(opts.startUrl);
  if (start === null || !isLoopbackHost(start.hostname)) return null;
  if (allowed.some((a) => {
    const u = parse(a);
    return u !== null && isLoopbackHost(u.hostname) && portOf(u) === portOf(blocked);
  })) return null;
  return {
    kind: "loopback-port",
    blockedOrigin: blocked.origin,
    message:
      `the app called ${blocked.origin}, a loopback port --allow does not include while the run starts on ${start.origin} — ` +
      `if it is the app's backend, add ${blocked.origin} to --allow (or the environment's allow list)`,
  };
}

/** Every distinct mismatch among `urls` (first-seen order) — one per blocked origin. */
export function findAllowOriginMismatches(
  urls: Iterable<string>,
  allowlist: readonly string[],
  opts: { readonly startUrl?: string } = {},
): AllowOriginMismatch[] {
  const out: AllowOriginMismatch[] = [];
  for (const url of urls) {
    const m = detectAllowOriginMismatch(url, allowlist, opts);
    if (m !== null && !out.some((o) => o.blockedOrigin === m.blockedOrigin)) out.push(m);
  }
  return out;
}
