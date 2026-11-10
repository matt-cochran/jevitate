import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock, isJobAttainment, JOB_BASES, type JobVerdict } from "@jevitate/domain";
import { flatJourneySteps, journeyProofHash, type Journey } from "@jevitate/journey";
import type { BrowserSession } from "@jevitate/playwright";
import type { BrowserContext, Request } from "playwright";
import type { JourneyRunEvidenceWriter } from "./journey-run-evidence.js";
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
 *
 * @deprecated since 0.30.0, in favour of the RunEvidence v1 record (journey-run-evidence.ts,
 * docs/design/0.30.0-evidence-and-trust.md §2.3), which every run writes as
 * `logs/<date>/journey-evidence-<stamp>-<suffix>/evidence.json` beside this file (same stamp and
 * suffix). This record's output is unchanged, and on a run with evidence its writes are derived from
 * what the evidence writer saw (`deriveFrom`), so the two never disagree about what was sent.
 */

/** #797: `queue` — a queued Journey call drained by `jevitate mission run`. */
export type RunChannel = "mcp" | "cli" | "queue";

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
  /** `hash`: the Journey's review hash. `proofHash` (0.30.0, optional): its executable identity, which rewording leaves alone. */
  readonly journey: { readonly id: string; readonly hash?: string; readonly proofHash?: string };
  readonly origin?: string;
  /** The run's outcome, or `refused` / `error` when it ended without one. */
  readonly outcome: string;
  /**
   * 0.30.0 (owner decision "Proof role"): the run's job verdict, as the done check decided it. Code tokens
   * only. Absent when no done-check scope decided one (a record written before 0.30.0 has none): read as
   * `unverified`.
   */
  readonly job?: JobVerdict;
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
  readonly job?: JobVerdict | undefined;
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
  #proofHash: string | undefined;
  #stepCount: number | undefined;
  #origin: string | undefined;
  #literals: ReadonlySet<string> = new Set();
  readonly #extracted = new Set<string>();
  /** `<stamp>-<suffix>`, decided once: the record's file and the evidence's directory share it. */
  readonly #runKey = `${artifactStamp(this.#startedAt)}-${randomBytes(4).toString("hex")}`;
  readonly #evidenceKeyFile: string | undefined;
  #evidence: JourneyRunEvidenceWriter | undefined;
  #detach: (() => void) | undefined;

  constructor(req: { readonly channel: RunChannel; readonly id: string; readonly params: Readonly<Record<string, string>>; readonly logsRoot?: string | undefined; readonly evidenceKeyFile?: string | undefined }) {
    this.#channel = req.channel;
    this.#id = req.id;
    this.#params = req.params;
    this.#root = req.logsRoot;
    this.#evidenceKeyFile = req.evidenceKeyFile;
  }

  get channel(): RunChannel {
    return this.#channel;
  }

  /** The key the run's evidence digest is keyed with (default `~/.jevitate/verify-checkpoint.key`). Testing seam. */
  get evidenceKeyFile(): string | undefined {
    return this.#evidenceKeyFile;
  }

  #dateDir(): string {
    return join(this.#root ?? logsRoot(), logDateOf(this.#startedAt) ?? this.#startedAt.slice(0, 10));
  }

  /** This run's own evidence directory, beside its record; absent when run records are off (`JEVITATE_RUN_RECORD=off`). */
  evidenceDir(): string | undefined {
    if (process.env.JEVITATE_RUN_RECORD === "off") return undefined;
    return join(this.#dateDir(), `journey-evidence-${this.#runKey}`);
  }

  /** From here on the record's writes and masked values are the evidence writer's, which watches the run instead of this recorder. */
  deriveFrom(evidence: JourneyRunEvidenceWriter): void {
    this.#evidence = evidence;
  }

  /** The Journey the run resolved to. Reading it never fails a run. */
  noteJourney(journey: Journey): void {
    try {
      this.#hash ??= journeyReviewHash(journey);
      this.#proofHash ??= journeyProofHash(journey);
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
    const observed = this.#evidence?.observed();
    const values = [...Object.values(this.#params), ...this.#extracted, ...(observed?.values ?? []), ...output];
    const writes: Iterable<SeenWrite> = observed?.writes ?? this.#writes.values();
    const shapes = new Map<string, { method: string; path: string; count: number; origin?: string; refused?: true }>();
    let count = 0;
    let refused = 0;
    for (const w of writes) {
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
      journey: { id: this.#id, ...(this.#hash === undefined ? {} : { hash: this.#hash }), ...(this.#proofHash === undefined ? {} : { proofHash: this.#proofHash }) },
      ...(this.#origin === undefined ? {} : { origin: this.#origin }),
      outcome: end.outcome,
      ...(end.job === undefined ? {} : { job: { attainment: end.job.attainment, basis: end.job.basis } }),
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
      const dir = this.#dateDir();
      mkdirSync(dir, { recursive: true });
      const name = `journey-run-${this.#runKey}.json`;
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
export async function withJourneyRunRecord<T>(
  req: ConstructorParameters<typeof JourneyRunRecorder>[0] & {
    /** The job verdict of a done-check scope this record runs inside (`journey run` wraps its record in one). */
    readonly job?: () => JobVerdict | undefined;
  },
  run: (recorder: JourneyRunRecorder) => Promise<T>,
): Promise<T & { runRecordError?: string }> {
  const recorder = new JourneyRunRecorder(req);
  let result: T;
  try {
    result = await run(recorder);
  } catch (err) {
    const job = jobVerdictOf(req.job?.());
    const problem = recorder.finish({ ...endOfError(err), ...(job === undefined ? {} : { job }) });
    if (problem !== undefined && err !== null && typeof err === "object") (err as { runRecordError?: string }).runRecordError = problem;
    throw err;
  }
  const r = result as { outcome?: unknown; at?: unknown; output?: unknown; job?: unknown };
  // A run inside a done-check scope (`run_journey`, a queued call) returns its verdict; `journey run` hands its scope's.
  const job = jobVerdictOf(r?.job) ?? jobVerdictOf(req.job?.());
  const problem = recorder.finish({
    outcome: typeof r?.outcome === "string" ? r.outcome : "unknown",
    ...(job === undefined ? {} : { job }),
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

/** A job verdict of code tokens only, or undefined: nothing else is ever copied into a record. */
export function jobVerdictOf(value: unknown): JobVerdict | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { attainment, basis } = value as { attainment?: unknown; basis?: unknown };
  return isJobAttainment(attainment) && typeof basis === "string" && (JOB_BASES as readonly string[]).includes(basis) ? { attainment, basis: basis as JobVerdict["basis"] } : undefined;
}

/** The logs root a Journeys dir's runs record into: `<data dir>/logs`, beside `<data dir>/journeys`. */
export function journeyRunLogsRoot(journeysDir: string): string {
  return join(dirname(journeysDir), "logs");
}

/** The latest run of one Journey, as its record says: when it ran, how it ended, and its job verdict. */
export interface LatestJourneyRun {
  readonly at: string;
  readonly outcome: string;
  /** Absent on a record written before 0.30.0, or by a run no done-check scope decided: reads `unverified`. */
  readonly job?: JobVerdict;
  /** Whether the run was of the Journey as it stands (its executable identity, else its review hash). */
  readonly current: boolean;
}

/**
 * 0.30.0 (owner decision "Proof role"): the newest `journey-run` record of `id` under `logsRoot`
 * (`<date>/journey-run-<stamp>-<suffix>.json`, newest first), or undefined when there is none. A record
 * that cannot be read is skipped. `journey` is the Journey as it stands, to say whether the run was of it.
 */
export function latestJourneyRun(logsRoot: string, id: string, journey?: Journey): LatestJourneyRun | undefined {
  let dates: string[];
  try {
    dates = readdirSync(logsRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return undefined;
  }
  for (const date of dates) {
    let names: string[];
    try {
      names = readdirSync(join(logsRoot, date)).filter((n) => n.startsWith("journey-run-") && n.endsWith(".json")).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names) {
      let rec: Partial<JourneyRunRecord>;
      try {
        rec = JSON.parse(readFileSync(join(logsRoot, date, name), "utf8")) as Partial<JourneyRunRecord>;
      } catch {
        continue;
      }
      if (rec?.kind !== "journey-run" || rec.journey?.id !== id || typeof rec.startedAt !== "string") continue;
      const job = jobVerdictOf(rec.job);
      return {
        at: typeof rec.endedAt === "string" ? rec.endedAt : rec.startedAt,
        outcome: typeof rec.outcome === "string" ? rec.outcome : "unknown",
        ...(job === undefined ? {} : { job }),
        current: journey === undefined ? true : runIsOf(rec.journey, journey),
      };
    }
  }
  return undefined;
}

function runIsOf(recorded: { readonly hash?: string; readonly proofHash?: string }, journey: Journey): boolean {
  try {
    if (recorded.proofHash !== undefined) return recorded.proofHash === journeyProofHash(journey);
    return recorded.hash !== undefined && recorded.hash === journeyReviewHash(journey);
  } catch {
    return false;
  }
}
