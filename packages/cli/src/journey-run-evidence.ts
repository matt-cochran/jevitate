import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunEvidenceSchema, type DoneCheckEvidence, type Known, type RunEvidence, type StepEvidence, type UnknownReason, type WriteShape } from "@jevitate/adjudicator";
import { clock } from "@jevitate/domain";
import type { Journey } from "@jevitate/journey";
import type { BrowserSession } from "@jevitate/playwright";
import type { BrowserContext, Request, Response } from "playwright";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { journeyRouteLiterals, writePathShape } from "./journey-run-record.js";
import { canonicalJson, checkpointKeyPath, createCheckpointKey, readCheckpointKey } from "./journey-verify-checkpoint.js";
import { maskValues } from "./mask-values.js";

/**
 * #812/#800: the RunEvidence v1 record (docs/design/0.30.0-evidence-and-trust.md §2) of one
 * `journey run`, written as `evidence.json` beside the run's result. Value-free by construction, like
 * the #790 run record: steps are kinds and outcomes, writes are counts and shapes (literal route text
 * only, every value masked), and the parameters appear only as `paramsDigest`, an HMAC-SHA-256 under
 * the verify-checkpoint key over the sorted non-secret `name=value` pairs, plus the secret names. A
 * secret value never enters the digest or the file; a non-secret value enters only the digest.
 *
 * Every write count is `Known`: a run whose page was never watched says so (`page-not-watched`)
 * instead of reading as "no writes" or "nothing open".
 *
 * The record is checked with `RunEvidenceSchema.parse` before it is written, so an invalid record is
 * never on disk. A failure to write never changes a run's outcome: `finish` returns why, never throws.
 */

export type EvidenceChannel = RunEvidence["run"]["channel"];
type WriteStatus = Extract<WriteShape["status"], { known: true }>["value"];

const READS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const STANDARD_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"]);
const methodShape = (method: string): WriteShape["method"] => (STANDARD_METHODS.has(method) ? (method as WriteShape["method"]) : "OTHER");
/** The most distinct write shapes one record lists; the counts stay exact. */
const MAX_SHAPES = 50;
/** Domain separation: this key also signs verify checkpoints, under other labels. */
const PARAMS_LABEL = "jevitate-evidence-params/1\0";
export const EVIDENCE_FILE = "evidence.json";

// --- The key: the verify-checkpoint key, read and created by journey-verify-checkpoint.ts (#787) ----

/** The verify-checkpoint key, created when there is none (as a fresh `journey verify` does), or why it cannot be used. */
export function loadEvidenceKey(keyFile: string): { readonly key: Buffer } | { readonly problem: string } {
  let read = readCheckpointKey(keyFile);
  if ("missing" in read) {
    try {
      createCheckpointKey(keyFile);
      read = readCheckpointKey(keyFile);
    } catch (err) {
      return { problem: `it could not be created (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }
  if ("missing" in read) return { problem: "it does not exist" };
  return read;
}

/**
 * The keyed digest of a run's parameters: HMAC-SHA-256 over the non-secret `[name, value]` pairs sorted
 * by name (as canonical JSON, so no `=` or newline in a value can make two sets collide). A name in
 * `secretNames` contributes nothing here; it is listed by name in `secretParamNames` instead.
 */
export function evidenceParamsDigest(key: Buffer, params: Readonly<Record<string, string>>, secretNames: readonly string[]): string {
  const secret = new Set(secretNames);
  const pairs = Object.entries(params)
    .filter(([name]) => !secret.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHmac("sha256", key).update(PARAMS_LABEL).update(canonicalJson(pairs)).digest("hex");
}

// --- The writer -----------------------------------------------------------------------------------------

/** One write the run sent, or the guard kept from leaving. Its URL is masked to a shape before it is stored. */
interface SeenWrite {
  readonly step: number;
  readonly method: WriteShape["method"];
  readonly url: string;
  status: WriteStatus | "open";
  refused: boolean;
}

/** A step as the run reports it; its writes are counted here. */
export type StepReport = Omit<StepEvidence, "writes">;

export interface JourneyRunEvidenceRequest {
  readonly channel: EvidenceChannel;
  /** The Journey's id and `journeyContentHash`. */
  readonly journey: { readonly id: string; readonly hash: string };
  /** Every parameter the run was given, secret ones included: values mask write shapes and feed the digest, never the file. */
  readonly params: Readonly<Record<string, string>>;
  /** The secret parameters' names (`secretParamNames` in @jevitate/journey). */
  readonly secretParamNames: readonly string[];
  readonly origin: string;
  readonly environment?: string | undefined;
  readonly trust?: RunEvidence["run"]["target"]["trust"];
  /** Default `~/.jevitate/verify-checkpoint.key`. */
  readonly keyFile?: string | undefined;
  readonly engine?: EngineInfo | undefined;
}

export class JourneyRunEvidenceWriter {
  readonly #req: JourneyRunEvidenceRequest;
  readonly #writes = new Map<object, SeenWrite>();
  readonly #steps = new Map<number, StepReport>();
  readonly #notes: string[] = [];
  readonly #extracted = new Set<string>();
  #literals: ReadonlySet<string> = new Set();
  #step = 1;
  #watched = false;
  #unknown: UnknownReason | undefined;
  #mode: RunEvidence["run"]["mode"] = "automation";
  #doneCheck: DoneCheckEvidence | undefined;
  #detach: (() => void) | undefined;

  constructor(req: JourneyRunEvidenceRequest) {
    this.#req = req;
  }

  /** The Journey's literal route text, kept in write shapes. Reading it never fails a run. */
  noteJourney(journey: Journey): void {
    try {
      this.#literals = journeyRouteLiterals(journey);
    } catch {
      // No literals: every segment is masked to its kind.
    }
  }

  /** Watches the session's writes. A page with no context to watch leaves every write count unknown (`page-not-watched`). */
  attach(session: BrowserSession): void {
    const page = session.page as { context?: () => BrowserContext };
    if (typeof page.context !== "function") return;
    this.watch(page.context());
  }

  /** Watches one browser context's writes: sent, answered (with a status class) and aborted. */
  watch(context: BrowserContext): void {
    const onRequest = (request: Request): void => this.noteWriteSent(request, request.method(), request.url());
    const onResponse = (response: Response): void => this.noteWriteAnswered(response.request(), response.status());
    const onFailed = (request: Request): void => this.noteWriteAborted(request);
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfailed", onFailed);
    this.#watched = true;
    const previous = this.#detach;
    this.#detach = () => {
      previous?.();
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailed);
    };
  }

  /** The step the run is on, 1-based: writes from here on are counted against it. */
  beginStep(index: number): void {
    if (Number.isInteger(index) && index >= 1) this.#step = index;
  }

  /** How a step ended. A later report of the same index replaces the earlier one. */
  noteStep(step: StepReport): void {
    this.#steps.set(step.index, step);
  }

  /** The run's mode, as a `resolveMode` run hook decided it (journey-run-hooks.ts). Default `automation`. */
  noteMode(mode: RunEvidence["run"]["mode"]): void {
    this.#mode = mode;
  }

  /** #800: the job done check's fresh-session readings (journey-done-check-hook.ts). Placeholders only, never a resolved value. */
  noteDoneCheck(doneCheck: DoneCheckEvidence): void {
    this.#doneCheck = doneCheck;
  }

  /**
   * What the writer saw, for the #790 run record that is derived from it (journey-run-record.ts): each
   * write as sent or refused (method shape and raw URL, in the order seen) and the values to mask.
   * In memory only; nothing here is written by this class except as a masked shape.
   */
  observed(): { readonly writes: readonly { readonly method: string; readonly url: string; readonly refused: boolean }[]; readonly values: readonly string[] } {
    return { writes: [...this.#writes.values()].map((w) => ({ method: w.method, url: w.url, refused: w.refused })), values: [...this.#extracted] };
  }

  /** A code-templated reason, for people. Never page text or a value. */
  note(reason: string): void {
    this.#notes.push(reason);
  }

  /** A value the run extracted: masked from write shapes, never stored. */
  readonly noteValue = (value: string): void => {
    this.#extracted.add(value);
  };

  /** The watcher could not be trusted to have seen every write (the page was replaced, the replay stalled). */
  noteWritesUnknown(reason: UnknownReason): void {
    this.#unknown ??= reason;
  }

  noteWriteSent(request: object, method: string, url: string): void {
    const m = method.toUpperCase();
    if (READS.has(m) || this.#writes.has(request)) return;
    this.#writes.set(request, { step: this.#step, method: methodShape(m), url, status: "open", refused: false });
  }

  noteWriteAnswered(request: object, status: number): void {
    const w = this.#writes.get(request);
    if (w === undefined || w.refused) return;
    w.status = status >= 500 ? "5xx" : status >= 400 ? "4xx" : status >= 300 ? "3xx" : "2xx";
  }

  noteWriteAborted(request: object): void {
    const w = this.#writes.get(request);
    if (w !== undefined && !w.refused && w.status === "open") w.status = "aborted";
  }

  /** A write the run guard kept from leaving the browser: a shape with `refused`, never counted as sent. */
  noteRefusedWrite(request: object, method: string, url: string): void {
    const seen = this.#writes.get(request);
    if (seen !== undefined) {
      seen.refused = true;
      seen.status = "aborted";
    } else this.#writes.set(request, { step: this.#step, method: methodShape(method.toUpperCase()), url, status: "aborted", refused: true });
  }

  #known(value: number): Known<number> {
    if (!this.#watched) return { known: false, reason: "page-not-watched" };
    if (this.#unknown !== undefined) return { known: false, reason: this.#unknown };
    return { known: true, value };
  }

  #shapes(values: readonly string[]): { readonly shapes: WriteShape[]; readonly truncated: boolean } {
    let own: string | undefined;
    try {
      own = new URL(this.#req.origin).origin;
    } catch {
      own = undefined;
    }
    const shapes = new Map<string, { step: number; method: WriteShape["method"]; path: string; origin?: string; count: number; status: WriteStatus | "unanswered"; refused?: true }>();
    for (const w of this.#writes.values()) {
      let url: URL;
      try {
        url = new URL(w.url);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const path = writePathShape(url.pathname, values, this.#literals);
      const origin = url.origin === own ? undefined : maskValues(url.origin, values, "[param]");
      const status = w.status === "open" ? "unanswered" : w.status;
      const key = `${w.step} ${w.method} ${origin ?? ""}${path} ${status} ${w.refused}`;
      const shape = shapes.get(key);
      if (shape !== undefined) shape.count += 1;
      else shapes.set(key, { step: w.step, method: w.method, path, ...(origin === undefined ? {} : { origin }), count: 1, status, ...(w.refused ? { refused: true as const } : {}) });
    }
    const listed = [...shapes.values()].map(({ status, ...s }): WriteShape => ({ ...s, status: this.#unknown === undefined ? { known: true, value: status } : { known: false, reason: this.#unknown } }));
    return { shapes: listed.slice(0, MAX_SHAPES), truncated: listed.length > MAX_SHAPES };
  }

  /** The record, parsed by `RunEvidenceSchema`: throws on anything the schema refuses. */
  build(key: Buffer): RunEvidence {
    const values = [...Object.values(this.#req.params), ...this.#extracted];
    const sent = [...this.#writes.values()].filter((w) => !w.refused);
    const answered = sent.filter((w) => w.status !== "open" && w.status !== "aborted").length;
    const aborted = sent.filter((w) => w.status === "aborted").length;
    const open = sent.filter((w) => w.status === "open").length;
    const { shapes, truncated } = this.#shapes(values);
    const perStep = new Map<number, number>();
    for (const w of sent) perStep.set(w.step, (perStep.get(w.step) ?? 0) + 1);
    const steps = [...this.#steps.values()].sort((a, b) => a.index - b.index).map((s): StepEvidence => ({ ...s, writes: this.#known(perStep.get(s.index) ?? 0) }));
    const engine = this.#req.engine ?? currentEngineInfo();
    const notes = [...this.#notes, ...(truncated ? [`write shapes are listed up to ${MAX_SHAPES}; the counts are exact`] : [])];
    const origin = new URL(this.#req.origin).origin;
    return RunEvidenceSchema.parse({
      schema: "jevitate.evidence",
      version: 1,
      producedAt: clock.nowIso(),
      producer: { jevitate: engine.version.slice(0, 64), commit: engine.commit.slice(0, 64) },
      subject: { kind: "journey-run", journey: { id: this.#req.journey.id, hash: this.#req.journey.hash } },
      run: {
        // §5: decided by target configuration once d-run-modes lands (a `resolveMode` run hook); `automation` until then.
        mode: this.#mode,
        channel: this.#req.channel,
        target: { origin, ...(this.#req.environment === undefined ? {} : { environment: this.#req.environment }), trust: this.#req.trust ?? "unknown" },
        paramsDigest: evidenceParamsDigest(key, this.#req.params, this.#req.secretParamNames),
        secretParamNames: [...new Set(this.#req.secretParamNames)].sort(),
      },
      steps,
      writes: { sent: this.#known(sent.length), answered: this.#known(answered), aborted: this.#known(aborted), openAtClose: this.#known(open), shapes },
      ...(this.#doneCheck === undefined ? {} : { doneCheck: this.#doneCheck }),
      judgments: [],
      notes,
    } satisfies RunEvidence);
  }

  /**
   * Stops watching, builds and validates the record, and writes `<outDir>/evidence.json` atomically
   * (mode 0600, a temp file renamed into place). Returns why it could not, never throws; nothing is
   * written when the key cannot be used or the record does not parse.
   */
  finish(outDir: string): string | undefined {
    this.#detach?.();
    this.#detach = undefined;
    const keyFile = this.#req.keyFile ?? checkpointKeyPath();
    const loaded = loadEvidenceKey(keyFile);
    if (!("key" in loaded)) return `the evidence record was not written: the key ${keyFile} cannot be used (${loaded.problem}); the run's outcome stands`;
    let record: RunEvidence;
    try {
      record = this.build(loaded.key);
    } catch {
      return "the evidence record was not written: it did not pass its schema; the run's outcome stands";
    }
    let tmp: string | undefined;
    try {
      mkdirSync(outDir, { recursive: true });
      tmp = join(outDir, `.${EVIDENCE_FILE}.${randomBytes(4).toString("hex")}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tmp, join(outDir, EVIDENCE_FILE));
      tmp = undefined;
    } catch (err) {
      if (tmp !== undefined) rmSync(tmp, { force: true });
      const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : "error";
      return `the evidence record could not be written (${code}); the run's outcome stands`;
    }
    return undefined;
  }
}
