import { hostname } from "node:os";
import { type MutationRunResult } from "@jevitate/journey";
import { readProofVerdict, type MutationProofVerdict } from "./journey-verify-report.js";
import { ageRefusal, finishedForGood, macMatches, optional, reusableOnResume, unknownRecordKind, verifierStateOf, type CheckpointBody, type ResumeRefusalReason, type VerifierState } from "./journey-verify-checkpoint-binding.js";
import { readCheckpointFile, readCheckpointKey } from "./journey-verify-checkpoint-store.js";

/**
 * Reading and rendering a checkpoint's progress for `journey verify --status` (split out of
 * `journey-verify-checkpoint.ts`, which re-exports every name here).
 */
/** True when a live verifier is still writing this receipt: `logs prune` leaves it, however old. */
export function isLiveVerifyReceipt(path: string): boolean {
  const found = readCheckpointFile(path);
  return found.kind === "read" && verifierStateOf(found.body) === "live";
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
    /** Pairs finished that a resume keeps. */
    readonly completed: number;
    /** Pairs that ran but that a resume would run again: errored, or short of a control. Zero once a proof takes no resume. */
    readonly toRunAgain: number;
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
        : finishedForGood(body)
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
      ...optional("verdict", body.verdict === undefined ? undefined : readProofVerdict(body.verdict)),
      phase: body.phase,
      completed: finishedForGood(body) ? body.completed.length : body.completed.filter(reusableOnResume).length,
      toRunAgain: finishedForGood(body) ? 0 : body.completed.filter((p) => !reusableOnResume(p)).length,
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
  return `journey '${s.journeyId}': verifier ${s.verifier} (pid ${p.verifierPid}), ${p.state}${p.verdict === undefined ? "" : ` ${p.verdict}`}, ${p.completed}/${p.total} pairs${p.toRunAgain === 0 ? "" : ` (${p.toRunAgain} more ran, errored or short of a control, and a resume runs them again)`}, at ${current}, replay ${p.replay}, updated ${p.updatedAt}, ${resume}\n`;
}
