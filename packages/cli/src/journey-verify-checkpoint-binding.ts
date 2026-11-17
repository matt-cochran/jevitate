import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { clock } from "@jevitate/domain";
import { MAX_TARGETED_RELAXATIONS, type MutationFailedSite, type MutationPlan, type MutationRunResult } from "@jevitate/journey";
import { mutationErrored } from "@jevitate/adjudicator";
import { systemProcessTable } from "@jevitate/playwright";
import { LEGACY_SENSITIVE_WORD, MUTATION_PROOF_VERDICTS } from "./journey-verify-report.js";

/**
 * The checkpoint file's shape, its keyed bindings and the HMAC digests behind it (split out of
 * `journey-verify-checkpoint.ts`, which re-exports every name here). A leaf: it imports no other
 * checkpoint module, so the store, progress and session layers can share it without a cycle.
 */
/** How old a reused result may be. An app changes under an old result, and nothing here can see that. */
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A clock can step back this far before a timestamp ahead of it reads as damage. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** What a refused targeted proof says when its own wording, which is not stored, is gone. */
export const REFUSAL_NOT_KEPT = "refused before the resume; its wording is not kept in the checkpoint";

/** What a refused targeted proof keeps, by class: the bound is the one refusal `suggestTargetedProofPlan` reads, and the app wrote nothing in it. */
const REFUSAL_CLASSES = ["relaxation-bound", "other"] as const;
const BOUND_REFUSAL = `relaxation bound ${MAX_TARGETED_RELAXATIONS} reached`;

const SITE_KEY = /^(?:step:[1-9][0-9]*|step-request:[1-9][0-9]*:[0-9]+|end-state:[0-9]+)$/;
const siteKey = z.string().regex(SITE_KEY);
const outcome = z.enum(["passed", "failed", "not-applied", "error"]);
const count = z.number().int().nonnegative();
const position = z.number().int().positive();
const iso = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const failedSite = z.discriminatedUnion("where", [
  z.strictObject({ where: z.literal("step"), step: position, postcondition: z.boolean() }),
  z.strictObject({ where: z.literal("step-request"), step: position, checkIndex: count }),
  z.strictObject({ where: z.literal("end-state"), index: count }),
  z.strictObject({ where: z.literal("unevaluable") }),
]);
const failedSites = z.array(failedSite);
const waitsCut = z.array(siteKey).optional();

/**
 * The replay kinds this build knows how to re-check. A kind is a record's name, not a field, so a new kind of
 * replay in the proof adds a name here and a `runReplay` call; a file naming any other kind is refused.
 */
export const REPLAY_RECORD_KINDS: readonly string[] = ["first", "relaxed", "targeted", "control", "targeted-control", "at-base-time", "rerun"];

/** Why a replay may have decided another, by class: no site, request or page text. */
const ISOLATION_NOTES = ["write-open", "independence-write-open", "control-write-open", "base-write-open", "state-crossed", "state-stuck", "independence-errored", "siblings-undecided"] as const;
export type IsolationNote = (typeof ISOLATION_NOTES)[number];

/** One replay a pair ran, whatever its kind: how it ended, where, when it got there, and what it left open. */
const replayRecord = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z-]*$/),
  outcome,
  failedSites,
  reachedMs: z.array(z.number().nonnegative().nullable()),
  endStateReachedMs: z.number().nonnegative().optional(),
  writesInFlightAtClose: count,
});

const atBaseTime = z.strictObject({ outcome, failedSites }).optional();

const pairRecord = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["skip", "block-write", "stale-value", "swap-param", "truncate-param", "guard-param"]),
  step: position,
  param: z.string().optional(),
  source: z.enum(["reviewed", "option", "generated"]).optional(),
  outcome,
  failedSites,
  waitsCut,
  relaxed: z.strictObject({ outcome, failedSites, waitsCut, atBaseTime }).optional(),
  control: outcome.optional(),
  /** A reading that needed a control kept none, because the verdict could no longer change. A resume runs such a pair again (`reusableOnResume`). */
  controlSkipped: z.literal(true).optional(),
  atBaseTime,
  targeted: z
    .array(
      z.strictObject({
        site: siteKey,
        relaxedSites: z.array(siteKey),
        outcome,
        failedSites,
        refused: z.enum(REFUSAL_CLASSES).optional(),
        control: outcome.optional(),
        declared: z.literal(true).optional(),
      }),
    )
    .optional(),
  retries: count,
  finishedAt: iso,
  /** Every replay of this pair, each re-checked against a re-measured base. */
  replays: z.array(replayRecord),
});

const bodySchema = z.strictObject({
  /** 2: floors held every replay and controls match both ways, so a file of the older experiment is refused, not misread. */
  schema: z.literal(2),
  journeyId: z.string().min(1),
  journeyHash: z.string().min(1),
  planDigest: digest,
  bindings: z.strictObject({ params: digest, hook: digest, origin: digest, browser: digest }),
  build: z.strictObject({ version: z.string(), commit: z.string(), builtAt: z.string(), tree: z.string() }),
  total: count,
  completed: z.array(pairRecord),
  phase: z.enum(["base", "independence", "pairs", "disagreements", "closing"]),
  /**
   * How this run's independence replay came out. Never reused: it answers whether state crosses from the
   * base just measured, so a resume runs it again against its own base. Null until it has run.
   */
  independence: z.enum(["passed", "hold-breaks-claim"]).nullable(),
  currentPair: z.string().nullable(),
  replay: count,
  startedAt: iso,
  updatedAt: iso,
  state: z.enum(["running", "interrupted", "finished"]),
  /** Written in today's word; a 0.29.0 receipt's legacy word still parses (its mac covers it as written) and reads as `sensitive`. */
  verdict: z.union([z.enum(MUTATION_PROOF_VERDICTS), z.literal(LEGACY_SENSITIVE_WORD)]).optional(),
  /** It finished `inconclusive` on errored replays and nothing else, the independence replay's included, so a resume can run those again. */
  errorGap: z.literal(true).optional(),
  reusedPairs: count,
  taint: z.strictObject({ restoreFailed: z.boolean(), notIsolatedBy: z.string().nullable(), isolation: z.enum(ISOLATION_NOTES).nullable() }),
  verifier: z.strictObject({ pid: position, startToken: z.string(), host: z.string() }),
});
export const fileSchema = z.strictObject({ body: bodySchema, mac: digest });

export type CheckpointBody = z.infer<typeof bodySchema>;
export type CheckpointPair = z.infer<typeof pairRecord>;

/** Why a resume was refused. Each is checked before any browser opens, but for `base-failed`, `pace` and `isolation`, which need the re-measured base. */
export type ResumeRefusalReason =
  | "no-checkpoint"
  | "not-regular-file"
  | "corrupt"
  | "integrity"
  | "key-unavailable"
  | "finished"
  | "live-verifier"
  | "other-host"
  | "journey-hash"
  | "mutation-plan"
  | "params"
  | "hook"
  | "origin"
  | "browser"
  | "cli-build"
  | "too-old"
  | "unknown-record"
  | "not-writable"
  | "base-failed"
  | "pace"
  | "isolation";

/**
 * A resume that will not run. It never starts over, and a plain `--mutate` is the way to begin again.
 * Refused before its claim, the checkpoint stays as it was. `base-failed`, `pace` and `isolation` come
 * after the claim wrote it: its finished results stand, but it no longer says `finished`, and an
 * `independence-errored` note is gone. That is harmless: the next resume runs the independence replay again.
 */
export class JourneyVerifyResumeRefusedError extends Error {
  readonly code = "E_JOURNEY_VERIFY_RESUME_REFUSED";
  constructor(
    readonly reason: ResumeRefusalReason,
    detail: string,
  ) {
    super(`journey verify --resume refused (${reason}): ${detail}. Nothing was reused and no verdict was written; run --mutate without --resume to start again`);
    this.name = "JourneyVerifyResumeRefusedError";
  }
}

/** A file's text, only ever to digest under the key. Follows a link, as the run will; anything but a regular file binds as nothing and cannot block. */
function bytesToBind(file: string | undefined): string | null {
  try {
    return file !== undefined && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
  } catch {
    // The run itself reports a file it cannot load.
    return null;
  }
}

/** `<name>=<file>` with the file's bytes as a digest: the session a fixture step authenticates as is what binds, and the same path can hold another login. */
function fixtureIdentityBinding(spec: string): { readonly spec: string; readonly digest: string | null } {
  const bytes = bytesToBind(spec.slice(spec.indexOf("=") + 1).trim());
  return { spec, digest: bytes === null ? null : createHash("sha256").update(bytes).digest("hex") };
}

/** What the hooks' results can depend on that this process can see: their text and limits, and the fixture files' bytes. A script a hook runs is not read. */
export function hookBindingOf(flags: { readonly fixtures?: string; readonly before?: string; readonly after?: string; readonly allowShellHooks?: boolean; readonly hookTimeoutMs?: string; readonly fixtureIdentity?: readonly string[] }, environmentFixtures: string | undefined): unknown {
  return {
    before: flags.before,
    after: flags.after,
    allowShellHooks: flags.allowShellHooks === true,
    hookTimeoutMs: flags.hookTimeoutMs,
    fixtures: flags.fixtures,
    content: bytesToBind(flags.fixtures),
    environmentFixtures,
    environmentContent: bytesToBind(environmentFixtures),
    fixtureIdentity: flags.fixtureIdentity?.map(fixtureIdentityBinding),
  };
}

/** The browser's settings and the session a replay starts from: the file's bytes too, since the same path can hold another login. */
export function browserBindingOf(browser: unknown, emulation: unknown, storageState: string | undefined, secretFields: readonly string[] | undefined): unknown {
  return { browser, emulation, storageState, session: bytesToBind(storageState), secretFields };
}

/** A deterministic text for a value: object keys sorted, `undefined` dropped, as JSON has it. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

export function keyed(key: Buffer, label: string, value: unknown): string {
  return createHmac("sha256", key).update(`jevitate-verify-checkpoint/1\0${label}\0`).update(canonicalJson(value) ?? "null").digest("hex");
}

/** The plan's ids and shape. It holds names and never a value, so it is a plain hash: a reader with no key can compare it. */
export function mutationPlanDigest(plan: MutationPlan): string {
  const mutations = plan.mutations.map((m) => ({ kind: m.kind, step: m.step, id: m.id, param: m.param, source: m.source }));
  const pairs = plan.pairs.map((p) => ({ site: p.site, mutation: p.mutation, declared: p.declared }));
  return createHash("sha256").update(canonicalJson({ mutations, pairs })).digest("hex");
}

export function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function macMatches(key: Buffer, body: CheckpointBody, mac: string): boolean {
  return timingSafeEqual(Buffer.from(keyed(key, "file", body), "hex"), Buffer.from(mac, "hex"));
}

export type VerifierState = "live" | "exited" | "stale";

/** A zombie answers `kill(pid, 0)`, but it runs nothing. */
function isZombie(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    return false;
  }
}

/** This process, by pid and the kernel's start time for it: a reused pid has another start time. */
export function currentVerifierIdentity(): CheckpointBody["verifier"] {
  return { pid: process.pid, startToken: systemProcessTable().startOf(process.pid) ?? "0", host: hostname() };
}

/**
 * live: the recorded process runs, with the recorded start token, and its proof has not ended. exited:
 * the proof ended, or the process is gone. stale: a process runs under that pid with another start token
 * (the pid was reused), or the record is from another host, where this one cannot check it.
 * Where the platform gives no start time (token "0"), a running pid counts as live: age ends that.
 */
export function verifierStateOf(body: Pick<CheckpointBody, "state" | "verifier">, startOf: (pid: number) => string | undefined = (pid) => systemProcessTable().startOf(pid)): VerifierState {
  if (body.state !== "running") return "exited";
  if (body.verifier.host !== hostname()) return "stale";
  const token = startOf(body.verifier.pid);
  if (token === undefined || isZombie(body.verifier.pid)) return "exited";
  return token === body.verifier.startToken ? "live" : "stale";
}

/** The oldest time a reused result was measured at. */
function oldestResultMs(body: CheckpointBody): number {
  return Math.min(Date.parse(body.updatedAt), ...body.completed.map((p) => Date.parse(p.finishedAt)));
}

export function ageRefusal(body: CheckpointBody): string | undefined {
  const now = clock.now();
  if (Date.parse(body.updatedAt) > now + CLOCK_SKEW_MS) return "its last update is in the future";
  const age = now - oldestResultMs(body);
  return age > CHECKPOINT_MAX_AGE_MS ? `its oldest result is ${Math.round(age / 3_600_000)}h old, over the ${CHECKPOINT_MAX_AGE_MS / 3_600_000}h limit` : undefined;
}

export function unknownRecordKind(body: CheckpointBody): string | undefined {
  return body.completed.flatMap((p) => p.replays).find((r) => !REPLAY_RECORD_KINDS.includes(r.kind))?.kind;
}

/**
 * What a resume may reuse. An errored pair proved nothing. A pair that skipped its control stands on
 * "the verdict is already decided", and an errored pair is one reason for that, which the resume then
 * takes away: reused, its unvouched reading could turn the proof `proven`. So it runs again, whole,
 * deciding afresh whether its control is needed. The control alone cannot be run on the old result: it has to reach
 * each site no sooner than the replay it answers for did (`matchTo`), and a checkpoint keeps no arrivals.
 */
export const reusableOnResume = (pair: CheckpointPair): boolean => !mutationErrored(reusedProofFields(pair)) && pair.controlSkipped !== true;

/** A proof that ended on errored replays has a gap a resume can fill. Any other finished proof has said all it can. */
export const finishedForGood = (body: Pick<CheckpointBody, "state" | "verdict" | "errorGap">): boolean => body.state === "finished" && !(body.verdict === "inconclusive" && body.errorGap === true);

/** The storable form of a refusal: its class, and none of its wording. */
export function storableRefusal(refused: string): (typeof REFUSAL_CLASSES)[number] {
  return refused === BOUND_REFUSAL ? "relaxation-bound" : "other";
}

export const structuredSites = (sites: readonly MutationFailedSite[]): MutationFailedSite[] =>
  sites.map((f): MutationFailedSite =>
    f.where === "step" ? { where: "step", step: f.step, postcondition: f.postcondition } : f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );

export const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));

/** The result the adjudicator's rules read (`classifyMutation`, the proof's verdict), as the uninterrupted proof gave them. */
export function reusedProofFields(pair: CheckpointPair): Pick<MutationRunResult, "outcome" | "failedSites"> & Partial<Pick<MutationRunResult, "waitsCut" | "relaxed" | "targeted" | "control" | "atBaseTime">> {
  return {
    outcome: pair.outcome,
    failedSites: pair.failedSites,
    ...optional("waitsCut", pair.waitsCut),
    ...optional("relaxed", pair.relaxed),
    ...optional("control", pair.control),
    ...optional("atBaseTime", pair.atBaseTime),
    ...optional(
      "targeted",
      pair.targeted?.map(({ refused, ...t }) => ({ ...t, ...optional("refused", refused === undefined ? undefined : refused === "relaxation-bound" ? BOUND_REFUSAL : REFUSAL_NOT_KEPT) })),
    ),
  };
}
