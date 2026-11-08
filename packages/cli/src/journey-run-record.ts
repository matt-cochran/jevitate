import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock } from "@jevitate/domain";
import { flatJourneySteps, type Journey } from "@jevitate/journey";
import type { BrowserSession } from "@jevitate/playwright";
import type { BrowserContext, Request } from "playwright";
import { journeyReviewHash } from "./journey-review.js";
import { loadLogsRetention, pruneLogs } from "./logs-retention.js";
import { artifactStamp } from "./mission-journal.js";
import { maskValues } from "./mask-values.js";
import { logDateOf, logsRoot } from "./project-dir.js";

/**
 * #790: one value-free record of each `run_journey` / `journey run`, in the project's logs area
 * (`logs/<date>/journey-run-<stamp>-<suffix>.json`), kept and pruned like every run's output: what ran
 * (Journey id and content hash), against which origin, how it ended, its step count, what it wrote
 * (method and path SHAPE only), when, and by which channel.
 *
 * Value-free by construction: nothing here reads a parameter's value into the record, and no free text
 * is stored (no failure reason, no page text, no query string, no body). A path keeps only segments the
 * Journey itself recorded as literal route text, so the record says no more than the Journey does; every
 * other segment, and any holding a parameter's or an extracted value, is replaced by its kind. A word
 * can't be told from a token by its look (`/invite/brave-otter`), so a shape may be coarse.
 *
 * A failure to write it never changes a run's outcome: it is reported beside the result as
 * `runRecordError`, like `artifactError`.
 */

export type RunChannel = "mcp" | "cli";

const READS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
/** What a record names a method by. A method is the page's own text, so anything else is `OTHER`, never stored. */
const STANDARD_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"]);
const methodShape = (method: string): string => (STANDARD_METHODS.has(method) ? method : "OTHER");
/** An API version: the one segment kept with no Journey to vouch for it. */
const API_VERSION = /^v\d{1,2}$/;
/** A template's or a glob's segment, which is no literal text. */
const NOT_LITERAL = /[*?{}$:]/;
/** The most distinct write shapes one record lists (the count stays exact). */
const MAX_SHAPES = 50;

/** The path of a recorded URL or request line, whichever it is. */
function pathOfRecorded(recorded: string): string {
  const line = /^[A-Z]+\s+(\S+)/.exec(recorded.trim())?.[1] ?? recorded.trim();
  try {
    return /^https?:\/\//i.test(line) ? new URL(line).pathname : (line.split(/[?#]/)[0] ?? "");
  } catch {
    return "";
  }
}

/** The path segments a Journey recorded as literal text: its pages' and navigations' URLs, and the requests its steps recorded or check. */
export function journeyRouteLiterals(journey: Journey): ReadonlySet<string> {
  const paths = journey.recording.pages.map((page) => page.url);
  for (const { recorded } of flatJourneySteps(journey)) {
    if (recorded.step.kind === "navigate") paths.push(recorded.step.url);
    paths.push(...(recorded.delta?.requests ?? []));
    for (const check of recorded.expectRequests ?? []) if ("pathGlob" in check) paths.push(check.pathGlob);
  }
  return new Set(paths.flatMap((p) => pathOfRecorded(p).split("/")).filter((segment) => segment !== "" && !NOT_LITERAL.test(segment)));
}

/** The shape of a URL path: what the Journey recorded as literal kept, a value's segment `:param`, anything else `:id`. */
export function writePathShape(pathname: string, values: readonly string[], literals: ReadonlySet<string> = new Set()): string {
  const lowered = values.filter((v) => v !== "").map((v) => v.toLowerCase());
  return pathname
    .split("/")
    .map((raw) => {
      if (raw === "") return raw;
      let segment = raw;
      try {
        segment = decodeURIComponent(raw);
      } catch {
        // Not decodable: judged as it stands.
      }
      const lower = segment.toLowerCase();
      if (lowered.some((v) => lower.includes(v) || v.includes(lower))) return ":param";
      return literals.has(raw) || API_VERSION.test(segment) ? segment : ":id";
    })
    .join("/");
}

interface SeenWrite {
  readonly method: string;
  readonly url: string;
  refused: boolean;
}

export interface JourneyRunRecord {
  readonly kind: "journey-run";
  readonly version: 1;
  readonly channel: RunChannel;
  readonly journey: { readonly id: string; readonly hash?: string };
  readonly origin?: string;
  /** The run's outcome, or `refused` / `error` when it ended without one. */
  readonly outcome: string;
  /** The typed code of a refusal or error. */
  readonly code?: string;
  /** The step the run stopped at, 1-based. */
  readonly stoppedAtStep?: number;
  readonly stepCount?: number;
  readonly writes: {
    /** Writes that left the browser (`refused` ones never did). */
    readonly count: number;
    readonly refused: number;
    readonly shapes: readonly { readonly method: string; readonly path: string; readonly count: number; readonly origin?: string; readonly refused?: true }[];
    readonly truncated?: true;
  };
  readonly startedAt: string;
  readonly endedAt: string;
}

/** How a run ended. `output` only masks its values from the write shapes; none of it is stored. */
interface RunEnd {
  readonly outcome: string;
  readonly code?: string;
  readonly stoppedAtStep?: number;
  readonly output?: unknown;
}

export class JourneyRunRecorder {
  readonly #channel: RunChannel;
  readonly #id: string;
  readonly #params: Readonly<Record<string, string>>;
  readonly #root: string | undefined;
  readonly #startedAt = clock.nowIso();
  readonly #writes = new Map<Request, SeenWrite>();
  #hash: string | undefined;
  #stepCount: number | undefined;
  #origin: string | undefined;
  #literals: ReadonlySet<string> = new Set();
  readonly #extracted = new Set<string>();
  #detach: (() => void) | undefined;

  constructor(req: { readonly channel: RunChannel; readonly id: string; readonly params: Readonly<Record<string, string>>; readonly logsRoot?: string | undefined }) {
    this.#channel = req.channel;
    this.#id = req.id;
    this.#params = req.params;
    this.#root = req.logsRoot;
  }

  /** The Journey the run resolved to. Reading it never fails a run. */
  noteJourney(journey: Journey): void {
    try {
      this.#hash ??= journeyReviewHash(journey);
      this.#stepCount ??= flatJourneySteps(journey).length;
      this.#origin = new URL(journey.recording.site).origin;
      this.#literals = journeyRouteLiterals(journey);
    } catch {
      // What could not be read stays absent from the record.
    }
  }

  /** Watches the session's writes. A test double's page, with no context, has none to watch. */
  attach(session: BrowserSession): void {
    const page = session.page as { context?: () => BrowserContext };
    if (typeof page.context !== "function") return;
    const context = page.context();
    const onRequest = (request: Request): void => {
      const method = request.method().toUpperCase();
      if (!READS.has(method)) this.#writes.set(request, { method: methodShape(method), url: request.url(), refused: false });
    };
    context.on("request", onRequest);
    this.#detach = () => context.off("request", onRequest);
  }

  /** A value the run extracted, as it was extracted: a run that throws returns no `output` to read it from. Masked from the record, never stored. */
  readonly noteValue = (value: string): void => {
    this.#extracted.add(value);
  };

  /** A write the run guard kept from leaving the browser. */
  readonly noteRefusedWrite = (request: Request): void => {
    const seen = this.#writes.get(request);
    if (seen !== undefined) seen.refused = true;
    else this.#writes.set(request, { method: methodShape(request.method().toUpperCase()), url: request.url(), refused: true });
  };

  #record(end: RunEnd): JourneyRunRecord {
    const output = end.output !== null && typeof end.output === "object" ? Object.values(end.output as Record<string, unknown>).filter((v): v is string => typeof v === "string") : [];
    const values = [...Object.values(this.#params), ...this.#extracted, ...output];
    const shapes = new Map<string, { method: string; path: string; count: number; origin?: string; refused?: true }>();
    let count = 0;
    let refused = 0;
    for (const w of this.#writes.values()) {
      if (w.refused) refused += 1;
      else count += 1;
      let url: URL;
      try {
        url = new URL(w.url);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const path = writePathShape(url.pathname, values, this.#literals);
      const origin = url.origin === this.#origin ? undefined : maskValues(url.origin, values, "[param]");
      const key = `${w.method} ${origin ?? ""}${path} ${w.refused}`;
      const shape = shapes.get(key);
      if (shape !== undefined) shape.count += 1;
      else shapes.set(key, { method: w.method, path, count: 1, ...(origin === undefined ? {} : { origin }), ...(w.refused ? { refused: true as const } : {}) });
    }
    const listed = [...shapes.values()];
    return {
      kind: "journey-run",
      version: 1,
      channel: this.#channel,
      journey: { id: this.#id, ...(this.#hash === undefined ? {} : { hash: this.#hash }) },
      ...(this.#origin === undefined ? {} : { origin: this.#origin }),
      outcome: end.outcome,
      ...(end.code === undefined ? {} : { code: end.code }),
      ...(end.stoppedAtStep === undefined ? {} : { stoppedAtStep: end.stoppedAtStep }),
      ...(this.#stepCount === undefined ? {} : { stepCount: this.#stepCount }),
      writes: { count, refused, shapes: listed.slice(0, MAX_SHAPES), ...(listed.length > MAX_SHAPES ? { truncated: true as const } : {}) },
      startedAt: this.#startedAt,
      endedAt: clock.nowIso(),
    };
  }

  /** Writes the record atomically (a temp file renamed into place). Returns why it could not, never throws. */
  finish(end: RunEnd): string | undefined {
    this.#detach?.();
    this.#detach = undefined;
    if (process.env.JEVITATE_RUN_RECORD === "off") return undefined;
    let tmp: string | undefined;
    try {
      const root = this.#root ?? logsRoot();
      const dir = join(root, logDateOf(this.#startedAt) ?? this.#startedAt.slice(0, 10));
      mkdirSync(dir, { recursive: true });
      const name = `journey-run-${artifactStamp(this.#startedAt)}-${randomBytes(4).toString("hex")}.json`;
      tmp = join(dir, `.${name}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(this.#record(end), null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tmp, join(dir, name));
      tmp = undefined;
    } catch (err) {
      if (tmp !== undefined) rmSync(tmp, { force: true });
      const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : "error";
      return `the run record could not be written (${code}); the run's outcome stands`;
    }
    // Over MCP no command's start prunes the logs (the CLI's does): the same retention, best effort.
    if (this.#channel === "mcp") {
      try {
        pruneLogs(this.#root ?? logsRoot(), loadLogsRetention());
      } catch {
        // Housekeeping is not the run's business (a bad config is `logs prune`'s to report).
      }
    }
    return undefined;
  }
}

/** The refusal or error code of what ended a run without a result. */
function endOfError(err: unknown): { readonly outcome: string; readonly code?: string; readonly stoppedAtStep?: number } {
  const e = err as { code?: unknown; extra?: { at?: unknown }; name?: unknown; retryable?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : undefined;
  const at = e?.extra?.at;
  return { outcome: e?.retryable === false ? "refused" : "error", ...(code === undefined ? {} : { code }), ...(typeof at === "number" ? { stoppedAtStep: at } : {}) };
}

/**
 * Runs one Journey with its record: `runRecordError` on the result when the record could not be written,
 * and on the error when the run itself threw (the caller reports it; the run's outcome is not touched).
 */
export async function withJourneyRunRecord<T>(req: ConstructorParameters<typeof JourneyRunRecorder>[0], run: (recorder: JourneyRunRecorder) => Promise<T>): Promise<T & { runRecordError?: string }> {
  const recorder = new JourneyRunRecorder(req);
  let result: T;
  try {
    result = await run(recorder);
  } catch (err) {
    const problem = recorder.finish(endOfError(err));
    if (problem !== undefined && err !== null && typeof err === "object") (err as { runRecordError?: string }).runRecordError = problem;
    throw err;
  }
  const r = result as { outcome?: unknown; at?: unknown; output?: unknown };
  const problem = recorder.finish({
    outcome: typeof r?.outcome === "string" ? r.outcome : "unknown",
    ...(typeof r?.at === "number" ? { stoppedAtStep: r.at + 1 } : {}),
    output: r?.output,
  });
  return problem === undefined ? (result as T & { runRecordError?: string }) : { ...result, runRecordError: problem };
}

/** The `runRecordError` a run's thrown error carries, if any. */
export function runRecordErrorOf(err: unknown): string | undefined {
  const v = err !== null && typeof err === "object" ? (err as { runRecordError?: unknown }).runRecordError : undefined;
  return typeof v === "string" ? v : undefined;
}
