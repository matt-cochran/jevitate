import type { Answer, Question } from "./judgment.js";
import type { JevClientCall } from "./jev.js";
import type { JevProvider } from "./credentials.js";
import { failureClass, type UsageSink } from "./usage.js";

/**
 * The Jev SDK adapter — lives next to `JevJudgmentGateway` (they change together): pure
 * translation between jevitate's judgment questions/answers and the `@typesafe-ai/sdk` (v0.6)
 * `systemOne` wire shapes, plus the live seam (`realJevClientCall`) that lazily imports the SDK,
 * constructs `TypeSafeClient` and calls `systemOne` around the two pure functions. The SDK is
 * imported ONLY dynamically with a non-literal specifier, so this package builds (and its pure
 * translation is unit-tested) without the SDK's types; hosts (the CLI) just wire the seam.
 *
 * #429: the same seam serves both Jev routes. TypeSafe's own API (`TYPESAFE_API_KEY`) and
 * OpenRouter's System One route (`OPENROUTER_API_KEY`, `POST https://openrouter.ai/api/v1/systemone`)
 * share one wire format, so the OpenRouter route is the same SDK client pointed at OpenRouter's
 * base URL with an OpenRouter model id — and both go through the SAME answer validation
 * (`fromSdkAnswers`) and usage recording.
 *
 * Every unexpected response shape FAILS CLOSED (throws) — a missing answer, a wrong
 * answer type, or a choice label that was not offered is never coerced into a guess.
 */

export type SdkChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type SdkNoulQuestion = { type: "noul"; instructions: string };
export type SdkScoreQuestion = { type: "score"; instructions: string; criteria: readonly [string, string] };
export type SdkQuestion = SdkChoiceQuestion | SdkNoulQuestion | SdkScoreQuestion;

/** jevitate's score is 0..1, so a two-level rubric makes the SDK's expected score land in 0..1. */
const SCORE_RUBRIC = ["low", "high"] as const;

export class JevResponseError extends Error {}

export function toSdkQuestions(questions: Record<string, Question>): Record<string, SdkQuestion> {
  const out: Record<string, SdkQuestion> = {};
  for (const [name, q] of Object.entries(questions)) {
    switch (q.kind) {
      case "choice": {
        const criteria: Record<string, string | null> = {};
        for (const option of q.options) criteria[option] = q.descriptions?.[option] ?? null;
        out[name] = { type: "choice", instructions: q.instructions ?? name, criteria };
        break;
      }
      case "noul":
        out[name] = { type: "noul", instructions: q.instructions ?? name };
        break;
      case "score":
        out[name] = { type: "score", instructions: q.instructions ?? name, criteria: q.criteria ?? SCORE_RUBRIC };
        break;
      default: {
        const exhaustive: never = q;
        throw new JevResponseError(`unsupported question: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return out;
}

function field(obj: object, key: string): unknown {
  return new Map<string, unknown>(Object.entries(obj)).get(key);
}

function asFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new JevResponseError(`${what} is not a finite number`);
  return v;
}

export function fromSdkAnswers(
  questions: Record<string, Question>,
  answers: unknown,
): Record<string, Answer> {
  if (typeof answers !== "object" || answers === null) {
    throw new JevResponseError("Jev response has no answers object");
  }
  const out: Record<string, Answer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const raw = field(answers, name);
    if (typeof raw !== "object" || raw === null) throw new JevResponseError(`Jev did not answer "${name}"`);
    const type = field(raw, "type");
    if (type !== q.kind) throw new JevResponseError(`Jev answered "${name}" as ${String(type)}, expected ${q.kind}`);
    switch (q.kind) {
      case "choice": {
        const value = field(raw, "choice");
        if (typeof value !== "string" || !q.options.includes(value)) {
          throw new JevResponseError(`Jev chose "${String(value)}" for "${name}", which was not offered`);
        }
        out[name] = { kind: "choice", value, confidence: asFiniteNumber(field(raw, "confidence"), `${name}.confidence`) };
        break;
      }
      case "noul": {
        const p = asFiniteNumber(field(raw, "noul"), `${name}.noul`);
        out[name] = { kind: "noul", value: p >= 0.5, probability: p };
        break;
      }
      case "score":
        out[name] = { kind: "score", value: asFiniteNumber(field(raw, "score"), `${name}.score`) };
        break;
      default: {
        const exhaustive: never = q;
        throw new JevResponseError(`unsupported question: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return out;
}

/** The gateway hands the seam a `Bearer <key>` header; the SDK client wants the bare key. */
export function apiKeyFromAuthHeader(authHeader: string): string {
  const match = /^Bearer\s+(\S.*)$/.exec(authHeader);
  if (!match || match[1] === undefined) throw new JevResponseError("judgment auth header is not a Bearer token");
  return match[1].trim();
}

/** Token usage the SDK reports alongside every `systemOne` result (`@typesafe-ai/sdk` >= 0.6). */
interface SdkUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** A provider-reported call cost in USD (#136): OpenRouter reports it on every call (#429); TypeSafe does not today. */
  readonly cost?: number;
}

/** The slice of `@typesafe-ai/sdk` (v0.6) the live Jev seam uses. */
interface TypeSafeSdk {
  TypeSafeClient: new (config: { apiKey: string; baseURL?: string }) => {
    /** The model a request that names none is sent to (`jev-latest` unless configured). */
    readonly defaultModel?: string;
    systemOne(req: { state: unknown; questions: Record<string, SdkQuestion>; model?: string }): Promise<{ answers: unknown; usage: SdkUsage; model?: string }>;
  };
}

/**
 * #429: the OpenRouter Jev route. The SDK appends `/v1/systemone` to the base URL. The model is
 * OpenRouter's alias for the newest Jev release; the response names the dated snapshot that
 * answered (e.g. `typesafe/jev-1.13-20260917`), which is what usage records.
 */
export const OPENROUTER_JEV_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_JEV_MODEL = "~typesafe/jev-latest";

/**
 * The model a Jev route asks for (for `ai status`): OpenRouter's alias, or the SDK's default for
 * TypeSafe (`TYPESAFE_DEFAULT_MODEL` when set, else `jev-latest`).
 */
export function jevRouteModel(provider: JevProvider, env: Record<string, string | undefined> = {}): string {
  if (provider === "openrouter") return OPENROUTER_JEV_MODEL;
  const configured = env.TYPESAFE_DEFAULT_MODEL?.trim();
  return configured !== undefined && configured !== "" ? configured : "jev-latest";
}

/** Client config + request model per Jev route. TypeSafe keeps the SDK defaults (unchanged behaviour). */
function routeConfig(provider: JevProvider): { baseURL?: string; model?: string; costSource: string } {
  return provider === "openrouter"
    ? { baseURL: OPENROUTER_JEV_BASE_URL, model: OPENROUTER_JEV_MODEL, costSource: "provider:openrouter usage.cost" }
    : { costSource: "provider:typesafe" };
}

function isTypeSafeSdk(mod: unknown): mod is TypeSafeSdk {
  return typeof mod === "object" && mod !== null && "TypeSafeClient" in mod && typeof mod.TypeSafeClient === "function";
}

/** Loads the SDK module. The default is a lazy dynamic import with a non-literal specifier. */
export type SdkLoader = () => Promise<unknown>;

const defaultSdkLoader: SdkLoader = () => {
  const specifier = "@typesafe-ai/sdk";
  return import(specifier);
};

/**
 * Real Jev seam (lazy). Fails closed with an actionable message when the SDK is absent or is an
 * unsupported version. `load` is a test seam; production uses the lazy dynamic import.
 *
 * `usage` (#100) is an optional sink: when supplied, every call (including a retry — this is the
 * innermost seam `RetryingJudgmentPort` re-invokes on each attempt) reports one judgment with the
 * SDK's own token counts. Absent `result.usage` (an unexpected SDK response) counts as 0 tokens
 * rather than throwing — usage accounting must never itself break a judgment call.
 */
export async function realJevClientCall(load: SdkLoader = defaultSdkLoader, usage?: UsageSink): Promise<JevClientCall> {
  const mod: unknown = await load().catch(() => {
    throw new Error("live judgment requires @typesafe-ai/sdk — install it next to the jevitate CLI (npm i @typesafe-ai/sdk)");
  });
  if (!isTypeSafeSdk(mod)) {
    throw new Error("@typesafe-ai/sdk does not export TypeSafeClient — unsupported SDK version (expected >= 0.6)");
  }
  const sdk = mod;
  return async ({ state, questions, authHeader, provider = "typesafe" }) => {
    const route = routeConfig(provider);
    const client = new sdk.TypeSafeClient({ apiKey: apiKeyFromAuthHeader(authHeader), ...(route.baseURL === undefined ? {} : { baseURL: route.baseURL }) });
    const requested = route.model ?? (typeof client.defaultModel === "string" ? client.defaultModel : undefined);
    let result: { answers: unknown; usage: SdkUsage; model?: string };
    try {
      result = await client.systemOne({ state, questions: toSdkQuestions(questions), ...(route.model === undefined ? {} : { model: route.model }) });
    } catch (e) {
      // #163: a failed attempt is still a call — recorded (unpriced unless it reported usage), then rethrown.
      usage?.recordJudgment({ inputTokens: 0, outputTokens: 0, ...(requested === undefined ? {} : { model: requested }), failure: failureClass(e) });
      throw e;
    }
    // Recorded BEFORE the answers are parsed: a response that fails closed below was still billed.
    // The response names the versioned model that answered (what the price table is keyed by).
    const model = typeof result.model === "string" && result.model !== "" ? result.model : requested;
    usage?.recordJudgment({
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      ...(model === undefined ? {} : { model }),
      ...(typeof result.usage?.cost === "number" && Number.isFinite(result.usage.cost) ? { usd: result.usage.cost, source: route.costSource } : {}),
    });
    return fromSdkAnswers(questions, result.answers);
  };
}
