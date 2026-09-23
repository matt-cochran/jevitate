import type { GenerationPort, GenerationResult, GenInput, GenTaskKind } from "./generation.js";
import type { Answer, JudgmentPort, JudgmentState, Question } from "./judgment.js";

/**
 * Retries for TRANSIENT failures only (owner ruling 4): exponential backoff with jitter over the
 * schedule 100ms, 250ms, 500ms, 1s, 2s, 4s, 8s (≈16s in total), then a typed failure. A validation
 * or auth error is not transient and fails on the first attempt — retrying it would only delay
 * the same answer.
 *
 * The clock is injected (`sleep`, `random`) so tests are deterministic and never really wait.
 */

export const BACKOFF_SCHEDULE_MS: readonly number[] = [100, 250, 500, 1_000, 2_000, 4_000, 8_000];

export interface RetryDeps {
  /** Waits `ms` (default: a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A uniform [0,1) source for jitter (default `Math.random`). */
  readonly random?: () => number;
  /** The backoff schedule (default `BACKOFF_SCHEDULE_MS`). */
  readonly schedule?: readonly number[];
  /** Which errors are worth retrying (default `isTransientError`). */
  readonly isTransient?: (e: unknown) => boolean;
}

export type RetryResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly attempts: number;
      /** True when every attempt failed transiently (the schedule ran out). */
      readonly exhausted: boolean;
      /** The delays actually slept (ms), for observability. */
      readonly delays: number[];
    };

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TRANSIENT_MESSAGE =
  /\b(?:fetch failed|socket hang up|network error|rate.?limit(?:ed)?|too many requests|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|ECONNRESET|ETIMEDOUT)\b/i;
const NON_TRANSIENT_NAMES = new Set(["ZodError", "MissingCredentialError", "CredentialLeakError", "SecretLeakError"]);

function field(e: unknown, key: string): unknown {
  return e !== null && typeof e === "object" && key in e ? (e as Record<string, unknown>)[key] : undefined;
}

function statusOf(e: unknown): number | undefined {
  for (const candidate of [field(e, "status"), field(e, "statusCode"), field(field(e, "response"), "status")]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

/**
 * Transient ⇔ worth retrying: an HTTP 408/425/429/5xx, a network-level failure code, or a message
 * that names one. Validation errors, auth failures (401/403), bad requests and anything
 * unrecognised are NOT transient — they fail fast.
 */
export function isTransientError(e: unknown): boolean {
  const name = field(e, "name");
  if (typeof name === "string" && NON_TRANSIENT_NAMES.has(name)) return false;
  const status = statusOf(e) ?? statusOf(field(e, "cause"));
  if (status !== undefined) return TRANSIENT_STATUS.has(status);
  for (const code of [field(e, "code"), field(field(e, "cause"), "code")]) {
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  }
  const message = field(e, "message");
  return typeof message === "string" && TRANSIENT_MESSAGE.test(message);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ±20% jitter around the scheduled delay, so concurrent callers do not retry in lock-step. */
export function jittered(baseMs: number, random: () => number): number {
  return Math.round(baseMs * (0.8 + 0.4 * random()));
}

export async function retryTransient<T>(fn: () => Promise<T>, deps: RetryDeps = {}): Promise<RetryResult<T>> {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const schedule = deps.schedule ?? BACKOFF_SCHEDULE_MS;
  const transient = deps.isTransient ?? isTransientError;
  const delays: number[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await fn(), attempts: attempt };
    } catch (e) {
      const base = schedule[attempt - 1];
      if (!transient(e)) return { ok: false, error: e, attempts: attempt, exhausted: false, delays };
      if (base === undefined) return { ok: false, error: e, attempts: attempt, exhausted: true, delays };
      const delay = jittered(base, random);
      delays.push(delay);
      await sleep(delay);
    }
  }
}

/** A transient failure that outlasted the whole backoff schedule. */
export class RetryExhaustedError extends Error {
  readonly code = "E_RETRY_EXHAUSTED" as const;
  constructor(
    readonly operation: string,
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(
      `${operation} still failing after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError)
      }`,
    );
    this.name = "RetryExhaustedError";
  }
}

function unwrap<T>(operation: string, r: RetryResult<T>): T {
  if (r.ok) return r.value;
  // A non-transient error surfaces unchanged (fail fast); an exhausted one is typed.
  if (!r.exhausted) throw r.error;
  throw new RetryExhaustedError(operation, r.attempts, r.error);
}

/** Decorates a JudgmentPort with transient-only retries. */
export class RetryingJudgmentPort implements JudgmentPort {
  constructor(
    private readonly inner: JudgmentPort,
    private readonly deps: RetryDeps = {},
  ) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    return unwrap("judgment", await retryTransient(() => this.inner.systemOne(args), this.deps));
  }
}

/** Decorates a GenerationPort with transient-only retries. */
export class RetryingGenerationPort implements GenerationPort {
  constructor(
    private readonly inner: GenerationPort,
    private readonly deps: RetryDeps = {},
  ) {}
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    return unwrap(`generation (${kind})`, await retryTransient(() => this.inner.generate(kind, input), this.deps));
  }
}
