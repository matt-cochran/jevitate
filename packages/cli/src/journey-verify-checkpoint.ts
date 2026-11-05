import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { clock } from "@jevitate/domain";
import {
  assertionSiteKey,
  classifyMutation,
  needsRelaxedReplay,
  sitesReachedEarly,
  thinSites,
  type Journey,
  type JourneyAssertionSite,
  type JourneyMutation,
  type MutationFailedSite,
  type MutationPlan,
  type MutationProofVerdict,
  type MutationRunResult,
  type ReplayPace,
  type TargetedProof,
} from "@jevitate/journey";
import { systemProcessTable } from "@jevitate/playwright";
import { homeDataRoot } from "./project-dir.js";

/**
 * #787: the durable progress of `journey verify --mutate`, one small file per Journey and journey
 * store under `<project>/.jevitate/logs/verify-progress/`, replaced atomically as the proof moves.
 * A "pair" here is one planned mutation with all its replays (first, relaxed, control, targeted),
 * since that is the unit of work a proof finishes: `pairs` in the plan are site↔mutation links.
 *
 * What it stores is what a resumed verdict needs and nothing the app or the operator wrote: outcome
 * classes, structured failed sites, site keys, mutation ids, timings and counts. Never a `reason`, a
 * blocked write's path, hook text, a parameter value or a Journey value. Hooks, params, origins and
 * browser settings are bound by HMAC-SHA-256 under a random key kept in `~/.jevitate/` (0600), never in
 * the project: a plain hash of a short secret parameter could be guessed offline from this file. The
 * same key signs the file, so a change by someone who can write to `.jevitate/` but cannot read the
 * home key refuses the resume. The MAC proves the file came from this user's own runs; it does not
 * stop that user's own processes, which can read the key, nor a rollback to an older genuine file.
 */

/** How old a reused result may be. An app changes under an old result, and nothing here can see that. */
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Far above any real checkpoint. A larger file is not one. */
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
/** A clock can step back this far before a timestamp ahead of it reads as damage. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Opening what `lstat` just called a file must not block or follow a link, if it was swapped since. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
/** What a refused targeted proof says when its own wording, which is not stored, is gone. */
export const REFUSAL_NOT_KEPT = "refused before the resume; its wording is not kept in the checkpoint";
/** What a retry's error says on a reused pair: errors can quote the app, so only their count is stored. */
export const RETRY_REASON_NOT_KEPT = "not kept in the checkpoint";
/** The only refusal wordings `suggestTargetedProofPlan` reads. They hold a number or a site key, nothing the app wrote. */
const REFUSALS_KEPT: readonly RegExp[] = [/^relaxation bound [0-9]+ reached$/, /^step-request:[1-9][0-9]*:[0-9]+ is not a step postcondition$/];

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
/** Whose failure a control already answers for, or that the proof never reads as thin. Any other kind, a new one too, gets the thin check. */
const NOT_THIN_CHECKED: ReadonlySet<string> = new Set(["targeted", "control", "targeted-control", "at-base-time"]);

/** Why a replay may have decided another, by class: no site, request or page text. */
const ISOLATION_NOTES = ["write-open", "base-write-open", "state-crossed", "state-stuck", "independence-errored", "siblings-undecided"] as const;
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
  /** A reading that needed a control kept none, because the verdict could no longer change. */
  controlSkipped: z.literal(true).optional(),
  atBaseTime,
  targeted: z
    .array(
      z.strictObject({
        site: siteKey,
        relaxedSites: z.array(siteKey),
        outcome,
        failedSites,
        refused: z
          .string()
          .refine((s) => s === REFUSAL_NOT_KEPT || REFUSALS_KEPT.some((kept) => kept.test(s)))
          .optional(),
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
  verdict: z.enum(["proven", "insensitive", "inconclusive"]).optional(),
  reusedPairs: count,
  taint: z.strictObject({ restoreFailed: z.boolean(), notIsolatedBy: z.string().nullable(), isolation: z.enum(ISOLATION_NOTES).nullable() }),
  verifier: z.strictObject({ pid: position, startToken: z.string(), host: z.string() }),
});
const fileSchema = z.strictObject({ body: bodySchema, mac: digest });

export type CheckpointBody = z.infer<typeof bodySchema>;
export type CheckpointPair = z.infer<typeof pairRecord>;
export type CheckpointReplay = CheckpointPair["replays"][number];

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

/** A resume that will not run. It never starts over: the checkpoint stays as it was, and a plain `--mutate` is the way to begin again. */
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

/** What a proof's checkpoint is bound to, from the command that runs it. Everything but `build` is only ever digested. */
export interface ProofCheckpointRequest {
  readonly path: string;
  readonly keyFile: string;
  readonly resume: boolean;
  readonly build: CheckpointBody["build"];
  readonly config: { readonly hook: unknown; readonly origin: unknown; readonly browser: unknown };
  /** A short, value-free line for the operator: why this run keeps no progress, or what it replaced or reused. */
  readonly onNotice?: (text: string) => void;
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
    fixtureIdentity: flags.fixtureIdentity,
  };
}

/** The browser's settings and the session a replay starts from: the file's bytes too, since the same path can hold another login. */
export function browserBindingOf(browser: unknown, emulation: unknown, storageState: string | undefined, secretFields: readonly string[] | undefined): unknown {
  return { browser, emulation, storageState, session: bytesToBind(storageState), secretFields };
}

/** `<project or home>/logs/verify-progress/<id>.<store>.json`. The store's digest keeps two stores' same-named Journeys apart. */
export function verifyCheckpointPath(dataRoot: string, journeysDir: string, id: string): string {
  const store = createHash("sha256").update(journeysDir).digest("hex").slice(0, 12);
  return join(dataRoot, "logs", "verify-progress", `${encodeURIComponent(id)}.${store}.json`);
}

/** `~/.jevitate/verify-checkpoint.key`: outside every project, so no repo or artifact can carry it. */
export function checkpointKeyPath(): string {
  return join(homeDataRoot(), "verify-checkpoint.key");
}

/** A deterministic text for a value: object keys sorted, `undefined` dropped, as JSON has it. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

function keyed(key: Buffer, label: string, value: unknown): string {
  return createHmac("sha256", key).update(`jevitate-verify-checkpoint/1\0${label}\0`).update(canonicalJson(value) ?? "null").digest("hex");
}

/** The plan's ids and shape. It holds names and never a value, so it is a plain hash: a reader with no key can compare it. */
export function mutationPlanDigest(plan: MutationPlan): string {
  const mutations = plan.mutations.map((m) => ({ kind: m.kind, step: m.step, id: m.id, param: m.param, source: m.source }));
  const pairs = plan.pairs.map((p) => ({ site: p.site, mutation: p.mutation, declared: p.declared }));
  return createHash("sha256").update(canonicalJson({ mutations, pairs })).digest("hex");
}

const KEY_TEXT = /^[0-9a-f]{64}$/;

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** The key, or why it cannot be trusted. A key anyone else can read or write binds nothing. */
function readCheckpointKey(keyFile: string): { readonly key: Buffer } | { readonly missing: true } | { readonly problem: string } {
  let fd: number | undefined;
  try {
    if (!lstatSync(keyFile).isFile()) return { problem: "it is not a regular file" };
    fd = openSync(keyFile, READ_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== 64) return { problem: "it is not a key this version wrote" };
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) return { problem: "group or others can reach it (it must be mode 0600)" };
    const uid = ownerUid();
    if (uid !== undefined && opened.uid !== uid) return { problem: "another user owns it" };
    const bytes = Buffer.alloc(64);
    readSync(fd, bytes, 0, 64, 0);
    const text = bytes.toString("utf8");
    return KEY_TEXT.test(text) ? { key: Buffer.from(text, "hex") } : { problem: "it is not a key this version wrote" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { problem: `it could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Publishes a new key whole, by a hard link that fails if another process got there first. */
function createCheckpointKey(keyFile: string): void {
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const tmp = `${keyFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, WRITE_FLAGS, 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("hex"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, keyFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    unlinkSync(tmp);
  }
}

type FileRead = { readonly kind: "none" } | { readonly kind: "not-regular" } | { readonly kind: "corrupt"; readonly detail: string } | { readonly kind: "read"; readonly body: CheckpointBody; readonly mac: string };

/** Never blocks and never follows a link: a FIFO, device or symlink at the path reads as not a checkpoint. */
function readCheckpointFile(path: string): FileRead {
  let fd: number | undefined;
  let text: string;
  try {
    if (!lstatSync(path).isFile()) return { kind: "not-regular" };
    fd = openSync(path, READ_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { kind: "not-regular" };
    if (opened.size > MAX_CHECKPOINT_BYTES) return { kind: "corrupt", detail: `it is larger than ${MAX_CHECKPOINT_BYTES} bytes` };
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < opened.size) {
      const got = readSync(fd, bytes, read, opened.size - read, read);
      if (got === 0) break;
      read += got;
    }
    text = bytes.toString("utf8", 0, read);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "none" };
    if (code === "ELOOP" || code === "ENXIO") return { kind: "not-regular" };
    return { kind: "corrupt", detail: `it could not be read (${code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", detail: "it is not whole JSON (truncated or damaged)" };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { kind: "corrupt", detail: "it does not have the checkpoint's shape" };
  return { kind: "read", body: parsed.data.body, mac: parsed.data.mac };
}

function macMatches(key: Buffer, body: CheckpointBody, mac: string): boolean {
  return timingSafeEqual(Buffer.from(keyed(key, "file", body), "hex"), Buffer.from(mac, "hex"));
}

/** tmp, fsync, rename, then the directory: a reader sees the old file or the new one, whole. Refuses to replace what this code did not write. */
function writeCheckpointFile(path: string, key: Buffer, body: CheckpointBody): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error("the progress directory is a link or a file");
  try {
    if (!lstatSync(path).isFile()) throw new Error("something other than a regular file is at the checkpoint's path");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, WRITE_FLAGS, 0o600);
  try {
    try {
      writeSync(fd, JSON.stringify({ body, mac: keyed(key, "file", body) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write's own error is the one to report; a leftover tmp is never read.
    }
    throw err;
  }
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } catch (err) {
    // Some filesystems refuse fsync on a directory; the rename has still happened.
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    closeSync(dirFd);
  }
}

/** A short critical section so two starters cannot both claim one checkpoint. A dead holder's lock ages out. */
async function withCheckpointLock<T>(path: string, body: () => T): Promise<T | "busy"> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const giveUpAt = clock.monotonicMs() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (clock.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // Released while it was looked at, or not a directory: the next mkdir says which.
      }
      if (clock.monotonicMs() >= giveUpAt) return "busy";
      await clock.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return body();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already reclaimed as stale: the critical section is over either way.
    }
  }
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

/** True when a live verifier is still writing this receipt: `logs prune` leaves it, however old. */
export function isLiveVerifyReceipt(path: string): boolean {
  const found = readCheckpointFile(path);
  return found.kind === "read" && verifierStateOf(found.body) === "live";
}

/** The oldest time a reused result was measured at. */
function oldestResultMs(body: CheckpointBody): number {
  return Math.min(Date.parse(body.updatedAt), ...body.completed.map((p) => Date.parse(p.finishedAt)));
}

function ageRefusal(body: CheckpointBody): string | undefined {
  const now = clock.now();
  if (Date.parse(body.updatedAt) > now + CLOCK_SKEW_MS) return "its last update is in the future";
  const age = now - oldestResultMs(body);
  return age > CHECKPOINT_MAX_AGE_MS ? `its oldest result is ${Math.round(age / 3_600_000)}h old, over the ${CHECKPOINT_MAX_AGE_MS / 3_600_000}h limit` : undefined;
}

function unknownRecordKind(body: CheckpointBody): string | undefined {
  return body.completed.flatMap((p) => p.replays).find((r) => !REPLAY_RECORD_KINDS.includes(r.kind))?.kind;
}

/** Every reused result against the plan and the Journey: a result the plan could not have produced refuses the resume. */
function pairProblems(body: CheckpointBody, plan: MutationPlan, journey: Journey, sites: readonly JourneyAssertionSite[]): string | undefined {
  const stepCount = journey.recording.pages.reduce((n, p) => n + p.steps.length, 0);
  const keys = new Set(sites.map(assertionSiteKey));
  const siteProblem = (f: MutationFailedSite): boolean => ("step" in f && f.step > stepCount) || (f.where === "end-state" && !keys.has(`end-state:${f.index}`));
  if (body.total !== plan.mutations.length) return `it counts ${body.total} pairs and the plan ${plan.mutations.length}`;
  if (body.completed.length > plan.mutations.length) return "it holds more results than the plan has pairs";
  if (body.taint.notIsolatedBy !== null && !plan.mutations.some((m) => m.id === body.taint.notIsolatedBy)) return "its isolation note names no planned pair";
  for (const [i, pair] of body.completed.entries()) {
    const m = plan.mutations[i]!;
    if (pair.id !== m.id || pair.kind !== m.kind || pair.step !== m.step || pair.param !== m.param || pair.source !== m.source) return `result ${i + 1} is not planned pair ${m.id}`;
    const runs: { outcome: MutationRunResult["outcome"]; failedSites: readonly MutationFailedSite[] }[] = [pair, ...(pair.relaxed === undefined ? [] : [pair.relaxed]), ...(pair.targeted ?? [])];
    for (const run of runs) {
      if (run.outcome !== "failed" && run.failedSites.length > 0) return `${m.id} has failed sites on a replay that did not fail`;
      if (run.failedSites.some(siteProblem)) return `${m.id} names a site this Journey does not have`;
    }
    if (pair.replays.some((r) => r.failedSites.some(siteProblem))) return `${m.id} names a site this Journey does not have`;
    if (pair.replays.some((r) => r.outcome !== "failed" && r.failedSites.length > 0)) return `${m.id} has failed sites on a replay that did not fail`;
    if ((pair.relaxed !== undefined) !== needsRelaxedReplay(plan, m, pair)) return `${m.id} does not hold the replays its first result calls for`;
    for (const t of pair.targeted ?? []) {
      if (!keys.has(t.site)) return `${m.id} has a targeted proof of a site this Journey does not have`;
      if (!plan.pairs.some((p) => p.mutation === m.id && p.site === t.site)) return `${m.id} has a targeted proof of a site it is not paired with`;
    }
    // Every result the verdict reads must stand on a replay record that says the same.
    const ofKind = (kind: string): readonly CheckpointReplay[] => pair.replays.filter((r) => r.kind === kind);
    const sameRun = (r: CheckpointReplay, run: { outcome: string; failedSites: readonly MutationFailedSite[] }): boolean => r.outcome === run.outcome && canonicalJson(r.failedSites) === canonicalJson(run.failedSites);
    if (ofKind("first").length !== 1 || !sameRun(ofKind("first")[0]!, pair)) return `${m.id} has no replay record for its first result`;
    if (pair.relaxed === undefined ? ofKind("relaxed").length !== 0 : ofKind("relaxed").length !== 1 || !sameRun(ofKind("relaxed")[0]!, pair.relaxed)) return `${m.id} has no replay record for its relaxed result`;
    if (pair.control === undefined ? ofKind("control").length !== 0 : ofKind("control").length !== 1 || ofKind("control")[0]!.outcome !== pair.control) return `${m.id} has no replay record for its control`;
    for (const t of pair.targeted ?? []) {
      // A proof refused on the mutated replay's own control repeats that control's class, and ran none of its own.
      if (t.control !== undefined && t.control !== pair.control && !ofKind("targeted-control").some((r) => r.outcome === t.control)) return `${m.id} has no replay record for a targeted control`;
    }
  }
  return undefined;
}

export interface ResumeState {
  readonly pairs: ReadonlyMap<string, CheckpointPair>;
  readonly restoreFailed: boolean;
  readonly notIsolatedBy: string | null;
  /** Why a replay may have decided another. Absent or null with `notIsolatedBy` set: a replay closed with a write open. */
  readonly isolation?: IsolationNote | null;
}

/** One proof's writer. A failed write never ends a proof: the next one writes everything again. */
export class ProofCheckpointSession {
  #body: CheckpointBody;
  #failed = false;

  constructor(
    readonly path: string,
    readonly key: Buffer,
    body: CheckpointBody,
    readonly onNotice: (text: string) => void,
  ) {
    this.#body = body;
  }

  get body(): CheckpointBody {
    return this.#body;
  }

  #write(change: Partial<CheckpointBody>): boolean {
    this.#body = { ...this.#body, ...change, updatedAt: clock.nowIso() };
    try {
      writeCheckpointFile(this.path, this.key, this.#body);
      this.#failed = false;
      return true;
    } catch (err) {
      if (!this.#failed) this.onNotice(`journey verify: progress could not be saved (${(err as NodeJS.ErrnoException).code ?? "error"}); the proof goes on, and a resume may repeat work`);
      this.#failed = true;
      return false;
    }
  }

  replayStarted(replay: number): void {
    this.#write({ replay });
  }

  independence(independence: NonNullable<CheckpointBody["independence"]>): void {
    this.#write({ independence });
  }

  phase(phase: CheckpointBody["phase"]): void {
    this.#write({ phase, currentPair: null });
  }

  startPair(id: string): void {
    this.#write({ phase: "pairs", currentPair: id });
  }

  finishPair(pair: CheckpointPair): void {
    this.#write({ completed: [...this.#body.completed, pair], currentPair: null });
  }

  /**
   * Written the moment it happens: a taint that dies with the process could turn a resumed proof `proven`.
   * So if it cannot be written (a full disk), the older file without it must not stay resumable. A later
   * write that succeeds carries the taint, since each write holds the whole body.
   */
  taint(change: Partial<CheckpointBody["taint"]>): void {
    if (this.#write({ taint: { ...this.#body.taint, ...change } })) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Nothing more can be done here: the proof itself still carries the taint to its verdict.
    }
  }

  finish(verdict: MutationProofVerdict): void {
    this.#write({ state: "finished", verdict, currentPair: null });
  }

  /** The proof ended with no verdict, in a process that may go on (an MCP server), so its pid no longer says anything. */
  interrupted(): void {
    if (this.#body.state === "running") this.#write({ state: "interrupted" });
  }
}

export interface OpenedCheckpoint {
  readonly session?: ProofCheckpointSession;
  readonly resume?: ResumeState;
}

const refuse = (reason: ResumeRefusalReason, detail: string): never => {
  throw new JourneyVerifyResumeRefusedError(reason, detail);
};

/**
 * Claims the checkpoint for this run, before any browser. A resume returns the results it may reuse or
 * refuses by name. A fresh run replaces an ended checkpoint and leaves a live verifier's alone, going
 * on without progress of its own, since a proof that ran before this file existed must still run.
 */
export async function openProofCheckpoint(
  req: ProofCheckpointRequest,
  proof: { readonly journey: Journey; readonly journeyHash: string; readonly plan: MutationPlan; readonly params: Readonly<Record<string, string>>; readonly sites: readonly JourneyAssertionSite[] },
): Promise<OpenedCheckpoint> {
  const notice = req.onNotice ?? ((): void => undefined);
  const journeyId = proof.journey.metadata.id;
  let keyRead = readCheckpointKey(req.keyFile);
  if ("missing" in keyRead && !req.resume) {
    try {
      createCheckpointKey(req.keyFile);
      keyRead = readCheckpointKey(req.keyFile);
    } catch (err) {
      keyRead = { problem: `it could not be created (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }
  if (!("key" in keyRead)) {
    const why = "missing" in keyRead ? "it does not exist" : keyRead.problem;
    if (req.resume) return refuse("key-unavailable", `the checkpoint key ${req.keyFile} cannot be used: ${why}`);
    notice(`journey verify: no progress is kept for this run, because the checkpoint key ${req.keyFile} cannot be used: ${why}`);
    return {};
  }
  const { key } = keyRead;
  const bindings = {
    params: keyed(key, "params", proof.params),
    hook: keyed(key, "hook", req.config.hook),
    origin: keyed(key, "origin", req.config.origin),
    browser: keyed(key, "browser", req.config.browser),
  };
  const planDigest = mutationPlanDigest(proof.plan);
  const now = clock.nowIso();
  const fresh: CheckpointBody = {
    schema: 2,
    journeyId,
    journeyHash: proof.journeyHash,
    planDigest,
    bindings,
    build: req.build,
    total: proof.plan.mutations.length,
    completed: [],
    phase: "base",
    currentPair: null,
    replay: 0,
    startedAt: now,
    updatedAt: now,
    state: "running",
    reusedPairs: 0,
    independence: null,
    taint: { restoreFailed: false, notIsolatedBy: null, isolation: null },
    verifier: currentVerifierIdentity(),
  };

  const claimFresh = (): OpenedCheckpoint => {
    const found = readCheckpointFile(req.path);
    if (found.kind === "not-regular") {
      notice(`journey verify: no progress is kept for this run: something other than a regular file is at ${req.path}`);
      return {};
    }
    if (found.kind === "read" && macMatches(key, found.body, found.mac)) {
      const verifier = verifierStateOf(found.body);
      if (verifier === "live" || (verifier === "stale" && found.body.verifier.host !== hostname())) {
        notice(`journey verify: no progress is kept for this run: verifier ${found.body.verifier.pid} owns ${req.path}`);
        return {};
      }
      if (found.body.state !== "finished" && found.body.completed.length > 0) notice(`journey verify: starting again replaces a checkpoint with ${found.body.completed.length} finished pairs; --resume would have reused them`);
    }
    try {
      writeCheckpointFile(req.path, key, fresh);
    } catch (err) {
      notice(`journey verify: no progress is kept for this run: ${(err as NodeJS.ErrnoException).code ?? "the checkpoint could not be written"}`);
      return {};
    }
    return { session: new ProofCheckpointSession(req.path, key, fresh, notice) };
  };

  const claimResume = (): OpenedCheckpoint => {
    const found = readCheckpointFile(req.path);
    if (found.kind === "none") return refuse("no-checkpoint", `there is no checkpoint for journey '${journeyId}' at ${req.path}`);
    if (found.kind === "not-regular") return refuse("not-regular-file", `something other than a regular file is at ${req.path}`);
    if (found.kind === "corrupt") return refuse("corrupt", `the checkpoint at ${req.path} cannot be used: ${found.detail}`);
    const { body } = found;
    if (!macMatches(key, body, found.mac)) return refuse("integrity", `the checkpoint at ${req.path} does not carry this user's key: it was changed outside jevitate, or the key was replaced`);
    if (body.journeyId !== journeyId) return refuse("corrupt", `the checkpoint at ${req.path} belongs to another Journey`);
    const verifier = verifierStateOf(body);
    if (verifier === "live") return refuse("live-verifier", `verifier ${body.verifier.pid} is still running this proof; read it with --status`);
    if (body.state === "running" && body.verifier.host !== hostname()) return refuse("other-host", `verifier ${body.verifier.pid} ran on host ${body.verifier.host}, where this host cannot check it`);
    if (body.state === "finished") return refuse("finished", `this proof already finished (${body.verdict ?? "no verdict"}); its receipt stands`);
    if (body.journeyHash !== proof.journeyHash) return refuse("journey-hash", "the Journey changed since the checkpoint");
    if (body.planDigest !== planDigest) return refuse("mutation-plan", "the mutation plan changed since the checkpoint");
    if (body.bindings.params !== bindings.params) return refuse("params", "the parameters differ from the checkpoint's");
    if (body.bindings.hook !== bindings.hook) return refuse("hook", "the hooks or fixtures differ from the checkpoint's");
    if (body.bindings.origin !== bindings.origin) return refuse("origin", "the environment, base URL or allowed origins differ from the checkpoint's");
    if (body.bindings.browser !== bindings.browser) return refuse("browser", "the browser, emulation or session settings differ from the checkpoint's");
    if (req.build.commit === "unknown" || req.build.builtAt === "unknown") return refuse("cli-build", "this build cannot say which build it is, so it cannot be shown to be the checkpoint's");
    if (canonicalJson(body.build) !== canonicalJson(req.build)) return refuse("cli-build", `the checkpoint was written by ${body.build.version} (${body.build.commit}, built ${body.build.builtAt}) and this is ${req.build.version} (${req.build.commit}, built ${req.build.builtAt})`);
    const unknown = unknownRecordKind(body);
    if (unknown !== undefined) return refuse("unknown-record", `the checkpoint holds a replay record of kind '${unknown}', which this build cannot re-check`);
    const old = ageRefusal(body);
    if (old !== undefined) return refuse("too-old", old);
    const invalid = pairProblems(body, proof.plan, proof.journey, proof.sites);
    if (invalid !== undefined) return refuse("corrupt", `the checkpoint at ${req.path} cannot be used: ${invalid}`);
    const claimed: CheckpointBody = { ...body, state: "running", phase: "base", independence: null, currentPair: null, replay: 0, reusedPairs: body.completed.length, updatedAt: clock.nowIso(), verifier: currentVerifierIdentity() };
    try {
      // A resume that cannot record its claim cannot keep a second verifier out.
      writeCheckpointFile(req.path, key, claimed);
    } catch (err) {
      return refuse("not-writable", `the claim could not be written to ${req.path} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    notice(`journey verify: resuming with ${body.completed.length} of ${body.total} pairs finished; the base replay runs first and must pass before any is reused`);
    const session = new ProofCheckpointSession(req.path, key, claimed, notice);
    return { session, resume: { pairs: new Map(body.completed.map((p) => [p.id, p])), restoreFailed: body.taint.restoreFailed, notIsolatedBy: body.taint.notIsolatedBy, isolation: body.taint.isolation } };
  };

  const opened = await withCheckpointLock(req.path, req.resume ? claimResume : claimFresh).catch((err: unknown) => {
    if (err instanceof JourneyVerifyResumeRefusedError) throw err;
    if (req.resume) return refuse("not-writable", `the checkpoint could not be claimed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    notice(`journey verify: no progress is kept for this run: ${(err as NodeJS.ErrnoException).code ?? "the checkpoint could not be claimed"}`);
    return {} satisfies OpenedCheckpoint;
  });
  if (opened !== "busy") return opened;
  if (req.resume) return refuse("live-verifier", "another process is claiming this checkpoint right now");
  notice("journey verify: no progress is kept for this run: another process is claiming its checkpoint");
  return {};
}

/** The storable form of a refusal: the wordings `suggestTargetedProofPlan` reads, else none of it. */
function storableRefusal(refused: string): string {
  return REFUSALS_KEPT.some((kept) => kept.test(refused)) ? refused : REFUSAL_NOT_KEPT;
}

/** A finished pair's result as `journey-verify` reports it, field by field: anything not named here cannot reach the file. */
export interface FinishedPair {
  readonly id: string;
  readonly kind: JourneyMutation["kind"];
  readonly step: number;
  readonly param?: string;
  readonly source?: JourneyMutation["source"];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  readonly waitsCut?: readonly string[];
  readonly relaxed?: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[]; readonly waitsCut?: readonly string[]; readonly atBaseTime?: MutationRunResult["atBaseTime"] };
  readonly control?: MutationRunResult["outcome"];
  readonly controlSkipped?: true;
  readonly atBaseTime?: MutationRunResult["atBaseTime"];
  readonly targeted?: readonly TargetedProof[];
  readonly retries?: readonly unknown[];
}

const structuredSites = (sites: readonly MutationFailedSite[]): MutationFailedSite[] =>
  sites.map((f): MutationFailedSite =>
    f.where === "step" ? { where: "step", step: f.step, postcondition: f.postcondition } : f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );

const storedAtBaseTime = (run: MutationRunResult["atBaseTime"]): { outcome: MutationRunResult["outcome"]; failedSites: MutationFailedSite[] } | undefined =>
  run === undefined ? undefined : { outcome: run.outcome, failedSites: structuredSites(run.failedSites) };

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));

export function checkpointPairOf(pair: FinishedPair, replays: readonly CheckpointReplay[]): CheckpointPair {
  return {
    id: pair.id,
    kind: pair.kind,
    step: pair.step,
    ...optional("param", pair.param),
    ...optional("source", pair.source),
    outcome: pair.outcome,
    failedSites: structuredSites(pair.failedSites),
    ...optional("waitsCut", pair.waitsCut === undefined ? undefined : [...pair.waitsCut]),
    ...optional(
      "relaxed",
      pair.relaxed === undefined ? undefined : { outcome: pair.relaxed.outcome, failedSites: structuredSites(pair.relaxed.failedSites), ...optional("waitsCut", pair.relaxed.waitsCut === undefined ? undefined : [...pair.relaxed.waitsCut]), ...optional("atBaseTime", storedAtBaseTime(pair.relaxed.atBaseTime)) },
    ),
    ...optional("control", pair.control),
    ...optional("controlSkipped", pair.controlSkipped),
    ...optional("atBaseTime", storedAtBaseTime(pair.atBaseTime)),
    ...optional(
      "targeted",
      pair.targeted?.map((t) => ({
        site: t.site,
        relaxedSites: [...t.relaxedSites],
        outcome: t.outcome,
        failedSites: structuredSites(t.failedSites),
        ...optional("refused", t.refused === undefined ? undefined : storableRefusal(t.refused)),
        ...optional("control", t.control),
        ...optional("declared", t.declared),
      })),
    ),
    retries: pair.retries?.length ?? 0,
    finishedAt: clock.nowIso(),
    replays: [...replays],
  };
}

/** One replay in the file's form, by kind. Named fields only, so a `reason` on the run cannot reach the file. */
export function checkpointReplayOf(kind: string, run: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[]; readonly reachedMs?: readonly (number | undefined)[]; readonly endStateReachedMs?: number }, writesInFlightAtClose: number): CheckpointReplay {
  return { kind, outcome: run.outcome, failedSites: structuredSites(run.failedSites), reachedMs: Array.from(run.reachedMs ?? [], (ms) => ms ?? null), ...optional("endStateReachedMs", run.endStateReachedMs), writesInFlightAtClose };
}

/** The result `classifyMutation` and `mutationProofVerdict` read, as the uninterrupted proof gave them. */
export function reusedProofFields(pair: CheckpointPair): Pick<MutationRunResult, "outcome" | "failedSites"> & Partial<Pick<MutationRunResult, "waitsCut" | "relaxed" | "targeted" | "control" | "atBaseTime">> {
  return {
    outcome: pair.outcome,
    failedSites: pair.failedSites,
    ...optional("waitsCut", pair.waitsCut),
    ...optional("relaxed", pair.relaxed),
    ...optional("control", pair.control),
    ...optional("atBaseTime", pair.atBaseTime),
    ...optional("targeted", pair.targeted),
  };
}

const undefinedHoles = (reached: readonly (number | null)[]): (number | undefined)[] => reached.map((ms) => ms ?? undefined);

/**
 * The reused results against a base measured just now. A reused replay was paced to the base of its own
 * run. Under the rule (`evidenceRefusal`) its failure is evidence only if it got there no sooner than an
 * unmutated replay passes that site, and the replay that says so now is the re-measured one. So each
 * reused failure is read again against the new pace, by the same functions the proof uses: reached
 * sooner than the new base, or newly thin with no control that answered for it, refuses the whole resume.
 * A failed replay already cut needs nothing: it counts for nothing either way. A faster base only
 * leaves a reused replay more room. Every record goes through the same loop whatever its kind, controls
 * included. Writes left open are compared as the proof compares them.
 */
export function resumeRefusalAgainstBase(state: ResumeState, plan: MutationPlan, sites: readonly JourneyAssertionSite[], pace: ReplayPace, baseWritesInFlightAtClose: number): JourneyVerifyResumeRefusedError | undefined {
  const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
  for (const m of plan.mutations) {
    const pair = state.pairs.get(m.id);
    if (pair === undefined) continue;
    for (const r of pair.replays) {
      if (r.writesInFlightAtClose > baseWritesInFlightAtClose) {
        return new JourneyVerifyResumeRefusedError("isolation", `a ${r.kind} replay of ${m.id} closed with ${r.writesInFlightAtClose} writes open and the re-measured base with ${baseWritesInFlightAtClose}, so it may have decided a later replay`);
      }
    }
    const result = reusedProofFields(pair);
    // Only a site read sensitive can turn into a false `proven`: a pair with none cannot change by being cut.
    const sensitive = plan.pairs.filter((p) => {
      const site = siteByKey.get(p.site);
      return p.mutation === m.id && site !== undefined && classifyMutation(site, m, result) === "sensitive";
    });
    if (sensitive.length === 0) continue;
    const cutFor = (r: CheckpointReplay): readonly string[] | undefined => (r.kind === "first" ? pair.waitsCut : r.kind === "relaxed" ? pair.relaxed?.waitsCut : undefined);
    for (const r of pair.replays) {
      // A replay at the base's time only ever says a claim held without the mutation, and a failure there is no reading.
      if (r.outcome !== "failed" || r.kind === "at-base-time" || (cutFor(r)?.length ?? 0) > 0) continue;
      const reached = undefinedHoles(r.reachedMs);
      const early = sitesReachedEarly(r.failedSites, m, pace, reached, r.endStateReachedMs);
      if (early.length > 0) return new JourneyVerifyResumeRefusedError("pace", `a ${r.kind} replay of ${m.id} failed at ${early.join(", ")} sooner than the re-measured base replay passed it, so the reused failure is not evidence`);
      // A skipped control stands on the verdict being decided by other reused results, which still are.
      if (NOT_THIN_CHECKED.has(r.kind) || pair.control !== undefined || pair.controlSkipped === true) continue;
      const thin = thinSites(r.failedSites, m, pace, reached, r.endStateReachedMs);
      if (sensitive.some((p) => thin.includes(p.site))) return new JourneyVerifyResumeRefusedError("pace", `a ${r.kind} replay of ${m.id} reached ${thin.join(", ")} with little to spare over the re-measured base replay, and no control replay answers for it`);
    }
  }
  return undefined;
}

export interface VerifyProgressStatus {
  readonly journeyId: string;
  readonly path: string;
  /** valid: the keyed check passed. unverified: readable, but this user has no key to check it with. */
  readonly receipt: "none" | "valid" | "unverified" | "corrupt" | "integrity-failed" | "not-regular-file";
  readonly detail?: string;
  readonly verifier: VerifierState | "none";
  readonly resume: { readonly possible: boolean; readonly refusal?: ResumeRefusalReason };
  readonly progress?: {
    readonly state: CheckpointBody["state"];
    readonly verdict?: MutationProofVerdict;
    readonly phase: CheckpointBody["phase"];
    readonly completed: number;
    readonly total: number;
    readonly currentPair: string | null;
    readonly replay: number;
    readonly reusedPairs: number;
    readonly journeyHash: string;
    readonly planDigest: string;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly lastResultClass: MutationRunResult["outcome"] | null;
    readonly completedPairs: readonly { readonly id: string; readonly resultClass: MutationRunResult["outcome"]; readonly finishedAt: string }[];
    readonly verifierPid: number;
    readonly verifierStartToken: string;
    readonly build: CheckpointBody["build"];
    readonly taint: { readonly restoreFailed: boolean; readonly notIsolated: boolean };
  };
}

/**
 * `journey verify <id> --status`: reads the file and asks the OS about one pid. No browser, no hook, no
 * Journey and nothing of the app's. A key is read when there is one and never created. `resume` answers
 * what can be answered without the run's flags, so `possible: true` still leaves the config checks.
 */
export function readVerifyProgress(path: string, keyFile: string, journeyId: string): VerifyProgressStatus {
  const none = { journeyId, path, verifier: "none" as const };
  const found = readCheckpointFile(path);
  if (found.kind === "none") return { ...none, receipt: "none", resume: { possible: false, refusal: "no-checkpoint" } };
  if (found.kind === "not-regular") return { ...none, receipt: "not-regular-file", detail: "something other than a regular file is at this path", resume: { possible: false, refusal: "not-regular-file" } };
  if (found.kind === "corrupt") return { ...none, receipt: "corrupt", detail: found.detail, resume: { possible: false, refusal: "corrupt" } };
  const { body, mac } = found;
  if (body.journeyId !== journeyId) return { ...none, receipt: "corrupt", detail: "it belongs to another Journey", resume: { possible: false, refusal: "corrupt" } };
  const key = readCheckpointKey(keyFile);
  if ("key" in key && !macMatches(key.key, body, mac)) return { ...none, receipt: "integrity-failed", detail: "it does not carry this user's key", resume: { possible: false, refusal: "integrity" } };
  const verifier = verifierStateOf(body);
  const refusal: ResumeRefusalReason | undefined = !("key" in key)
    ? "key-unavailable"
    : verifier === "live"
      ? "live-verifier"
      : body.state === "running" && body.verifier.host !== hostname()
        ? "other-host"
        : body.state === "finished"
          ? "finished"
          : unknownRecordKind(body) !== undefined
            ? "unknown-record"
            : ageRefusal(body) !== undefined
              ? "too-old"
              : undefined;
  return {
    journeyId,
    path,
    receipt: "key" in key ? "valid" : "unverified",
    verifier,
    resume: refusal === undefined ? { possible: true } : { possible: false, refusal },
    progress: {
      state: body.state,
      ...optional("verdict", body.verdict),
      phase: body.phase,
      completed: body.completed.length,
      total: body.total,
      currentPair: body.currentPair,
      replay: body.replay,
      reusedPairs: body.reusedPairs,
      journeyHash: body.journeyHash,
      planDigest: body.planDigest,
      startedAt: body.startedAt,
      updatedAt: body.updatedAt,
      lastResultClass: body.completed.at(-1)?.outcome ?? null,
      completedPairs: body.completed.map((p) => ({ id: p.id, resultClass: p.outcome, finishedAt: p.finishedAt })),
      verifierPid: body.verifier.pid,
      verifierStartToken: body.verifier.startToken,
      build: body.build,
      taint: { restoreFailed: body.taint.restoreFailed, notIsolated: body.taint.notIsolatedBy !== null || body.taint.isolation !== null },
    },
  };
}

/** One human line for `--status`. */
export function verifyProgressLine(s: VerifyProgressStatus): string {
  if (s.progress === undefined) return `journey '${s.journeyId}': ${s.receipt === "none" ? "no progress receipt" : `progress receipt ${s.receipt}${s.detail === undefined ? "" : `: ${s.detail}`}`}\n`;
  const p = s.progress;
  const current = p.currentPair === null ? p.phase : `pair ${p.currentPair}`;
  const resume = s.resume.possible ? "resumable" : `not resumable (${s.resume.refusal ?? "unknown"})`;
  return `journey '${s.journeyId}': verifier ${s.verifier} (pid ${p.verifierPid}), ${p.state}${p.verdict === undefined ? "" : ` ${p.verdict}`}, ${p.completed}/${p.total} pairs, at ${current}, replay ${p.replay}, updated ${p.updatedAt}, ${resume}\n`;
}
