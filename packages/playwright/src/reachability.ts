import { connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
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
  /**
   * #742: one HTTP GET for the origin-readiness check, or why there is none (a refusal, a transport
   * error, a timeout). Default: node `http`/`https` GET, no redirect followed, bounded by the same
   * loopback/remote timeout as the connect. Never throws.
   */
  readonly httpRequest?: (url: string, timeoutMs: number) => Promise<{ status: number } | { error: string }>;
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

/** A parsed, probeable http(s) target (null for anything else — a non-URL, a non-http(s), an unsafe port). */
interface ProbeTarget {
  readonly host: string;
  readonly port: number;
  /** The origin root (`http(s)://host:port/`) the readiness GET targets. */
  readonly origin: string;
  readonly loopback: boolean;
  readonly timeoutMs: number;
  readonly where: string;
}

function probeTarget(url: string, deps: ReachabilityDeps): ProbeTarget | null {
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
  const loopback = LOOPBACK.test(u.hostname);
  const timeoutMs = loopback ? (deps.loopbackTimeoutMs ?? 3000) : (deps.remoteTimeoutMs ?? 10_000);
  return { host, port, origin: `${u.origin}/`, loopback, timeoutMs, where: `is the app running at ${u.origin}?` };
}

/** Why the DNS/connect layer did not reach the target, or `reachable` when it did (or could not tell). */
type TransportResult =
  | { readonly kind: "reachable" }
  | { readonly kind: "dns"; readonly detail: string }
  | { readonly kind: "connect"; readonly detail: string };

async function probeTransport(t: ProbeTarget, deps: ReachabilityDeps): Promise<TransportResult> {
  if (!t.loopback) {
    try {
      await (deps.lookup ?? ((h: string) => dnsLookup(h)))(t.host);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOTFOUND" || code === "EAI_NONAME" || code === "EAI_FAIL") return { kind: "dns", detail: `host not found (${t.host}) — ${t.where}` };
      return { kind: "reachable" };
    }
  }
  const detail = await new Promise<string | null>((resolve) => {
    let settled = false;
    const socket = (deps.connect ?? ((p: number, h: string) => netConnect(p, h)))(t.port, t.host);
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
          t.loopback
            ? `connection refused (nothing answered a connect within ${Math.round(t.timeoutMs / 1000)}s) — ${t.where}`
            : `no answer to a connect within ${Math.round(t.timeoutMs / 1000)}s — ${t.where}`,
        ),
      t.timeoutMs,
    );
    socket.once("connect", () => done(null));
    socket.once("error", (e: Error & { code?: string }) => {
      if (e.code === "ECONNREFUSED") return done(`connection refused — ${t.where}`);
      if (e.code === "ENOTFOUND" || e.code === "EAI_NONAME") return done(`host not found (${t.host}) — ${t.where}`);
      if (e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH") return done(`host unreachable (${t.host}) — ${t.where}`);
      done(null);
    });
  });
  return detail === null ? { kind: "reachable" } : { kind: "connect", detail };
}

export async function probeReachable(url: string, deps: ReachabilityDeps = {}): Promise<string | null> {
  const t = probeTarget(url, deps);
  if (t === null) return null;
  const transport = await probeTransport(t, deps);
  return transport.kind === "reachable" ? null : transport.detail;
}

/** #742: which layer an origin-readiness probe stopped at. */
export type ReachabilityClass = "dns" | "connect" | "http" | "ready";

/**
 * #742: an HTTP origin-readiness result, reusable by sweeps and campaign preflight — a sweep that
 * only knows "not reachable" cannot tell a missing DNS entry from an app that answers 503.
 *
 *  - `dns`     — the host did not resolve;
 *  - `connect` — the host resolved but nothing accepted the TCP connect (refused, unreachable, timed out);
 *  - `http`    — the origin accepted the connect but answered a non-ready status (>= 400) or no HTTP
 *                response at all; `status` is the answered code when there was one;
 *  - `ready`   — the origin accepted the connect and answered a ready status (2xx/3xx); `status` is
 *                that code.
 */
export interface OriginReadiness {
  readonly class: ReachabilityClass;
  /** The answered HTTP status when one was received (`http` and `ready`). */
  readonly status?: number;
  /** Plain words: what was probed and what happened. */
  readonly detail: string;
}

const READY_STATUS = (status: number): boolean => status >= 200 && status < 400;

function defaultHttpRequest(url: string, timeoutMs: number): Promise<{ status: number } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const get = new URL(url).protocol === "https:" ? httpsGet : httpGet;
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    const done = (result: { status: number } | { error: string }): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(result);
    };
    const req = get(url, { method: "GET", headers: { accept: "*/*" } }, (res) => {
      res.resume();
      done({ status: res.statusCode ?? 0 });
    });
    timer = clock.setTimeout(() => {
      req.destroy();
      done({ error: `no response within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    req.once("error", (e: Error) => done({ error: e.message.split("\n")[0] ?? e.message }));
  });
}

/**
 * #742: probes an http(s) origin end to end — resolve, connect, then one HTTP GET — and classifies
 * where readiness stopped. The result is always returned, never thrown. A non-http(s) URL, an
 * unparseable URL or a Chromium-unsafe port is `ready` (nothing is known to be wrong; the browser
 * reports its own, more accurate error).
 */
export async function probeOriginReadiness(url: string, deps: ReachabilityDeps = {}): Promise<OriginReadiness> {
  const t = probeTarget(url, deps);
  if (t === null) return { class: "ready", detail: `${url} is not an http(s) origin — not probed` };
  const transport = await probeTransport(t, deps);
  if (transport.kind !== "reachable") return { class: transport.kind, detail: transport.detail };
  const res = await (deps.httpRequest ?? defaultHttpRequest)(t.origin, t.timeoutMs);
  if ("error" in res) return { class: "http", detail: `no HTTP response (${res.error}) — ${t.where}` };
  return READY_STATUS(res.status)
    ? { class: "ready", status: res.status, detail: `origin answered HTTP ${res.status} — ${t.where}` }
    : { class: "http", status: res.status, detail: `origin answered HTTP ${res.status} (not ready) — ${t.where}` };
}
