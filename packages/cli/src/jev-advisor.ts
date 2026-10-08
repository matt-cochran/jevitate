import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash } from "@jevitate/domain";
import {
  JevJudgmentGateway,
  JevProviderError,
  MissingCredentialError,
  RetryingJudgmentPort,
  UsageTracker,
  envCredentialStore,
  jevProviderOverride,
  realJevClientCall,
  resolveJevRoute,
  type Answer,
  type JevProvider,
  type JudgmentPort,
  type JudgmentState,
  type Question,
} from "@jevitate/ai-core";
import type { JevLayer } from "@jevitate/journey";
import { GatewaySelectionError, keyPreflightOpts, type CliDeps } from "./cli-shared.js";
import { loadLocalCredentials } from "./credentials-file.js";
import { preflightRunKeys } from "./run-key-preflight.js";
import { resolveUsagePricing } from "./usage-config.js";

/**
 * #434/#435 — the advisory Jev layer of the review sheets and the pre-approval pipeline: one
 * `JudgmentPort` (the existing judgment gateway, TypeSafe or OpenRouter key, #429) behind a cache
 * keyed by the content hash of what is asked, plus the usage of every call actually made.
 *
 * Model use follows the CLI's `--real` convention: the layer runs only on a command given `--real`
 * (review sheets, approvals, `catalog analyze`; MCP `real: true`). Unlike a run, a missing judgment
 * key is not a refusal here — the deterministic layer stands on its own, so the sheet says
 * "skipped: no judgment key". Without `--real` it says "skipped: pass --real".
 *
 * The cache (`<project>/.jevitate/cache/jev/<sha256>.json`, gitignored) holds ANSWERS only — a kind,
 * a value, a probability — keyed by `sha256(state + questions)`. The state is built from catalog
 * text (job stories, persona descriptions, a Journey's review-sheet lines, which never carry a
 * secret value), and it is never written: nothing secret is cached. A re-review of unchanged
 * content asks nothing new. An unreadable entry is a miss (it is re-asked and rewritten).
 */

/** Bumped when the questions' meaning changes in a way their text does not show. */
export const JEV_CACHE_VERSION = 1;

/** Why the Jev layer did not run. */
export const JEV_SKIPPED_PASS_REAL = "pass --real to ask Jev (needs a judgment key)";
export const JEV_SKIPPED_NO_KEY = "no judgment key — set TYPESAFE_API_KEY or OPENROUTER_API_KEY (jevitate ai setup)";

export interface JevAdvisor {
  /** Asks `questions` about `state` (one model call), or returns the cached answers for the same content. */
  ask(state: JudgmentState, questions: Record<string, Question>): Promise<{ readonly answers: Record<string, Answer>; readonly cached: boolean }>;
  /** What this advisor did so far: questions sent to the model, answers served from the cache, usage. */
  layer(): JevLayer;
}

/** The Jev layer for one command: an advisor, or why there is none. */
export type JevSetup = { readonly advisor: JevAdvisor } | { readonly skipped: string };

function validAnswer(q: Question, a: unknown): a is Answer {
  if (a === null || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  if (o.kind !== q.kind) return false;
  if (q.kind === "choice") return typeof o.value === "string" && q.options.includes(o.value) && typeof o.confidence === "number" && Number.isFinite(o.confidence);
  if (q.kind === "noul") return typeof o.value === "boolean" && typeof o.probability === "number" && Number.isFinite(o.probability);
  return typeof o.value === "number" && Number.isFinite(o.value);
}

function validAnswers(questions: Record<string, Question>, answers: unknown): answers is Record<string, Answer> {
  if (answers === null || typeof answers !== "object") return false;
  const rec = answers as Record<string, unknown>;
  return Object.entries(questions).every(([name, q]) => validAnswer(q, rec[name]));
}

/** #434/#435: the judgment port behind a memory + on-disk answer cache, counting what it asks. */
export class CachedJevAdvisor implements JevAdvisor {
  readonly #memory = new Map<string, Record<string, Answer>>();
  #asked = 0;
  #cached = 0;

  constructor(
    private readonly judge: JudgmentPort,
    /** The answer cache directory; null: memory only (outside a project). */
    private readonly cacheDir: string | null,
    private readonly usage: UsageTracker,
  ) {}

  async ask(state: JudgmentState, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; cached: boolean }> {
    const key = contentHash({ v: JEV_CACHE_VERSION, state, questions });
    const hit = this.#memory.get(key) ?? (await this.#read(key, questions));
    if (hit !== undefined) {
      this.#memory.set(key, hit);
      this.#cached += Object.keys(questions).length;
      return { answers: hit, cached: true };
    }
    this.#asked += Object.keys(questions).length;
    const answers = await this.judge.systemOne({ state, questions });
    if (!validAnswers(questions, answers)) throw new Error("the judgment answers do not match the questions asked");
    this.#memory.set(key, answers);
    await this.#write(key, answers);
    return { answers, cached: false };
  }

  layer(): JevLayer {
    const usage = this.usage.snapshot();
    const { priceSource, missing, ...counts } = usage;
    return {
      status: "ran",
      asked: this.#asked,
      cached: this.#cached,
      ...(usage.judgments + usage.generations === 0
        ? {}
        : { usage: { ...counts, ...(priceSource === undefined ? {} : { priceSource: [...priceSource] }), ...(missing === undefined ? {} : { missing: [...missing] }) } }),
    };
  }

  async #read(key: string, questions: Record<string, Question>): Promise<Record<string, Answer> | undefined> {
    if (this.cacheDir === null) return undefined;
    let raw: string;
    try {
      raw = await readFile(join(this.cacheDir, `${key}.json`), "utf8");
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return undefined;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined; // a torn entry is a miss: re-asked and rewritten
    }
    const answers = (parsed as { version?: unknown; answers?: unknown } | null)?.version === JEV_CACHE_VERSION ? (parsed as { answers: unknown }).answers : undefined;
    return validAnswers(questions, answers) ? answers : undefined;
  }

  async #write(key: string, answers: Record<string, Answer>): Promise<void> {
    if (this.cacheDir === null) return;
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const file = join(this.cacheDir, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: JEV_CACHE_VERSION, answers })}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }
}

/** The answer cache directory of a project data dir (`<.jevitate>/cache/jev`), or null outside a project. */
export function jevCacheDir(catalogDir: string | null): string | null {
  return catalogDir === null ? null : join(catalogDir, "cache", "jev");
}

/** The Jev layer's report when it did not run. */
export function skippedLayer(reason: string): JevLayer {
  return { status: "skipped", reason, asked: 0, cached: 0 };
}

export function jevLayerOf(setup: JevSetup | undefined): JevLayer {
  if (setup === undefined) return skippedLayer(JEV_SKIPPED_PASS_REAL);
  return "advisor" in setup ? setup.advisor.layer() : skippedLayer(setup.skipped);
}

/**
 * #434/#435: the Jev layer of one command. Without `--real`: skipped ("pass --real"). With it: an
 * injected judge (tests) wins; else the live judgment gateway on the resolved Jev route
 * (`--jev-provider`, else TypeSafe then OpenRouter) after the startup key check — or, when no
 * judgment key is configured, skipped ("no judgment key"): the deterministic layer still runs.
 * An unknown `--jev-provider` is refused (`GatewaySelectionError`), never ignored.
 */
export async function buildJevSetup(deps: CliDeps, opts: { readonly real?: boolean; readonly jevProvider?: string; readonly cacheDir: string | null }): Promise<JevSetup> {
  if (opts.real !== true) return { skipped: JEV_SKIPPED_PASS_REAL };
  const env = deps.explore?.env ?? process.env;
  const usage = deps.explore?.usage ?? new UsageTracker(resolveUsagePricing(env));
  if (deps.explore?.judge !== undefined) return { advisor: new CachedJevAdvisor(deps.explore.judge, opts.cacheDir, usage) };
  let provider: JevProvider | undefined;
  try {
    provider = jevProviderOverride(env, opts.jevProvider);
  } catch (err) {
    if (err instanceof JevProviderError) throw new GatewaySelectionError(err.message);
    throw err;
  }
  const store = envCredentialStore(env, deps.explore?.localConfig ?? loadLocalCredentials());
  try {
    resolveJevRoute(store, provider);
  } catch (err) {
    if (err instanceof MissingCredentialError) return { skipped: JEV_SKIPPED_NO_KEY };
    throw err;
  }
  await preflightRunKeys(["judgment"], store, { ...keyPreflightOpts(deps), ...(provider === undefined ? {} : { jevProvider: provider }) });
  const judge = new RetryingJudgmentPort(new JevJudgmentGateway(store, await realJevClientCall(undefined, usage), provider));
  return { advisor: new CachedJevAdvisor(judge, opts.cacheDir, usage) };
}
