/**
 * #543 — the `http` end-state check's pure judge and poll loop. A write whose durable effect is off
 * the app's UI (a password reset's email in a dev outbox) is proved by a GET to an allow-listed
 * origin whose response must satisfy every assertion.
 *
 * This package never makes the request itself: the caller injects an `HttpProbe` (the CLI's builds
 * it over fetch, re-checks the allowlist, never follows a redirect, caps the body). Without a probe
 * the check fails closed as unevaluable. The response body is never persisted: what a result quotes
 * is bounded (200 chars) and redacted of the run's secrets.
 */
import { clock } from "@jevitate/domain";
import {
  DEFAULT_HTTP_CHECK_WITHIN_MS,
  NavigateUrlParamError,
  describeNavigateUrl,
  navigateUrlParams,
  resolveNavigateUrl,
  selectJsonValues,
  type HttpCheck,
  type StatusSpec,
} from "@jevitate/recording";
import { redactText } from "./redact.js";

/** What one probe returned: the response's status and (capped) body text, or why there is none. */
export type HttpProbeResult = { readonly status: number; readonly bodyText: string } | { readonly error: string };

/**
 * #543: makes ONE request for an `http` check (GET, no credentials, no redirect followed) and
 * returns its status and body text, or `{ error }` (a refusal, a transport error, a timeout, an
 * over-cap body). Never throws for those.
 */
export type HttpProbe = (url: string, timeoutMs: number) => Promise<HttpProbeResult>;

/** #543: a `${name}` the check refers to: its value, and whether it is a secret (refused). */
export interface HttpCheckRef {
  readonly value: string;
  readonly secret: boolean;
}

/** #543: resolves a placeholder name (a Journey param, `setup.x`) to its value; `undefined` when unbound. */
export type HttpCheckRefResolver = (name: string) => HttpCheckRef | undefined;

/** The code an `http` check's secret placeholder is refused with. */
export const E_HTTP_CHECK_SECRET_REF = "E_HTTP_CHECK_SECRET_REF";

/** Bound on the text a result quotes from a response (selected values, the body head). */
const QUOTE_MAX_CHARS = 200;
/** Interval between attempts while polling (ms). */
export const HTTP_CHECK_POLL_MS = 500;
/** Per-request timeout ceiling (ms). */
export const HTTP_CHECK_REQUEST_TIMEOUT_MS = 5_000;

/** One judged response: passed, and what was seen (never the whole body). */
export interface HttpJudgement {
  readonly passed: boolean;
  readonly detail: string;
}

function statusMatches(status: number, spec: StatusSpec): boolean {
  return "class" in spec ? Math.floor(status / 100) === spec.class : status === spec.code;
}

function describeStatus(s: StatusSpec): string {
  return "class" in s ? `${s.class}xx` : String(s.code);
}

function quote(text: string, secrets: readonly string[]): string {
  // Redacted BEFORE the cut, so a secret straddling the bound is never half-quoted.
  const flat = redactText(text, secrets).replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS)}…` : flat);
}

function scalarText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function holds(op: "equals" | "includes" | "exists", value: string | undefined, selected: unknown): boolean {
  switch (op) {
    case "exists":
      return selected !== undefined && selected !== null;
    case "equals":
      return scalarText(selected) === value;
    case "includes":
      if (typeof selected === "string") return value !== undefined && selected.includes(value);
      if (Array.isArray(selected)) return selected.some((x) => scalarText(x) === value);
      return false;
  }
}

/**
 * #543: judges one response against the check (pure). `status` (default 2xx; a 3xx is the answer —
 * a redirect is never followed) is judged first, then every `json` assertion (ANY selected value
 * satisfies it), then every `textIncludes` over the raw body. The first failure is the detail.
 */
export function judgeHttpResponse(
  check: HttpCheck,
  response: { readonly status: number; readonly bodyText: string },
  secrets: readonly string[] = [],
): HttpJudgement {
  const status = check.status ?? { class: 2 as const };
  if (!statusMatches(response.status, status)) {
    const redirect = response.status >= 300 && response.status < 400 ? " (a redirect is never followed)" : "";
    return { passed: false, detail: `expected status ${describeStatus(status)}, got ${response.status}${redirect}` };
  }
  if (check.json !== undefined) {
    let doc: unknown;
    try {
      doc = JSON.parse(response.bodyText);
    } catch {
      return { passed: false, detail: "response is not JSON" };
    }
    for (const a of check.json) {
      const selected = selectJsonValues(doc, a.path);
      if (selected.some((v) => holds(a.op, a.value, v))) continue;
      const what = a.op === "exists" ? `${a.path} exists` : `${a.path} ${a.op} ${JSON.stringify(a.value)}`;
      return {
        passed: false,
        detail: selected.length === 0 ? `${what}: the path selected nothing` : `${what}: selected ${quote(JSON.stringify(selected), secrets)}`,
      };
    }
  }
  for (const t of check.textIncludes ?? []) {
    if (!response.bodyText.includes(t)) return { passed: false, detail: `body does not include ${JSON.stringify(t)} (body starts ${quote(response.bodyText, secrets)})` };
  }
  return { passed: true, detail: `status ${response.status}` };
}

/** #543: an `http` check's verdict — `unevaluable` when no response could be judged at all. */
export interface HttpCheckVerdict {
  readonly passed: boolean;
  readonly detail: string;
  readonly unevaluable?: true;
}

export interface EvaluateHttpCheckOptions {
  readonly probe?: HttpProbe;
  readonly resolveRef?: HttpCheckRefResolver;
  /** Registered secrets: the detail is redacted of them. */
  readonly secrets?: readonly string[];
  /** `true`: one attempt, no polling (the goal mission's pre-action vacuity probe). */
  readonly once?: boolean;
}

class HttpCheckRefError extends Error {}

const PLACEHOLDER = /\$\{([^}]*)\}/g;

/** The check with every `${name}` resolved: the URL strictly encoded (origin kept), values verbatim. */
export function resolveHttpCheck(check: HttpCheck, resolveRef: HttpCheckRefResolver | undefined): HttpCheck {
  const lookup = (name: string): string => {
    const ref = resolveRef?.(name);
    if (ref === undefined) throw new HttpCheckRefError(`\${${name}} is not bound in this run`);
    if (ref.secret) throw new HttpCheckRefError(`${E_HTTP_CHECK_SECRET_REF}: \${${name}} is a secret — an http check's URL and details are model-visible and persisted, so it may not use one`);
    return ref.value;
  };
  const sub = (text: string): string => text.replace(PLACEHOLDER, (_m, name: string) => lookup(name));
  const vars = new Map(navigateUrlParams(check.url).map((n) => [n, lookup(n)] as const));
  const url = resolveNavigateUrl(check.url, vars);
  return {
    ...check,
    url,
    ...(check.json === undefined ? {} : { json: check.json.map((a) => (a.value === undefined ? a : { ...a, value: sub(a.value) })) }),
    ...(check.textIncludes === undefined ? {} : { textIncludes: check.textIncludes.map(sub) }),
  };
}

/**
 * #543: evaluates an `http` check — resolves its placeholders, then probes every
 * `HTTP_CHECK_POLL_MS` (on the installed clock) until one response satisfies everything or
 * `withinMs` passes. Fails closed: no probe, an unbound or secret placeholder, or a refusal is
 * `unevaluable`; so is a window in which no request ever got a response (transport errors only).
 */
export async function evaluateHttpCheck(check: HttpCheck, opts: EvaluateHttpCheckOptions): Promise<HttpCheckVerdict> {
  const secrets = opts.secrets ?? [];
  const shownUrl = describeNavigateUrl(check.url);
  const unevaluable = (why: string): HttpCheckVerdict => ({ passed: false, unevaluable: true, detail: `unevaluable: ${redactText(why, secrets)}` });
  if (opts.probe === undefined) return unevaluable("this context cannot make HTTP checks");
  let resolved: HttpCheck;
  try {
    resolved = resolveHttpCheck(check, opts.resolveRef);
  } catch (e) {
    if (e instanceof HttpCheckRefError || e instanceof NavigateUrlParamError) return unevaluable(`GET ${shownUrl}: ${e.message}`);
    return unevaluable(`GET ${shownUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const windowMs = opts.once === true ? 0 : (check.withinMs ?? DEFAULT_HTTP_CHECK_WITHIN_MS);
  const start = clock.now();
  let attempts = 0;
  let lastJudged: HttpJudgement | undefined;
  let lastError: string | undefined;
  for (;;) {
    attempts += 1;
    const remaining = Math.max(1, windowMs - (clock.now() - start));
    const res = await opts.probe(resolved.url, Math.min(HTTP_CHECK_REQUEST_TIMEOUT_MS, opts.once === true ? HTTP_CHECK_REQUEST_TIMEOUT_MS : remaining));
    if ("error" in res) {
      lastError = res.error;
    } else {
      lastJudged = judgeHttpResponse(resolved, res, secrets);
      if (lastJudged.passed) {
        return { passed: true, detail: redactText(`GET ${shownUrl}: held (${lastJudged.detail}, attempt ${attempts})`, secrets) };
      }
    }
    const elapsed = clock.now() - start;
    if (elapsed >= windowMs) break;
    await clock.sleep(Math.min(HTTP_CHECK_POLL_MS, windowMs - elapsed));
  }
  if (lastJudged === undefined) return unevaluable(`GET ${shownUrl}: ${lastError ?? "no response"} (${attempts} attempt${attempts === 1 ? "" : "s"})`);
  const within = opts.once === true ? "" : ` within ${windowMs} ms`;
  return { passed: false, detail: redactText(`GET ${shownUrl}: did not hold${within} (${attempts} attempt${attempts === 1 ? "" : "s"}): ${lastJudged.detail}`, secrets) };
}
