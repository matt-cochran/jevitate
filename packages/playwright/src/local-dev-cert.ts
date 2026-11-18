/**
 * #872: accept a local dev server's self-signed certificate — and only that one.
 *
 * Chromium's `--ignore-certificate-errors-spki-list` ignores certificate errors only for a chain
 * that carries one of the listed public keys (SHA-256 SPKI pins). Pinning the key a loopback dev
 * server presents at launch accepts exactly that server: every other host, a third-party script
 * the page loads included, is validated as usual. This is narrower than Playwright's
 * `ignoreHTTPSErrors`, which turns validation off for the whole context.
 *
 * Origins are restricted to `https` on loopback hosts (`localhost`, `127.0.0.0/8`, `[::1]`):
 * anything else is refused when the flag is parsed, before a browser starts.
 */
import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { connect } from "node:tls";

/** A local dev certificate could not be accepted: the origin is invalid or its server unreadable. */
export class LocalDevCertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDevCertError";
  }
}

/** True for `localhost`, any `127.0.0.0/8` address and `::1` (URL hostnames keep IPv6 brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (h === "[::1]" || h === "::1") return true;
  return isIPv4(h) && h.startsWith("127.");
}

/**
 * Parses an `--accept-local-dev-cert` value into its origin. Throws a `LocalDevCertError` (a
 * usage error at the CLI) for anything that is not an `https` origin on a loopback host.
 */
export function parseLocalDevCertOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalDevCertError(`not a URL origin: ${JSON.stringify(value)} (expected e.g. https://localhost:5173)`);
  }
  if (url.protocol !== "https:") {
    throw new LocalDevCertError(`${url.origin} is not https: a local dev certificate is accepted only for an https origin`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new LocalDevCertError(
      `${url.origin} is not a loopback host: a local dev certificate is accepted only for localhost, 127.0.0.0/8 or [::1]`,
    );
  }
  return url.origin;
}

/** Reads the SHA-256 SPKI pin (base64) of the certificate the server at `origin` presents. */
export function spkiPinOf(origin: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? 443 : Number(url.port);
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise<string>((resolve, reject) => {
    const fail = (why: string): void => reject(new LocalDevCertError(`could not read the certificate of ${origin}: ${why}`));
    // SNI takes a host name, never an IP address.
    const socket = connect({ host, port, rejectUnauthorized: false, ...(isIPv4(host) || host === "::1" ? {} : { servername: host }) }, () => {
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (cert === undefined) return fail("the server presented no certificate");
      resolve(createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64"));
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      fail(`no TLS handshake within ${timeoutMs}ms`);
    });
    socket.on("error", (err) => fail(err.message));
  });
}

/**
 * The Chromium switch pinning each origin's key, or `[]` for no origins. `pinOf` defaults to
 * `spkiPinOf` (a live TLS handshake); tests inject their own.
 */
export async function localDevCertLaunchArgs(
  origins: readonly string[],
  pinOf: (origin: string) => Promise<string> = (o) => spkiPinOf(o),
): Promise<string[]> {
  if (origins.length === 0) return [];
  const pins: string[] = [];
  for (const origin of origins) {
    const pin = await pinOf(origin);
    if (!pins.includes(pin)) pins.push(pin);
  }
  return [`--ignore-certificate-errors-spki-list=${pins.join(",")}`];
}
