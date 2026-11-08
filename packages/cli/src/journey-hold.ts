import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TargetTrustSchema } from "@jevitate/adjudicator";
import { clock, contentHash } from "@jevitate/domain";
import { FsInboxStore, HoldKindSchema, InboxItemAlreadyResolvedError, InboxItemNotFoundError, type BuildIdentity, type InboxItem } from "@jevitate/inbox";
import { ApprovalProvenanceSchema, FsJourneyStore, describeStep, flatJourneySteps, secretParamNames, type ApprovalProvenance, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession } from "@jevitate/playwright";
import type { Page } from "playwright";
import { detectAgentSignals, inMcpInvocation, osUserName, type ApprovalDeps } from "./approval-provenance.js";
import { sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { currentEngineInfo } from "./engine.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import { effectiveAllowedOrigins, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions, type RunJourneyResult } from "./journey-api.js";
import { applyJourneyEnvironment } from "./environments.js";
import { evidenceParamsDigest, loadEvidenceKey } from "./journey-run-evidence.js";
import { readRunCheckpoint, readSignedFile, restoreCheckpointUrl, maskCheckpointUrl, writeRunCheckpoint, writeSignedFile } from "./journey-run-checkpoint.js";
import { RunHeldError, RunHookError, registerRunHooks, type PendingAction, type RunHookContext, type RunHoldRequest, type RunHooks } from "./journey-run-hooks.js";
import { checkpointKeyPath } from "./journey-verify-checkpoint.js";
import { logsRoot } from "./project-dir.js";
import { reconcileLinkedJob, type ReconcileInput } from "./journey-reconcile.js";
import { missingSecretParams } from "./secret-params.js";
import type { TargetTrust } from "./run-mode.js";

/**
 * #793/#799 (docs/design/0.30.0-evidence-and-trust.md §5.4): durable holds for automation runs.
 *
 * A run whose `beforeWrite` hook asks for a hold stops before the pending action acts. The `onHold`
 * hook registered here (`registerHoldHooks`) makes it durable: a `HoldRecord` under
 * `.jevitate/logs/holds/<id>.json`, a value-free checkpoint beside it (journey-run-checkpoint.ts), both
 * signed with the #787 key and written atomically, and the inbox item a person sees (`queue_action`'s
 * store, kind `approval`, `handback` or `secret`, with the same id). The run then ends with
 * `RunHeldError` (`E_RUN_HELD`), which `heldOutcomeOf` reads as `{ outcome: "held", holdId }`.
 *
 * Who may answer (§5.2): only a person at a terminal. `approve_action` over MCP keeps refusing and never
 * touches a hold; `jevitate inbox approve <id>` refuses inside an MCP call and without a TTY on stdin
 * and stdout, and asks the person to type the hold's id back before it writes `answer` with `tty`
 * provenance. `jevitate inbox resume <id>` continues from the checkpoint, never repeating the steps
 * before the pending one, only if the Journey hash, the parameter digest, the target origin and the
 * pending action all still match (else `E_HOLD_BINDING`); an expired hold ends `inconclusive` with
 * `E_HOLD_EXPIRED`. Nothing in either file is a value.
 *
 * What it does not resolve (§5.5): someone with write access to `.jevitate/` and read access to the key
 * can write any of this; the mac only shows that the files were written by a holder of this user's key.
 */

export const HOLD_HOOK_OWNER = "journey-hold";
const HOLD_LABEL = "jevitate-hold/1";
/** A hold waits this long for a person by default (the #787 checkpoint's age limit). */
export const DEFAULT_HOLD_TTL_MS = 24 * 60 * 60 * 1000;
const HOLD_ID = /^hold-[0-9a-f]{16}$/;
const MAX_CONTROL = 200;

// --- The record (§5.4, exactly) -----------------------------------------------------------------------

export const HoldRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: HoldKindSchema,
  journey: z.strictObject({ id: z.string().min(1).max(256), hash: z.string().min(1).max(128) }),
  /** Keyed, as in RunEvidence (`evidenceParamsDigest`). */
  paramsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  target: z.strictObject({ origin: z.string().min(1).max(2048), trust: TargetTrustSchema }),
  pending: z.strictObject({
    step: z.number().int().min(1),
    control: z.string().min(1).max(MAX_CONTROL).optional(),
    write: z.strictObject({ method: z.string().min(1).max(16), path: z.string().min(1).max(2048) }).optional(),
  }),
  /** Path of the resumable run state, value-free: a file name in the holds directory. */
  checkpoint: z.string().regex(/^hold-[0-9a-f]{16}\.checkpoint\.json$/),
  createdAt: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  answer: z
    .strictObject({ decision: z.enum(["approved", "rejected"]), provenance: ApprovalProvenanceSchema, at: z.string().min(1).max(64) })
    .optional(),
});
export type HoldRecord = z.infer<typeof HoldRecordSchema>;

// --- Errors -------------------------------------------------------------------------------------------

export type HoldErrorCode =
  | "E_HOLD_NOT_FOUND"
  | "E_HOLD_INTEGRITY"
  | "E_HOLD_EXPIRED"
  | "E_HOLD_NOT_APPROVED"
  | "E_HOLD_REJECTED"
  | "E_HOLD_ANSWERED"
  | "E_HOLD_BINDING"
  | "E_HOLD_CHECKPOINT"
  | "E_HUMAN_APPROVAL_REQUIRED"
  | "E_APPROVAL_NOT_CONFIRMED"
  | "E_RECONCILE_ALREADY_DONE"
  | "E_RECONCILE_UNREADABLE";

/** A hold could not be answered or resumed. Every message is code-templated: names and steps, never a value. */
export class HoldError extends Error {
  override readonly name = "HoldError";
  constructor(
    readonly code: HoldErrorCode,
    message: string,
    /** For `E_HOLD_BINDING`: which bindings no longer match. */
    readonly mismatches: readonly HoldBinding[] = [],
  ) {
    super(message);
  }
  /** `E_HOLD_EXPIRED` and the #795 reconcile stops end the run `inconclusive` (2); every other code refuses before anything ran. */
  get outcome(): "inconclusive" | "refused" {
    return this.code === "E_HOLD_EXPIRED" || this.code === "E_RECONCILE_ALREADY_DONE" || this.code === "E_RECONCILE_UNREADABLE" ? "inconclusive" : "refused";
  }
}

// --- Paths and files ----------------------------------------------------------------------------------

/** `<project>/.jevitate/logs/holds` (or `~/.jevitate/logs/holds` outside a project). */
export function defaultHoldsDir(): string {
  return join(logsRoot(), "holds");
}

export function holdRecordPath(holdsDir: string, id: string): string {
  return join(holdsDir, `${id}.json`);
}

function checkpointName(id: string): string {
  return `${id}.checkpoint.json`;
}

export function isHoldId(id: string): boolean {
  return HOLD_ID.test(id);
}

function keyOf(keyFile: string): Buffer {
  const loaded = loadEvidenceKey(keyFile);
  if (!("key" in loaded)) throw new HoldError("E_HOLD_INTEGRITY", `the key ${keyFile} cannot be used (${loaded.problem})`);
  return loaded.key;
}

export function writeHoldRecord(holdsDir: string, id: string, key: Buffer, record: HoldRecord): void {
  writeSignedFile(holdRecordPath(holdsDir, id), key, HOLD_LABEL, HoldRecordSchema.parse(record));
}

/** The hold, checked against this user's key. Throws `E_HOLD_NOT_FOUND` or `E_HOLD_INTEGRITY`. */
export function readHoldRecord(holdsDir: string, id: string, key: Buffer): HoldRecord {
  if (!isHoldId(id)) throw new HoldError("E_HOLD_NOT_FOUND", `'${id.slice(0, 80)}' is not a hold id`);
  const read = readSignedFile(holdRecordPath(holdsDir, id), key, HOLD_LABEL, HoldRecordSchema);
  if (read.kind === "none") throw new HoldError("E_HOLD_NOT_FOUND", `no hold '${id}' in ${holdsDir}`);
  if (read.kind === "bad") throw new HoldError("E_HOLD_INTEGRITY", `the hold '${id}' cannot be trusted: ${read.detail}`);
  return read.body;
}

function isExpired(record: HoldRecord): boolean {
  const at = Date.parse(record.expiresAt);
  return !Number.isFinite(at) || clock.now() >= at;
}

// --- What is bound ------------------------------------------------------------------------------------

/** The pending action's control: the stored (template) step's description, never a resolved value. */
export function pendingControlOf(journey: Journey, step: number): string | undefined {
  const flat = flatJourneySteps(journey)[step - 1];
  if (flat === undefined) return undefined;
  const text = describeStep(flat.recorded.step).trim();
  return text === "" ? undefined : text.slice(0, MAX_CONTROL);
}

function originOf(url: string): string | undefined {
  try {
    const o = new URL(url).origin;
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

export type HoldBinding = "journey" | "params" | "target" | "pending";

export interface HoldBindingNow {
  readonly journeyHash: string;
  readonly paramsDigest: string;
  readonly origin: string;
  readonly pending: { readonly step: number; readonly control?: string | undefined };
}

/** Which of the record's bindings `now` no longer matches. Empty: the person approved exactly this. */
export function holdBindingMismatches(record: HoldRecord, now: HoldBindingNow): HoldBinding[] {
  const out: HoldBinding[] = [];
  if (record.journey.hash !== now.journeyHash) out.push("journey");
  if (record.paramsDigest !== now.paramsDigest) out.push("params");
  if (originOf(record.target.origin) === undefined || originOf(record.target.origin) !== originOf(now.origin)) out.push("target");
  if (record.pending.step !== now.pending.step || record.pending.control !== now.pending.control) out.push("pending");
  return out;
}

const BINDING_TEXT: Readonly<Record<HoldBinding, string>> = {
  journey: "the Journey changed since it was held (a changed Journey needs a new approval)",
  params: "the parameters differ from the ones it was held with",
  target: "the target origin differs from the one it was held on",
  pending: "the pending action differs from the one that was approved",
};

// --- The hook ------------------------------------------------------------------------------------------

export interface HoldHookOptions {
  /** Default `.jevitate/logs/holds` (`defaultHoldsDir`). */
  readonly holdsDir?: string;
  /** Default `~/.jevitate/verify-checkpoint.key` (#787). */
  readonly keyFile?: string;
  /** The inbox the person sees the hold in (`jevitate inbox list`, `jevitate ui`); absent: no inbox item. */
  readonly inboxDir?: string;
  readonly ttlMs?: number;
  /** The target's trust, as the run-mode gate resolved it. Default `unknown` (a hold happens in automation mode). */
  readonly trustOf?: (ctx: RunHookContext) => TargetTrust;
  readonly engine?: BuildIdentity;
}

const holdIds = new WeakMap<RunHoldRequest, string>();

/** The id of the hold a `RunHeldError` stopped at, when `onHold` made it durable. */
export function holdIdOf(err: unknown): string | undefined {
  return err instanceof RunHeldError ? holdIds.get(err.hold) : undefined;
}

export interface HeldOutcome {
  readonly outcome: "held";
  readonly code: "E_RUN_HELD";
  readonly holdId: string;
  readonly kind: RunHoldRequest["kind"];
  readonly step: number;
  readonly reason: string;
}

/** What a surface reports for a held run: `{ outcome: "held", holdId }`. Undefined for any other error, or a hold never made durable. */
export function heldOutcomeOf(err: unknown): HeldOutcome | undefined {
  const holdId = holdIdOf(err);
  if (holdId === undefined || !(err instanceof RunHeldError)) return undefined;
  return { outcome: "held", code: err.code, holdId, kind: err.hold.kind, step: err.extra.at, reason: err.hold.reason };
}

function pageUrlOf(ctx: PendingAction): string | undefined {
  try {
    const url = ctx.locator.page().url();
    return originOf(url) === undefined ? undefined : url;
  } catch {
    return undefined;
  }
}

async function persistHold(opts: HoldHookOptions, ctx: RunHookContext & PendingAction & { readonly hold: RunHoldRequest }): Promise<void> {
  const holdsDir = opts.holdsDir ?? defaultHoldsDir();
  const key = keyOf(opts.keyFile ?? checkpointKeyPath());
  const id = `hold-${randomBytes(8).toString("hex")}`;
  const hash = contentHash(ctx.journey);
  const pageUrl = pageUrlOf(ctx);
  const origin = originOf(ctx.target?.origin ?? "") ?? (pageUrl === undefined ? undefined : originOf(pageUrl)) ?? originOf(ctx.journey.recording.site);
  if (origin === undefined || pageUrl === undefined) throw new Error("the run cannot be held: the page it is on has no http(s) address to resume from");
  const now = clock.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + (opts.ttlMs ?? DEFAULT_HOLD_TTL_MS)).toISOString();
  const extracted = ctx.evidence?.observed().values ?? [];
  writeRunCheckpoint(join(holdsDir, checkpointName(id)), key, {
    version: 1,
    hold: id,
    journey: { id: ctx.journey.metadata.id, hash },
    step: ctx.step,
    url: maskCheckpointUrl(pageUrl, ctx.params, extracted),
    createdAt,
  });
  const control = pendingControlOf(ctx.journey, ctx.step);
  writeHoldRecord(holdsDir, id, key, {
    version: 1,
    kind: ctx.hold.kind,
    journey: { id: ctx.journey.metadata.id, hash },
    paramsDigest: evidenceParamsDigest(key, ctx.params, secretParamNames(ctx.journey, ctx.params)),
    target: { origin, trust: opts.trustOf?.(ctx) ?? "unknown" },
    pending: { step: ctx.step, ...(control === undefined ? {} : { control }) },
    checkpoint: checkpointName(id),
    createdAt,
    expiresAt,
  });
  if (opts.inboxDir !== undefined) {
    // The inbox face of the hold, as `queue_action` queues one: the reason is code-templated, never page text or a value.
    const item: InboxItem = {
      id,
      kind: ctx.hold.kind,
      status: "pending",
      run: id,
      journey: ctx.journey.metadata.id.slice(0, 256),
      step: String(ctx.step),
      reason: ctx.hold.reason,
      agent: ctx.channel ?? "jevitate",
      targetUrl: origin,
      holdId: id,
      hasScreenshot: false,
      thread: [],
      createdAt,
      ttlSec: Math.max(1, Math.ceil((opts.ttlMs ?? DEFAULT_HOLD_TTL_MS) / 1000)),
    };
    await new FsInboxStore(opts.inboxDir, opts.engine ?? currentEngineInfo()).enqueue(item);
  }
  holdIds.set(ctx.hold, id);
}

// --- Resume scope -------------------------------------------------------------------------------------

/**
 * §5.3: the person completing a resumed handback or secret hold, in the headed browser the resume opened.
 * Returns once they are done; the runner then checks the step's own `resume` assertion. Never given a value.
 */
export type HandbackPresenter = (prompt: string, page: Page) => Promise<void>;

interface ResumeScope {
  readonly id: string;
  readonly kind: HoldRecord["kind"];
  readonly journeyHash: string;
  readonly step: number;
  readonly control: string | undefined;
  /** Removes the hold: called once, as the approved action is about to act. */
  readonly consume: () => void;
  /** A handback or secret hold's person. */
  readonly presenter?: HandbackPresenter;
  firstWrite: number | undefined;
  taken?: boolean;
}

const resumeScope = new AsyncLocalStorage<ResumeScope>();

/**
 * For every `beforeWrite` hook that can hold (the run-mode gate, the sentinel): true when this is the
 * step a person approved and the run is that hold's resume, so the hook must not hold it again. Only
 * inside `resumeHold`, and only for the pending step of the Journey the person approved.
 */
export function isApprovedResumeStep(ctx: RunHookContext & PendingAction): boolean {
  const s = resumeScope.getStore();
  return s !== undefined && ctx.step === s.step && contentHash(ctx.journey) === s.journeyHash && pendingControlOf(ctx.journey, ctx.step) === s.control;
}

/**
 * §5.3: the handback or secret hold this resume continues, at its pending step: consumes the hold (one
 * resume, one completion) and returns the person who completes it. Undefined anywhere else, so the
 * caller holds again (a later handback is a new hold).
 */
export function takeApprovedHandback(ctx: Pick<RunHookContext, "journey"> & { readonly step: number }): HandbackPresenter | undefined {
  const s = resumeScope.getStore();
  if (s === undefined || s.kind === "approval" || s.taken === true || s.presenter === undefined) return undefined;
  if (ctx.step !== s.step || contentHash(ctx.journey) !== s.journeyHash || pendingControlOf(ctx.journey, ctx.step) !== s.control) return undefined;
  s.taken = true;
  s.consume();
  return s.presenter;
}

let registrations = 0;

function holdHooks(opts: HoldHookOptions): RunHooks {
  return {
    // During a resume, the first action that acts must be the approved one; it consumes the hold.
    beforeWrite: (ctx) => {
      const s = resumeScope.getStore();
      // A handback or secret hold is consumed at its own step (`takeApprovedHandback`), which is not a write.
      if (s === undefined || s.kind !== "approval" || s.firstWrite !== undefined) return undefined;
      s.firstWrite = ctx.step;
      if (!isApprovedResumeStep(ctx)) throw new HoldError("E_HOLD_BINDING", `the hold '${s.id}' cannot resume: ${BINDING_TEXT.pending}`, ["pending"]);
      s.consume();
      return undefined;
    },
    onHold: (ctx) => persistHold(opts, ctx),
  };
}

/**
 * Registers the hold hooks: `onHold` makes every hold durable, and a resumed run's approved step is let
 * through. Not registered at startup; the caller wires it (with its holds dir, inbox and trust).
 */
export function registerHoldHooks(opts: HoldHookOptions = {}): () => void {
  const off = registerRunHooks(HOLD_HOOK_OWNER, holdHooks(opts));
  registrations += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    registrations -= 1;
    off();
  };
}

// --- Approve, at a terminal only --------------------------------------------------------------------

export interface ApproveHoldRequest {
  readonly id: string;
  readonly holdsDir?: string;
  readonly keyFile?: string;
  readonly inboxDir?: string;
  readonly decision?: "approved" | "rejected";
  /** The terminal seam (`CliDeps.approval`); production reads the real process. */
  readonly approval?: ApprovalDeps;
  readonly engine?: BuildIdentity;
}

const NEEDS_PERSON =
  "approving a held run needs a person at a terminal: run `jevitate inbox approve <id>` in your own terminal and type the hold id when asked. An agent over MCP never approves (approve_action refuses), and a command without a TTY on stdin and stdout is refused";

/** True when a person can be asked here: not inside an MCP call, and stdin and stdout are TTYs. */
export function holdApprovalInteractive(approval: ApprovalDeps | undefined): boolean {
  if (inMcpInvocation()) return false;
  return (approval?.stdinIsTTY?.() ?? process.stdin.isTTY === true) && (approval?.stdoutIsTTY?.() ?? process.stdout.isTTY === true);
}

async function terminalQuestion(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolveAnswer) => {
      rl.once("close", () => resolveAnswer(""));
      rl.question(question).then(resolveAnswer, () => resolveAnswer(""));
    });
  } finally {
    rl.close();
  }
}

function holdSheet(id: string, r: HoldRecord): string {
  return [
    `Held run ${id} (${r.kind})`,
    `  Journey   ${r.journey.id}, content hash ${r.journey.hash.slice(0, 8)}…`,
    `  target    ${r.target.origin} (trust: ${r.target.trust})`,
    `  pending   step ${r.pending.step}${r.pending.control === undefined ? "" : `: ${r.pending.control}`}`,
    `  expires   ${r.expiresAt}`,
  ].join("\n");
}

/**
 * `jevitate inbox approve <id>`: a person at a terminal answers a hold. Refused (`E_HUMAN_APPROVAL_REQUIRED`)
 * inside an MCP call or without a TTY, before anything is read; the person types the hold id back (else
 * `E_APPROVAL_NOT_CONFIRMED`). Writes `answer` with `tty` provenance (agent marker names and the OS
 * user, never a value), then resolves the hold's inbox item.
 */
export async function approveHoldAtTerminal(req: ApproveHoldRequest): Promise<HoldRecord> {
  if (!holdApprovalInteractive(req.approval)) throw new HoldError("E_HUMAN_APPROVAL_REQUIRED", NEEDS_PERSON);
  if (!isHoldId(req.id)) throw new HoldError("E_HOLD_NOT_FOUND", `'${req.id.slice(0, 80)}' is not a hold id`);
  const holdsDir = req.holdsDir ?? defaultHoldsDir();
  const key = keyOf(req.keyFile ?? checkpointKeyPath());
  const record = readHoldRecord(holdsDir, req.id, key);
  if (isExpired(record)) throw new HoldError("E_HOLD_EXPIRED", `the hold '${req.id}' expired at ${record.expiresAt}; the run ends inconclusive. Run the Journey again to be asked again`);
  if (record.answer !== undefined) throw new HoldError("E_HOLD_ANSWERED", `the hold '${req.id}' was already ${record.answer.decision} at ${record.answer.at}`);
  const decision = req.decision ?? "approved";
  const verb = decision === "approved" ? "approve" : "reject";
  const ask = req.approval?.prompt ?? terminalQuestion;
  const typed = await ask(`${holdSheet(req.id, record)}\n${verb === "approve" ? "Approve" : "Reject"} this held action? Type the hold id (${req.id}) to ${verb} — anything else cancels: `);
  if (typed.trim() !== req.id) throw new HoldError("E_APPROVAL_NOT_CONFIRMED", `the typed confirmation did not match the hold '${req.id}' — nothing was ${decision}`);
  // Read again after the prompt: the answer binds what is on disk now, not what was shown a while ago.
  const current = readHoldRecord(holdsDir, req.id, key);
  if (current.answer !== undefined) throw new HoldError("E_HOLD_ANSWERED", `the hold '${req.id}' was answered while you were asked`);
  if (canonicalChanged(record, current)) throw new HoldError("E_HOLD_BINDING", `the hold '${req.id}' changed while you were asked; nothing was ${decision}`);
  const user = req.approval?.user === undefined ? osUserName() : req.approval.user();
  const provenance: ApprovalProvenance = {
    channel: "tty",
    agentSignals: detectAgentSignals(req.approval?.env ?? process.env, { stdin: true, stdout: true }),
    ...(user === undefined ? {} : { user }),
  };
  const answered: HoldRecord = { ...current, answer: { decision, provenance, at: clock.nowIso() } };
  writeHoldRecord(holdsDir, req.id, key, answered);
  if (req.inboxDir !== undefined) {
    const store = new FsInboxStore(req.inboxDir, req.engine ?? currentEngineInfo());
    const action = decision === "rejected" ? "reject" : current.kind === "approval" ? "approve" : "resume";
    try {
      await store.resolve(req.id, { channel: "human", action });
    } catch (err) {
      // The hold is the record of the answer; an inbox item already gone (swept, resolved in `jevitate ui`) changes nothing.
      if (!(err instanceof InboxItemNotFoundError || err instanceof InboxItemAlreadyResolvedError)) throw err;
    }
  }
  return answered;
}

function canonicalChanged(a: HoldRecord, b: HoldRecord): boolean {
  return JSON.stringify(HoldRecordSchema.parse(a)) !== JSON.stringify(HoldRecordSchema.parse(b));
}

// --- Resume -------------------------------------------------------------------------------------------

export interface ResumeHoldRequest {
  readonly id: string;
  readonly journeysDir: string;
  /** The run's parameters, given again: bound to the hold by its keyed digest. */
  readonly params: Readonly<Record<string, string>>;
  /** `--base-url`/`--env`: the target the resume runs on. Absent: the Journey's recorded site. */
  readonly environment?: ResolvedJourneyEnvironment | undefined;
  readonly holdsDir?: string;
  readonly keyFile?: string;
  readonly inboxDir?: string;
  readonly browser?: BrowserRunOptions;
  readonly storageState?: string;
  /** Testing seam: defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** Any further run options (a recorder, a policy); never `session`, `dir`, `id` or `params`. */
  readonly run?: Omit<Partial<RunJourneyProgrammaticallyOptions>, "session" | "dir" | "id" | "params" | "environment">;
  /** For a later hold the resumed run reaches. */
  readonly hooks?: HoldHookOptions;
  /** The terminal seam (`CliDeps.approval`): a handback or secret hold resumes only for a person at a terminal. */
  readonly approval?: ApprovalDeps;
  /** Testing seam: completes a handback or secret step in place of the person (default: asks them at the terminal, in a headed browser). */
  readonly presentHandback?: HandbackPresenter;
  /** #795: the project data dir holding `jobs.json` (default: none, so no done check is read). */
  readonly catalogDir?: string | null;
  /** #795 testing seam: the fresh-context reader of the job's done check. */
  readonly reconcileRead?: ReconcileInput["read"];
  /** #795: the browser port the reconcile reading opens its fresh context from. */
  readonly reconcileBrowserPort?: ReconcileInput["browserPort"];
}

export type ResumeHoldResult =
  | { readonly outcome: "resumed"; readonly holdId: string; readonly fromStep: number; readonly result: RunJourneyResult & { evidenceError?: string } }
  | { readonly outcome: "held"; readonly holdId: string; readonly fromStep: number; readonly held: HeldOutcome };

/** What a resume checks before anything opens. Exported for the refusal tests; `resumeHold` runs it first. */
export async function checkHoldForResume(req: ResumeHoldRequest): Promise<{ readonly record: HoldRecord; readonly url: string; readonly stored: Journey; readonly key: Buffer; readonly holdsDir: string }> {
  if (!isHoldId(req.id)) throw new HoldError("E_HOLD_NOT_FOUND", `'${req.id.slice(0, 80)}' is not a hold id`);
  const holdsDir = req.holdsDir ?? defaultHoldsDir();
  const key = keyOf(req.keyFile ?? checkpointKeyPath());
  const record = readHoldRecord(holdsDir, req.id, key);
  if (isExpired(record)) throw new HoldError("E_HOLD_EXPIRED", `the hold '${req.id}' expired at ${record.expiresAt}; the run ends inconclusive. Run the Journey again to be asked again`);
  // §5.3: a handback or secret hold is answered by a person completing it, so it needs one at a terminal, not an approval first.
  const completedByPerson = record.kind !== "approval" && record.answer === undefined;
  if (completedByPerson && !holdApprovalInteractive(req.approval)) {
    throw new HoldError("E_HUMAN_APPROVAL_REQUIRED", `the hold '${req.id}' waits for a person to complete a ${record.kind} step: run \`jevitate inbox resume ${req.id}\` in your own terminal, which opens the browser for you. An agent over MCP never completes it, and a command without a TTY on stdin and stdout is refused`);
  }
  if (record.answer === undefined && !completedByPerson) throw new HoldError("E_HOLD_NOT_APPROVED", `the hold '${req.id}' has no answer yet: a person approves it with \`jevitate inbox approve ${req.id}\` at a terminal`);
  if (record.answer !== undefined && record.answer.decision === "rejected") throw new HoldError("E_HOLD_REJECTED", `the hold '${req.id}' was rejected at ${record.answer.at}; the held action does not run`);
  if (record.answer !== undefined && record.answer.provenance.channel !== "tty") throw new HoldError("E_HOLD_NOT_APPROVED", `the hold '${req.id}' was not approved by a person at a terminal (channel ${record.answer.provenance.channel})`);
  const cp = readRunCheckpoint(join(holdsDir, record.checkpoint), key);
  if (cp.kind === "none") throw new HoldError("E_HOLD_CHECKPOINT", `the hold '${req.id}' has no checkpoint to resume from`);
  if (cp.kind === "bad") throw new HoldError("E_HOLD_INTEGRITY", `the checkpoint of the hold '${req.id}' cannot be trusted: ${cp.detail}`);
  if (cp.body.hold !== req.id || cp.body.journey.id !== record.journey.id) throw new HoldError("E_HOLD_INTEGRITY", `the checkpoint of the hold '${req.id}' belongs to another hold`);
  const stored = await new FsJourneyStore(req.journeysDir).get(record.journey.id);
  if (stored === null) throw new HoldError("E_HOLD_BINDING", `the hold '${req.id}' cannot resume: the Journey '${record.journey.id}' is not in ${req.journeysDir}`, ["journey"]);
  const now: HoldBindingNow = {
    journeyHash: contentHash(stored),
    paramsDigest: evidenceParamsDigest(key, req.params, secretParamNames(stored, req.params)),
    origin: req.environment?.baseUrl ?? stored.recording.site,
    pending: { step: cp.body.step, control: pendingControlOf(stored, cp.body.step) },
  };
  const mismatches = holdBindingMismatches(record, now);
  if (cp.body.journey.hash !== record.journey.hash && !mismatches.includes("journey")) mismatches.push("journey");
  if (mismatches.length > 0) throw new HoldError("E_HOLD_BINDING", `the hold '${req.id}' cannot resume: ${mismatches.map((m) => BINDING_TEXT[m]).join("; ")}`, mismatches);
  const restored = restoreCheckpointUrl(cp.body.url, req.params);
  if ("problem" in restored) throw new HoldError("E_HOLD_CHECKPOINT", `the hold '${req.id}' cannot resume: ${restored.problem}`);
  if (originOf(restored.url) !== originOf(record.target.origin)) throw new HoldError("E_HOLD_BINDING", `the hold '${req.id}' cannot resume: ${BINDING_TEXT.target}`, ["target"]);
  return { record, url: restored.url, stored, key, holdsDir };
}

/**
 * `jevitate inbox resume <id>`: continues a held run from its checkpoint. Checks every binding before a
 * browser opens, then opens the target at the page the run was held on and replays from the pending
 * step: the steps before it are skipped, never re-run. The approved action consumes the hold as it is
 * about to act, so one approval lets it act once. A later hold the run reaches is made durable as any
 * other (`outcome: "held"`).
 */
export async function resumeHold(req: ResumeHoldRequest): Promise<ResumeHoldResult> {
  const { record, url, stored, holdsDir } = await checkHoldForResume(req);
  const fromStep = record.pending.step;
  const env = req.environment;
  // #795: the job's done check is read first, in a fresh context. A job that already reads true is not resumed
  // (the pending write would be repeated); a job with no done check resumes as before. The hold is left in place.
  if (req.catalogDir !== undefined) {
    const reconciled = await reconcileLinkedJob({
      catalogDir: req.catalogDir,
      journeysDir: req.journeysDir,
      journey: stored,
      auth: req.storageState === undefined ? {} : { storageState: req.storageState },
      origin: env?.baseUrl ?? stored.recording.site,
      params: req.params,
      browserPort: req.reconcileBrowserPort,
      read: req.reconcileRead,
    });
    if (!reconciled.proceed) throw new HoldError(reconciled.code, reconciled.message);
  }
  const allowedOrigins = effectiveAllowedOrigins(applyJourneyEnvironment(stored, env), env, req.run?.allow ?? []);
  const port = (req.browserPortFactory ?? (() => new PlaywrightBrowserPort()))();
  // §5.3: a person completes a handback or secret step in a browser they can see.
  const handback = record.kind !== "approval";
  const presenter: HandbackPresenter | undefined = !handback
    ? undefined
    : (req.presentHandback ??
      (async (prompt) => {
        const ask = req.approval?.prompt ?? terminalQuestion;
        await ask(`${prompt}\nComplete this step in the browser window, then press Enter here: `);
      }));
  const browser: BrowserRunOptions | undefined = handback && req.presentHandback === undefined ? { ...req.browser, headed: true } : req.browser;
  const session: BrowserSession = await port.open({
    ...sessionLaunchOptions(browser),
    allowedOrigins,
    baseUrl: env?.baseUrl ?? stored.recording.site,
    ...(req.storageState === undefined ? {} : { storageState: req.storageState }),
  });
  const scope: ResumeScope = {
    id: req.id,
    kind: record.kind,
    ...(presenter === undefined ? {} : { presenter }),
    journeyHash: record.journey.hash,
    step: fromStep,
    control: record.pending.control,
    firstWrite: undefined,
    consume: () => {
      for (const f of [holdRecordPath(holdsDir, req.id), join(holdsDir, record.checkpoint)]) {
        try {
          unlinkSync(f);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    },
  };
  // Without a registration the resume still lets its approved step through and keeps a later hold durable.
  const off = registrations === 0 ? registerRunHooks(`${HOLD_HOOK_OWNER}-resume`, holdHooks({ holdsDir, ...(req.keyFile === undefined ? {} : { keyFile: req.keyFile }), ...(req.inboxDir === undefined ? {} : { inboxDir: req.inboxDir }), ...req.hooks })) : undefined;
  try {
    await session.page.goto(url, { waitUntil: "load" });
    const result = await resumeScope.run(scope, () =>
      runJourneyProgrammatically({
        ...req.run,
        dir: req.journeysDir,
        id: record.journey.id,
        params: { ...req.params },
        session,
        // The runner continues at the held step; the steps before it are not run again (journey-runner.ts `resumeAt`).
        resumeAtStep: fromStep,
        // A secret hold: the secret parameters nobody supplied are still the person's to type.
        ...(record.kind === "secret" ? { heldSecretParams: missingSecretParams(stored, req.params) } : {}),
        ...(env === undefined ? {} : { environment: env }),
      }),
    );
    return { outcome: "resumed", holdId: req.id, fromStep, result };
  } catch (err) {
    if (err instanceof RunHookError && err.cause instanceof HoldError) throw err.cause;
    const held = heldOutcomeOf(err);
    if (held !== undefined) return { outcome: "held", holdId: req.id, fromStep, held };
    throw err;
  } finally {
    off?.();
    await session.close();
  }
}
