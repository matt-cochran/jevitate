import {
  FsJourneyStore,
  JourneyRegistry,
  bindParams,
  checkCompatibility,
  handoffKey,
  journeyParamSchema,
  outputKeyFields,
  ParamValidationError,
  readRecords as readHandoffRecords,
  recordFingerprint,
  validateParams,
  validateRecords,
  validateRequests,
  type HandoffContext,
  type HandoffFieldType,
  type HandoffInputsDecl,
  type HandoffOutputsDecl,
  type HandoffRecord,
  type HandoffRejection,
  type Journey,
} from "@jevitate/journey";
import { clock } from "@jevitate/domain";
import type { JourneyRunResult, SiteGateDeps } from "@jevitate/runtime";
import type { BrowserPort, EmulationSpec } from "@jevitate/playwright";
import type { BrowserRunOptions } from "./browser-run-options.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import { runJourneyProgrammatically, UnknownJourneyError, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #580 (docs/journey-chain-contract.md §5): `jevitate journey chain` runs a discover Journey once,
 * then a prepare-only reply Journey once per approved request matched to a discovered record. This is
 * the one programmatic surface the CLI and the (separately reviewed) MCP tool share.
 *
 * The result carries names and outcomes only — never a record field's value (e.g. `sourceText`) or a
 * request's `replyText`.
 *
 * #582 (docs/contracts/journey-handoff.md §4-§5): when the reply Journey declares `metadata.inputs`,
 * the discovered records and the requests are validated by the pure `@jevitate/journey` handoff
 * validators and each request is matched on `inputs.request.key` and bound by `bindParams`.
 */

/** The runner `journey run` uses; a testing seam so the chain can be driven without a browser. */
export type JourneyChainRunner = (options: RunJourneyProgrammaticallyOptions) => Promise<JourneyRunResult>;

/** Injectable wiring for `runJourneyChain` (all optional; the real runner is the default). */
export interface JourneyChainDeps {
  /** Testing seam — defaults to `runJourneyProgrammatically`. */
  readonly runJourney?: JourneyChainRunner;
}

export type JourneyChainErrorCode = "E_CHAIN_FROM_FAILED" | "E_CHAIN_EMPTY" | "E_CHAIN_REQUEST" | "E_CHAIN_PARAMS" | "E_CHAIN_NOT_PROMOTED" | "E_HANDOFF_INCOMPATIBLE";

/** A chain-stopping failure (§5 steps 1, 2 and the §4 request contract). */
export class JourneyChainError extends Error {
  readonly code: JourneyChainErrorCode;
  constructor(code: JourneyChainErrorCode, message: string) {
    super(message);
    this.name = "JourneyChainError";
    this.code = code;
  }
}

/** §5 step 4: a matched record is missing a field the reply Journey needs — per request, never a guess. */
export const E_CHAIN_FIELD = "E_CHAIN_FIELD";

/** One approved, prepare-only request (§4). `commentId` + `account` are the identity; no other key exists. */
export interface ChainRequest {
  readonly commentId: string;
  readonly account: string;
  readonly replyText: string;
}

/** One matched request's run outcome (§5 result `runs[]`). */
export interface ChainRunResult {
  readonly commentId: string;
  readonly account: string;
  readonly outcome: string;
  readonly reason?: string;
  /** §5 (handoff): the accepted contract (`name@major`). */
  readonly contract?: string;
  /** §5 (handoff): `sha256:` of the record's declared fields. */
  readonly fingerprint?: string;
  /** §5 (handoff): when the producing run finished (ISO 8601 UTC, from the injectable clock). */
  readonly capturedAt?: string;
}

/** One request with no discovered record (§5 result `unmatched[]`). */
export interface ChainUnmatched {
  readonly commentId: string;
  readonly account: string;
}

/** The §5 result: the discover run's summary, one entry per matched request, the unmatched requests. */
export interface JourneyChainResult {
  readonly from: { readonly journey: string; readonly outcome: string; readonly records: number };
  readonly runs: readonly ChainRunResult[];
  readonly unmatched: readonly ChainUnmatched[];
  /** §4/§5 (handoff): records, ambiguous keys and requests a chain refused to run; absent in 0.17.0 mode. */
  readonly rejected?: readonly HandoffRejection[];
}

const REQUEST_KEYS = ["commentId", "account", "replyText"] as const;

/**
 * §4: parse the JSON Lines file of prepare-only requests. `commentId`, `account` and `replyText` are
 * exactly the keys; any other key, a missing key or a non-string value is refused (`E_CHAIN_REQUEST`).
 * Blank lines are skipped; approval metadata stays in Bizops and is not read here.
 */
export function parseChainRequests(text: string): ChainRequest[] {
  const requests: ChainRequest[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]?.trim() ?? "";
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new JourneyChainError("E_CHAIN_REQUEST", `request line ${n + 1} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JourneyChainError("E_CHAIN_REQUEST", `request line ${n + 1} must be a JSON object`);
    }
    const bag = parsed as Record<string, unknown>;
    const keys = Object.keys(bag);
    const missing = REQUEST_KEYS.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !(REQUEST_KEYS as readonly string[]).includes(k));
    if (missing.length > 0 || extra.length > 0) {
      throw new JourneyChainError("E_CHAIN_REQUEST", `request line ${n + 1} — missing: [${missing.join(", ")}], unknown: [${extra.join(", ")}]`);
    }
    for (const k of REQUEST_KEYS) {
      if (typeof bag[k] !== "string") {
        throw new JourneyChainError("E_CHAIN_REQUEST", `request line ${n + 1} — ${k} must be a string`);
      }
    }
    requests.push({ commentId: bag.commentId as string, account: bag.account as string, replyText: bag.replyText as string });
  }
  return requests;
}

/** One discovered record, read from the discover run's indexed `records.<i>.<field>` outputs (§1, §2). */
interface ChainRecord {
  readonly commentId?: string;
  readonly account?: string;
  readonly threadId?: string;
  readonly sourceText?: string;
  readonly parentId?: string;
}

const recordKey = (commentId: string, account: string): string => `${commentId}\u0000${account}`;

const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * §5 step 2: read the discover run's outputs. A missing or zero `records.count` stops the chain
 * (`E_CHAIN_EMPTY`) — no target is guessed. Every indexed field is read; a missing optional field is
 * left absent.
 */
function readRecords(output: unknown): { count: number; records: ChainRecord[] } {
  const bag = output !== null && typeof output === "object" ? (output as Record<string, unknown>) : {};
  const raw = bag["records.count"];
  const count = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(count) || count <= 0) {
    throw new JourneyChainError("E_CHAIN_EMPTY", `the discover Journey returned no records (records.count = ${raw === undefined ? "missing" : JSON.stringify(raw)})`);
  }
  const field = (i: number, name: string): string | undefined => asString(bag[`records.${i}.${name}`]);
  const records = Array.from({ length: count }, (_, i): ChainRecord => ({
    commentId: field(i, "commentId"),
    account: field(i, "account"),
    threadId: field(i, "threadId"),
    sourceText: field(i, "sourceText"),
    parentId: field(i, "parentId"),
  }));
  return { count, records };
}

/**
 * §3: the reply Journey's params from one record and its approved request — each passed only when
 * the reply Journey declares it, except `replyText`, which it must take. A declared param whose
 * record field is missing is `E_CHAIN_FIELD` for that request (never a guess, never `""`).
 */
function chainParams(
  record: ChainRecord,
  request: ChainRequest,
  declared: ReadonlySet<string>,
): { ok: true; params: Record<string, string> } | { ok: false; detail: string } {
  const sources: Readonly<Record<string, string | undefined>> = {
    commentId: record.commentId,
    replyIdentity: record.account,
    threadId: record.threadId,
    expected_commentid: record.commentId,
    expected_account: record.account,
    expected_sourcetext: record.sourceText,
    expected_parentid: record.parentId,
  };
  const params: Record<string, string> = { replyText: request.replyText };
  for (const [name, value] of Object.entries(sources)) {
    if (!declared.has(name)) continue;
    if (value === undefined) return { ok: false, detail: `E_CHAIN_FIELD: the record has no value for ${name}` };
    params[name] = value;
  }
  return { ok: true, params };
}

/**
 * The contract's no-echo rule: a quarantine reason may quote an assertion's resolved expected value,
 * so the text-bearing params (the reply and the source comment) are replaced by `<param name>`.
 */
const TEXT_PARAMS = ["replyText", "expected_sourcetext"] as const;
function redactReason(reason: string, params: Readonly<Record<string, string>>, names: readonly string[] = TEXT_PARAMS): string {
  let out = reason;
  for (const name of names) {
    const value = params[name];
    if (value === undefined || value === "") continue;
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) out = out.split(form).join(`<param ${name}>`);
  }
  return out;
}

/**
 * #608: a producing param is supplied by the caller and never echoed — if a reason (from the
 * producing run or a later one) quotes its value, it becomes `<param name>`.
 */
function redactProducerParams(reason: string, params: Readonly<Record<string, string>> | undefined): string {
  return params === undefined ? reason : redactReason(reason, params, Object.keys(params));
}

/** §5 step 5: the chain succeeded only when every request matched and every run was `ok`. */
export function chainSucceeded(result: JourneyChainResult): boolean {
  return result.unmatched.length === 0 && result.runs.every((run) => run.outcome === "ok");
}

/** The flags every run in the chain shares (environment, session, browser, allowlist, site policy). */
export interface RunJourneyChainOptions {
  readonly from: string;
  readonly to: string;
  /** The approved requests as raw JSON Lines (§4). */
  readonly requests: string;
  /**
   * #608: explicit params for the producing (discover) Journey, validated against its param schema
   * before anything runs. Absent means no params, exactly as the fixed `{}` was before.
   */
  readonly params?: Readonly<Record<string, string>>;
  /** The journeys directory. */
  readonly dir: string;
  readonly environment?: ResolvedJourneyEnvironment;
  readonly storageState?: string;
  readonly browser?: BrowserRunOptions;
  readonly emulation?: EmulationSpec;
  readonly browserPortFactory?: () => BrowserPort;
  readonly allow?: readonly string[];
  readonly siteGate?: SiteGateDeps;
  /**
   * Refuse a `from` or `to` Journey that is not promoted (`E_CHAIN_NOT_PROMOTED`) before anything
   * runs. The CLI sets it unless `--allow-draft`; MCP can never unset it (promoted-only, as run_journey).
   */
  readonly requirePromoted?: boolean;
}

function sharedRunOptions(opts: RunJourneyChainOptions): Partial<RunJourneyProgrammaticallyOptions> & { dir: string } {
  return {
    dir: opts.dir,
    ...(opts.environment === undefined ? {} : { environment: opts.environment }),
    ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    ...(opts.emulation === undefined ? {} : { emulation: opts.emulation }),
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(opts.allow === undefined ? {} : { allow: opts.allow }),
    ...(opts.siteGate === undefined ? {} : { siteGate: opts.siteGate }),
  };
}

/** §4 step 5: parse the request file as JSON Lines objects; field validation is `validateRequests`. */
function parseRequestObjects(text: string): HandoffRecord[] {
  const requests: HandoffRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]?.trim() ?? "";
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new JourneyChainError("E_CHAIN_REQUEST", `request line ${n + 1} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JourneyChainError("E_CHAIN_REQUEST", `request line ${n + 1} must be a JSON object`);
    }
    requests.push(parsed as HandoffRecord);
  }
  return requests;
}

/**
 * §1: the origins a `url` field may name — the run environment's allowlist, else the producer's
 * recorded site, plus its declared `metadata.allowedOrigins` and the run's `--allow`.
 */
function handoffOrigins(opts: RunJourneyChainOptions, from: Journey): string[] {
  const origins = new Set<string>();
  if (opts.environment !== undefined) for (const origin of opts.environment.allowedOrigins) origins.add(origin);
  else origins.add(from.recording.site);
  for (const origin of from.metadata.allowedOrigins ?? []) origins.add(origin);
  for (const origin of opts.allow ?? []) origins.add(origin);
  return [...origins];
}

/** §4/§5 no-echo rule: a param bound to a `text`/`url`/`path` field never appears in a reason. */
const REDACTED_FIELD_TYPES: readonly HandoffFieldType[] = ["text", "url", "path"];
function textBoundParams(inputs: HandoffInputsDecl, outputs: HandoffOutputsDecl): string[] {
  const names: string[] = [];
  for (const [param, binding] of Object.entries(inputs.bindings)) {
    const type = "record" in binding ? outputs.fields[binding.record]?.type : "request" in binding ? inputs.request.fields[binding.request]?.type : undefined;
    if (type !== undefined && REDACTED_FIELD_TYPES.includes(type)) names.push(param);
  }
  return names;
}

/** The `commentId`/`account` identity the §5 result names, read from a request when declared. */
function requestIdentity(bag: HandoffRecord): ChainUnmatched {
  return {
    commentId: typeof bag["commentId"] === "string" ? bag["commentId"] : "",
    account: typeof bag["account"] === "string" ? bag["account"] : "",
  };
}

/**
 * §4/§5 handoff branch: validate the records and requests with the pure `@jevitate/journey`
 * validators, match each valid request on `inputs.request.key` against the outputs key, and run `to`
 * once per match with the params `bindParams` resolves. A request matching an invalid or ambiguous
 * record is rejected (never unmatched, never run).
 */
async function runHandoffChain(
  inputs: HandoffInputsDecl,
  outputs: HandoffOutputsDecl,
  fromJourney: Journey,
  fromOutput: unknown,
  requestText: string,
  capturedAt: string,
  opts: RunJourneyChainOptions,
  shared: Partial<RunJourneyProgrammaticallyOptions> & { dir: string },
  runner: JourneyChainRunner,
): Promise<JourneyChainResult> {
  const ctx: HandoffContext = { allowedOrigins: handoffOrigins(opts, fromJourney) };
  const records = readHandoffRecords(outputs, fromOutput);
  if (records.length === 0) throw new JourneyChainError("E_CHAIN_EMPTY", `the producing Journey '${opts.from}' returned no records`);

  const outputKeys = outputKeyFields(outputs);
  const recordValidation = validateRecords(outputs, records, ctx);
  const byKey = new Map<string, HandoffRecord>();
  const rejectedByKey = new Map<string, HandoffRejection>();
  for (const record of recordValidation.valid) byKey.set(handoffKey(outputKeys, record), record);
  for (const rejection of recordValidation.rejected) if (!rejectedByKey.has(rejection.key)) rejectedByKey.set(rejection.key, rejection);

  const requestValidation = validateRequests(inputs, parseRequestObjects(requestText), ctx);
  const rejected: HandoffRejection[] = [...recordValidation.rejected, ...requestValidation.rejected];
  const redactors = textBoundParams(inputs, outputs);

  const runs: ChainRunResult[] = [];
  const unmatched: ChainUnmatched[] = [];
  for (const request of requestValidation.valid) {
    const key = handoffKey(inputs.request.key, request);
    const identity = requestIdentity(request);
    const record = byKey.get(key);
    if (record === undefined) {
      const rejection = rejectedByKey.get(key);
      if (rejection !== undefined) rejected.push({ key, reason: rejection.reason, errors: rejection.errors });
      else unmatched.push(identity);
      continue;
    }
    const params = bindParams(inputs, record, request);
    const stamp = { contract: inputs.accepts, fingerprint: recordFingerprint(outputs, record), capturedAt };
    try {
      const result = await runner({ ...shared, id: opts.to, params });
      runs.push({
        ...identity,
        outcome: result.outcome,
        ...stamp,
        ...("reason" in result ? { reason: redactProducerParams(redactReason(result.reason, params, redactors), opts.params) } : {}),
      });
    } catch (err) {
      runs.push({ ...identity, outcome: "error", ...stamp, reason: redactProducerParams(redactReason(err instanceof Error ? err.message : String(err), params, redactors), opts.params) });
    }
  }

  return { from: { journey: opts.from, outcome: "ok", records: records.length }, runs, unmatched, rejected };
}

/**
 * §5: run `from` once, join each approved request to the record with the same `commentId` and
 * `account`, and run `to` once per match with §3's params. Unmatched requests are listed and never
 * run. A failed `from` stops the chain (`E_CHAIN_FROM_FAILED`); a missing/zero record count stops it
 * (`E_CHAIN_EMPTY`); a malformed request refuses the whole file (`E_CHAIN_REQUEST`).
 */
export async function runJourneyChain(opts: RunJourneyChainOptions, deps: JourneyChainDeps = {}): Promise<JourneyChainResult> {
  const runner = deps.runJourney ?? runJourneyProgrammatically;
  const shared = sharedRunOptions(opts);

  const registry = new JourneyRegistry(new FsJourneyStore(opts.dir));
  const toJourney = await registry.get(opts.to);
  if (toJourney === null) throw new UnknownJourneyError(`unknown journey '${opts.to}'`);
  const inputs = toJourney.metadata.inputs;

  // §4: the compatibility check always loads the producing Journey, even when drafts are allowed.
  const fromJourney = await registry.get(opts.from);
  if (fromJourney === null) throw new UnknownJourneyError(`unknown journey '${opts.from}'`);

  // #608: the producing Journey's params are explicit and validated with `validateParams`' exact
  // missing/unknown semantics BEFORE any runner — so a mismatch never opens a browser.
  const producerParams: Record<string, string> = { ...(opts.params ?? {}) };
  try {
    validateParams(journeyParamSchema(fromJourney), producerParams);
  } catch (err) {
    if (err instanceof ParamValidationError) throw new JourneyChainError("E_CHAIN_PARAMS", err.message);
    throw err;
  }

  if (opts.requirePromoted === true) {
    for (const j of [fromJourney as Journey, toJourney]) {
      if (!j.metadata.promoted) throw new JourneyChainError("E_CHAIN_NOT_PROMOTED", `journey '${j.metadata.id}' is not promoted — a chain runs promoted Journeys (journey chain --allow-draft runs drafts on the CLI)`);
    }
  }

  let handoff: { inputs: HandoffInputsDecl; outputs: HandoffOutputsDecl } | undefined;
  if (inputs !== undefined) {
    const issues = checkCompatibility(fromJourney as Journey, toJourney);
    if (issues.length > 0) throw new JourneyChainError("E_HANDOFF_INCOMPATIBLE", issues.map((issue) => issue.message).join("; "));
    const outputs = (fromJourney as Journey).metadata.outputs;
    if (outputs === undefined) throw new JourneyChainError("E_HANDOFF_INCOMPATIBLE", `the producing Journey '${opts.from}' declares no outputs`);
    handoff = { inputs, outputs };
  }

  // 0.17.0 parses the fixed-key request file before anything runs; the handoff branch validates the
  // JSON Lines objects after the record set is known (§4 step 5).
  const requests = handoff === undefined ? parseChainRequests(opts.requests) : undefined;

  const fromResult = await runner({ ...shared, id: opts.from, params: producerParams });
  if (fromResult.outcome !== "ok") {
    const reason = "reason" in fromResult ? redactProducerParams(fromResult.reason, opts.params) : undefined;
    throw new JourneyChainError(
      "E_CHAIN_FROM_FAILED",
      `discover Journey '${opts.from}' did not run ok (${fromResult.outcome})${reason === undefined ? "" : `: ${reason}`}`,
    );
  }

  if (handoff !== undefined) {
    // §5: `capturedAt` is when the producing run finished, from the injectable clock.
    return runHandoffChain(handoff.inputs, handoff.outputs, fromJourney as Journey, fromResult.output, opts.requests, clock.nowIso(), opts, shared, runner);
  }

  const { count, records } = readRecords(fromResult.output);

  // §3: the reply Journey's declared params decide the one conditional mapping (`expected_parentid`).
  const declared = new Set(journeyParamSchema(toJourney).required);

  const byKey = new Map<string, ChainRecord>();
  for (const record of records) {
    if (record.commentId !== undefined && record.account !== undefined) byKey.set(recordKey(record.commentId, record.account), record);
  }

  const runs: ChainRunResult[] = [];
  const unmatched: ChainUnmatched[] = [];
  for (const request of requests ?? []) {
    const record = byKey.get(recordKey(request.commentId, request.account));
    if (record === undefined) {
      unmatched.push({ commentId: request.commentId, account: request.account });
      continue;
    }
    const mapped = chainParams(record, request, declared);
    if (!mapped.ok) {
      runs.push({ commentId: request.commentId, account: request.account, outcome: E_CHAIN_FIELD, reason: mapped.detail });
      continue;
    }
    try {
      const result = await runner({ ...shared, id: opts.to, params: mapped.params });
      runs.push({
        commentId: request.commentId,
        account: request.account,
        outcome: result.outcome,
        ...("reason" in result ? { reason: redactProducerParams(redactReason(result.reason, mapped.params), opts.params) } : {}),
      });
    } catch (err) {
      // A param the reply Journey does not take (or any other refusal) fails only this request; the
      // rest of the chain still runs (§5 step 4).
      runs.push({ commentId: request.commentId, account: request.account, outcome: "error", reason: redactProducerParams(redactReason(err instanceof Error ? err.message : String(err), mapped.params), opts.params) });
    }
  }

  return { from: { journey: opts.from, outcome: "ok", records: count }, runs, unmatched };
}
