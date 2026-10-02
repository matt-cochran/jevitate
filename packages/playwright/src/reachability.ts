import { connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { clock } from "@jevitate/domain";

/**
 * #213: a fast pre-flight "is anything listening at the target?" check before the first navigation.
 *
 * Chromium reports a refused connection as a bare 30s navigation timeout on some hosts (WSL drops the
 * SYN to a closed loopback port instead of resetting it), so an app that simply is not running took
 * ~35–40s and read "timed out before any response". A plain TCP connect answers in milliseconds for a
 * live server (the kernel accepts, however busy the app is), so it tells "nothing listening" apart
 * from "the app is slow" without waiting out the navigation timeout.
 *
 * Returns a plain-words reason when the target is definitely unreachable, else null (reachable, or a
 * non-http(s) URL we do not probe). Never throws.
 */
export interface ReachabilityDeps {
  readonly connect?: (port: number, host: string) => Socket;
  readonly lookup?: (host: string) => Promise<unknown>;
  /** Connect bound for a loopback host (default 3s): a local server accepts in milliseconds. */
  readonly loopbackTimeoutMs?: number;
  /** Connect bound for a remote host (default 10s). */
  readonly remoteTimeoutMs?: number;
}

/**
 * Chromium's restricted ("unsafe") ports: the browser refuses them itself, instantly, with
 * `net::ERR_UNSAFE_PORT` — a more accurate reason than any probe, so they are never probed.
 */
const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

export async function probeReachable(url: string, deps: ReachabilityDeps = {}): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (CHROMIUM_UNSAFE_PORTS.has(port)) return null;
  const where = `is the app running at ${u.origin}?`;
  const loopback = LOOPBACK.test(u.hostname);
  if (!loopback) {
    try {
      await (deps.lookup ?? ((h: string) => dnsLookup(h)))(host);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOTFOUND" || code === "EAI_NONAME" || code === "EAI_FAIL") return `host not found (${host}) — ${where}`;
      return null;
    }
  }
  const timeoutMs = loopback ? (deps.loopbackTimeoutMs ?? 3000) : (deps.remoteTimeoutMs ?? 10_000);
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const socket = (deps.connect ?? ((p: number, h: string) => netConnect(p, h)))(port, host);
    const done = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      socket.destroy();
      resolve(reason);
    };
    const timer = clock.setTimeout(
      () =>
        done(
          loopback
            ? `connection refused (nothing answered a connect within ${Math.round(timeoutMs / 1000)}s) — ${where}`
            : `no answer to a connect within ${Math.round(timeoutMs / 1000)}s — ${where}`,
        ),
      timeoutMs,
    );
    socket.once("connect", () => done(null));
    socket.once("error", (e: Error & { code?: string }) => {
      if (e.code === "ECONNREFUSED") return done(`connection refused — ${where}`);
      if (e.code === "ENOTFOUND" || e.code === "EAI_NONAME") return done(`host not found (${host}) — ${where}`);
      if (e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH") return done(`host unreachable (${host}) — ${where}`);
      done(null);
    });
  });
}
