/**
 * #543 — the CLI's `HttpProbe` for `http` end-state checks, and the refusals around them.
 *
 * One request per call: GET, `accept: application/json, *\/*;q=0.1` and nothing else — no cookies,
 * no auth header, no body (v1 sends no credentials). The URL's origin is re-checked against the
 * run's effective allowlist on EVERY call (after `${name}` substitution, so a bound value can never
 * widen it), a redirect is never followed (`redirect: "manual"`: the 3xx is the answer), and the body
 * is read through a stream capped at 1 MiB — past it the probe returns an error, never a partial body.
 * The body goes back to the judge only; it is never logged or persisted here.
 */
import { clock } from "@jevitate/domain";
import { SECRET_PARAM_NAME_RE } from "@jevitate/journey";
import { isAuthorizedExploreTarget, type HttpCheckRefResolver, type HttpProbe, type SuccessCheck } from "@jevitate/explore";
import { substituteSetupRefs, type FixtureBindings } from "./mission-fixtures.js";
import { parseSuccessSpec } from "./explore-specs.js";

/** #543 (Q4): the largest response body an `http` check reads. */
export const HTTP_CHECK_MAX_BODY_BYTES = 1024 * 1024;

/** #543: an `http` check names an origin outside the run's allowlist — refused before any browser opens. */
export class HttpCheckOffAllowlistError extends Error {
  readonly code = "E_HTTP_CHECK_OFF_ALLOWLIST" as const;
  constructor(message: string) {
    super(message);
    this.name = "HttpCheckOffAllowlistError";
  }
}

function templateOrigin(url: string): string | undefined {
  try {
    return new URL(url.replace(/\$\{[^}]*\}/g, "x")).origin;
  } catch {
    return undefined;
  }
}

/**
 * #543: refuses (`HttpCheckOffAllowlistError`, exit 64) when any `http` check's origin is not in
 * `allowlist` — the pre-launch half of the rule the probe enforces again on every request.
 */
export function assertHttpChecksAllowed(checks: readonly SuccessCheck[], allowlist: readonly string[], where = "--success"): void {
  for (const c of checks) {
    if (c.kind !== "http") continue;
    const origin = templateOrigin(c.url);
    if (origin === undefined || !isAuthorizedExploreTarget(origin, allowlist)) {
      throw new HttpCheckOffAllowlistError(
        `${where} http check reads ${origin ?? "an unparseable URL"}, which is not an authorized origin (allowed: ${allowlist.join(", ") || "<none>"}) — pass --allow ${origin ?? "<origin>"} to permit it; nothing was opened`,
      );
    }
  }
}

export interface HttpProbeOptions {
  /** The run's effective allowlist: every request's origin is re-checked against it. */
  readonly allowlist: readonly string[];
  /** Test seam: the fetch to use. Default: global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Body cap (bytes). Default `HTTP_CHECK_MAX_BODY_BYTES`. */
  readonly maxBodyBytes?: number;
}

function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0] ?? m;
}

async function readCapped(res: Response, max: number): Promise<{ text: string } | { error: string }> {
  const reader = res.body?.getReader();
  if (reader === undefined) return { text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { error: `response exceeds ${max === HTTP_CHECK_MAX_BODY_BYTES ? "1 MiB" : `${max} bytes`}` };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/** #543: the probe `http` checks make their requests with (see the module comment). */
export function createHttpProbe(opts: HttpProbeOptions): HttpProbe {
  const max = opts.maxBodyBytes ?? HTTP_CHECK_MAX_BODY_BYTES;
  return async (url, timeoutMs) => {
    if (!isAuthorizedExploreTarget(url, opts.allowlist)) {
      return { error: `${templateOrigin(url) ?? "the URL"} is not an authorized origin — refused, no request made` };
    }
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json, */*;q=0.1" },
        // Never follow a redirect: it could leave the allowlist. The 3xx is the answer.
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      const body = await readCapped(res, max);
      if ("error" in body) return body;
      return { status: res.status, bodyText: body.text };
    } catch (e) {
      return { error: controller.signal.aborted ? `timed out after ${timeoutMs} ms` : firstLine(e) };
    } finally {
      clock.clearTimeout(timer);
    }
  };
}

/**
 * #543: resolves an `http` check's `${name}`: `setup.x` from the fixture bindings, anything else
 * from the run's params. A secret (a secret param, a secret setup output) resolves with
 * `secret: true`, and the check refuses it.
 */
export function httpCheckRefs(input: {
  readonly params?: Readonly<Record<string, string>>;
  readonly secretParams?: ReadonlySet<string> | readonly string[];
  readonly bindings?: FixtureBindings;
}): HttpCheckRefResolver {
  const secretParams = new Set(input.secretParams ?? []);
  return (name) => {
    if (name.startsWith("setup.")) {
      const key = name.slice("setup.".length);
      const value = input.bindings?.values[key];
      return value === undefined ? undefined : { value, secret: input.bindings?.secretNames.has(key) === true };
    }
    const value = input.params?.[name];
    // #564: a credential-like name is a secret whether or not it was declared one.
    return value === undefined ? undefined : { value, secret: secretParams.has(name) || SECRET_PARAM_NAME_RE.test(name) };
  };
}

/**
 * #543: a `--success` spec under fixtures. Every kind but `http` is parsed with its `${setup.x}`
 * substituted (as before); an `http` check keeps its template — its placeholders are resolved (and a
 * secret refused) only when it is evaluated, so the value is never baked into a persisted check.
 */
export function parseSuccessSpecUnderSetup(spec: string, b: FixtureBindings, where: string): SuccessCheck {
  if (spec.startsWith("http:")) return parseSuccessSpec(spec);
  return parseSuccessSpec(substituteSetupRefs(spec, b, { where }));
}
