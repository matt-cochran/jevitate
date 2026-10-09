import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentHash, clock } from "@jevitate/domain";
import {
  JourneyProposalSchema,
  RejectedProposalSchema,
  type ApprovalProvenance,
  type Journey,
  type JourneyProposal,
  type RejectedProposal,
} from "@jevitate/journey";
import { assertRecordingProofUntouched, sanitizeStep, type HealAttempt, type ProposedRevisionDraft } from "@jevitate/runtime";
import { journeyReviewHash } from "./journey-review.js";
import { redactText } from "@jevitate/ai-core";

/**
 * #453 — proposed Journey revisions, beside the journeys directory (`.proposals/`, committed with
 * the PR like `.approved/`; a dot-folder, so never listed as a Journey). One PENDING proposal per
 * Journey, keyed by the Journey id: `.proposals/<id>.json`; a newer one replaces it. A rejected one
 * moves to `.proposals/<id>.rejected/<proposalId>.json` with who rejected it and why. A run never
 * writes the stored Journey — only `journey promote --proposal` does.
 *
 * Nothing here can hold a secret: step values arrive through `sanitizeStep` (hidden), every string
 * passes the redaction of the run's secret values, and the recording is the Journey's own.
 */

/** No pending proposal with that id (or none at all). Exit 64. */
export class JourneyProposalNotFoundError extends Error {
  readonly code = "E_JOURNEY_PROPOSAL_NOT_FOUND";
}

/** The proposal was made against a Journey that has changed since, or its proof fields were touched. Exit 64. */
export class JourneyProposalStaleError extends Error {
  readonly code = "E_JOURNEY_PROPOSAL_STALE";
}

/** A proposal that changes more than retargets (an assertion, a wait, a request check…) — refused. */
export class JourneyProposalProofError extends Error {
  readonly code = "E_JOURNEY_PROPOSAL_PROOF";
}

/** A proposal file that is not valid. */
export class JourneyProposalInvalidError extends Error {
  readonly code = "E_JOURNEY_PROPOSAL_INVALID";
}

const PROPOSAL_ID = /^[0-9a-f]{12}$/;

/** True for a well-formed proposal id (12 hex characters) — also what keeps `../x` out of every path. */
export function isProposalId(id: string): boolean {
  return PROPOSAL_ID.test(id);
}

function parts(id: string): { dir: string[]; base: string } {
  const p = id.split("/");
  return { dir: p.slice(0, -1), base: p[p.length - 1] ?? id };
}

export function proposalPath(journeysDir: string, journeyId: string): string {
  const { dir, base } = parts(journeyId);
  return join(journeysDir, ".proposals", ...dir, `${base}.json`);
}

export function rejectedProposalPath(journeysDir: string, journeyId: string, proposalId: string): string {
  const { dir, base } = parts(journeyId);
  return join(journeysDir, ".proposals", ...dir, `${base}.rejected`, `${proposalId}.json`);
}

async function readJson(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new JourneyProposalInvalidError(`${path} is not valid JSON`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface WriteJourneyProposalInput {
  readonly journeyId: string;
  /** The stored Journey the revision was made against. */
  readonly base: Journey;
  readonly draft: ProposedRevisionDraft;
  readonly attempts: readonly HealAttempt[];
  readonly changes: { readonly range?: string; readonly baseSha?: string; readonly headSha?: string; readonly notes?: readonly string[] };
  readonly runResultPath?: string;
  /** Secret values of the run, scrubbed from every string written. */
  readonly secrets?: readonly string[];
}

export interface WrittenJourneyProposal {
  readonly proposalId: string;
  readonly path: string;
  /** The id of a pending proposal this one replaced. */
  readonly supersededProposal?: string;
}

/** The Journey as it would be stored on accept: the stored one with the proposed recording. */
export function proposedJourney(stored: Journey, proposal: Pick<JourneyProposal, "recording">): Journey {
  return { ...stored, recording: proposal.recording };
}

/**
 * Writes the proposal for `journeyId`, replacing a pending one. Refused (`JourneyProposalProofError`)
 * when the revision changes anything but retargets (`assertRecordingProofUntouched`).
 */
export async function writeJourneyProposal(journeysDir: string, input: WriteJourneyProposalInput): Promise<WrittenJourneyProposal> {
  const violation = assertRecordingProofUntouched(input.base.recording, input.draft.recording);
  if (violation !== null) throw new JourneyProposalProofError(`refusing to store a proposal that touches the Journey's proof (${violation.code}): ${violation.detail}`);
  const baseHash = journeyReviewHash(input.base);
  const secrets = [...(input.secrets ?? [])];
  const scrub = (v: unknown): unknown =>
    typeof v === "string"
      ? secrets.length === 0
        ? v
        : redactText(v, secrets)
      : Array.isArray(v)
        ? v.map(scrub)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
          : v;
  const screenshotOf = (n: number): string | undefined => input.attempts.find((a) => a.n === n)?.observation?.screenshot;
  const steps = input.draft.steps.map((s) => {
    const shot = screenshotOf(s.attempt);
    const before = s.evidence[0]?.before;
    const after = s.evidence[0]?.after;
    return {
      index: s.index,
      before: sanitizeStep(s.before),
      after: sanitizeStep(s.after),
      justification: {
        hypothesis: s.hypothesis,
        evidence: [...s.evidence],
        ...(s.anchorNotInChange === true ? { anchorNotInChange: true as const } : {}),
      },
      evidence: { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) },
      ...(shot === undefined ? {} : { screenshots: [shot] }),
    };
  });
  const proposalId = contentHash({ baseHash, steps: steps.map((s) => ({ index: s.index, after: s.after })) }).slice(0, 12);
  const proposed = proposedJourney(input.base, { recording: input.draft.recording });
  const body = {
    v: 1 as const,
    kind: "journey-proposal" as const,
    proposalId,
    journeyId: input.journeyId,
    baseHash,
    proposedHash: journeyReviewHash(proposed),
    createdAt: clock.nowIso(),
    recording: input.draft.recording,
    steps,
    changes: {
      ...(input.changes.range === undefined ? {} : { range: input.changes.range }),
      ...(input.changes.baseSha === undefined ? {} : { baseSha: input.changes.baseSha }),
      ...(input.changes.headSha === undefined ? {} : { headSha: input.changes.headSha }),
      notes: [...(input.changes.notes ?? [])],
    },
    attempts: input.attempts.map((a) => ({ ...a, candidate: a.candidate === null ? null : sanitizeStep(a.candidate) })),
    run: input.runResultPath === undefined ? {} : { resultPath: input.runResultPath },
  };
  const parsed = JourneyProposalSchema.safeParse(scrub(JSON.parse(JSON.stringify(body))));
  if (!parsed.success) throw new JourneyProposalInvalidError(`the proposal does not satisfy its schema: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const path = proposalPath(journeysDir, input.journeyId);
  const previous = await readJourneyProposal(journeysDir, input.journeyId).catch(() => null);
  await writeJson(path, parsed.data);
  return {
    proposalId,
    path,
    ...(previous !== null && previous.proposalId !== proposalId ? { supersededProposal: previous.proposalId } : {}),
  };
}

/** The pending proposal for a Journey, or null. An unreadable or invalid file is refused, never ignored. */
export async function readJourneyProposal(journeysDir: string, journeyId: string): Promise<JourneyProposal | null> {
  const path = proposalPath(journeysDir, journeyId);
  const raw = await readJson(path);
  if (raw === null) return null;
  const parsed = JourneyProposalSchema.safeParse(raw);
  if (!parsed.success) throw new JourneyProposalInvalidError(`${path} is not a valid Journey proposal: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** The pending proposal named `proposalId` for the Journey; `JourneyProposalNotFoundError` when none matches. */
export async function requireJourneyProposal(journeysDir: string, journeyId: string, proposalId: string): Promise<JourneyProposal> {
  const proposal = isProposalId(proposalId) ? await readJourneyProposal(journeysDir, journeyId) : null;
  if (proposal === null || proposal.proposalId !== proposalId || proposal.journeyId !== journeyId) {
    throw new JourneyProposalNotFoundError(`journey '${journeyId}' has no pending proposal '${proposalId}' — see: jevitate journey review ${journeyId}`);
  }
  return proposal;
}

/** True when the proposal was made against a different Journey than the stored one. */
export function isProposalStale(stored: Journey, proposal: JourneyProposal): boolean {
  return journeyReviewHash(stored) !== proposal.baseHash;
}

/**
 * Re-checks a proposal against the stored Journey (on read for review and again on accept): stale
 * when the Journey changed since, proof-touched when the file was edited to change anything but
 * retargets, or when its hash no longer matches its recording.
 */
export function checkProposal(stored: Journey, proposal: JourneyProposal): JourneyProposalStaleError | JourneyProposalProofError | null {
  if (isProposalStale(stored, proposal)) {
    return new JourneyProposalStaleError(
      `proposal '${proposal.proposalId}' was made against journey '${stored.metadata.id}' ${proposal.baseHash.slice(0, 8)}, which has changed since (now ${journeyReviewHash(stored).slice(0, 8)}) — re-run the self-heal: jevitate journey run ${stored.metadata.id} --self-heal`,
    );
  }
  const violation = assertRecordingProofUntouched(stored.recording, proposal.recording);
  if (violation !== null) return new JourneyProposalProofError(`proposal '${proposal.proposalId}' touches the Journey's proof (${violation.code}): ${violation.detail}`);
  if (journeyReviewHash(proposedJourney(stored, proposal)) !== proposal.proposedHash) {
    return new JourneyProposalProofError(`proposal '${proposal.proposalId}' does not match its recorded hash — the file was edited`);
  }
  return null;
}

/** Deletes the pending proposal (after it was accepted). */
export async function deleteJourneyProposal(journeysDir: string, journeyId: string): Promise<void> {
  await rm(proposalPath(journeysDir, journeyId), { force: true });
}

/** Moves the pending proposal to `.rejected/`, recording when, why and how it was rejected. */
export async function rejectJourneyProposal(
  journeysDir: string,
  journeyId: string,
  proposalId: string,
  rejection: { readonly reason: string; readonly provenance: ApprovalProvenance },
): Promise<{ path: string }> {
  const proposal = await requireJourneyProposal(journeysDir, journeyId, proposalId);
  const record: RejectedProposal = RejectedProposalSchema.parse({
    v: 1,
    kind: "journey-proposal-rejected",
    rejectedAt: clock.nowIso(),
    reason: rejection.reason,
    provenance: rejection.provenance,
    proposal,
  });
  const path = rejectedProposalPath(journeysDir, journeyId, proposalId);
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, record);
  await rm(proposalPath(journeysDir, journeyId), { force: true });
  return { path };
}
