import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { contentHash, clock } from "@jevitate/domain";
import {
  JourneyProposalSchema,
  RejectedProposalSchema,
  type ApprovalProvenance,
  type Journey,
  type JourneyProposal,
  type RejectedProposal,
} from "@jevitate/journey";
import { assertRecordingProofUntouched, flattenRecording, healFloor, sanitizeStep, type HealAttempt, type ProposedRevisionDraft } from "@jevitate/runtime";
import type { Recording } from "@jevitate/recording";
import { journeyReviewHash } from "./journey-review.js";
import { journeyStepRisk } from "./journey-heal.js";
import { redactCredentialShapes, redactText, redactUrl } from "@jevitate/ai-core";

/**
 * #453 — proposed Journey revisions, beside the journeys directory (`.proposals/`, committed with
 * the PR like `.approved/`; a dot-folder, so never listed as a Journey). One PENDING proposal per
 * Journey, keyed by the Journey id: `.proposals/<id>.json`; a newer one replaces it. A rejected one
 * moves to `.proposals/<id>.rejected/<proposalId>.json` with who rejected it and why. A run never
 * writes the stored Journey — only `journey promote --proposal` does.
 *
 * Nothing here can hold a secret: step values arrive through `sanitizeStep` (hidden), every string
 * passes the redaction of the run's secret values, and the recording is the Journey's own. The free
 * text (hypotheses, evidence, notes, rejection details, paths) is also scrubbed of credential-shaped
 * values and sensitive URL parameters. It DOES hold control labels and change evidence — the files
 * are committed (docs/journeys.md).
 *
 * #453 review: the store never follows a symlink — the `.proposals/` directories and files are
 * `lstat`ed on read and write and a link is refused (`JourneyProposalInvalidError`); a write goes
 * to a temporary file renamed into place (atomic).
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

/**
 * Refuses (`JourneyProposalInvalidError`) when `.proposals/` or any directory or file on the way to
 * `path` under it is a symbolic link — never followed, for a read or a write. Components that do not
 * exist yet are fine (a write creates them).
 */
async function assertNoSymlink(path: string): Promise<void> {
  const marker = `${sep}.proposals${sep}`;
  const at = path.lastIndexOf(marker);
  if (at < 0) throw new JourneyProposalInvalidError(`${path} is not under a .proposals directory`);
  const root = path.slice(0, at + marker.length - 1);
  const parts = relative(root, path).split(sep).filter((p) => p !== "");
  let cur = root;
  for (const next of [null, ...parts]) {
    if (next !== null) cur = join(cur, next);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new JourneyProposalInvalidError(`refusing to follow a symbolic link at ${cur} — proposals are never read or written through a link`);
  }
}

async function readJson(path: string): Promise<unknown | null> {
  await assertNoSymlink(path);
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
  await assertNoSymlink(path);
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlink(path);
  const tmp = `${path}.${process.pid}.${clock.monotonicMs().toString(36)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function removeFile(path: string): Promise<void> {
  await assertNoSymlink(path);
  await rm(path, { force: true });
}

/** Deterministic JSON (keys sorted, undefined dropped): two steps are the same when these agree. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function originOf(url: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
}

/**
 * #453 review: re-runs the heal floor on every step a revision changes (on write, on read for review
 * and on accept) — a proposal file edited by hand, or written by an older build, never lets
 * `journey promote --proposal` store what the runner would not have healed:
 *  - the floor (`healFloor` with the built-in `SafetyPolicy` classification, `journeyStepRisk`) holds
 *    for the step before AND after: never a proof / write / risky-control step;
 *  - a retargeted click/fill expects only GET/HEAD/OPTIONS requests (part of the floor);
 *  - a retargeted navigate URL stays on the Journey's allowed origin (its recorded site).
 */
export function proposalFloorViolation(stored: Journey, proposed: Recording): string | null {
  const riskOf = journeyStepRisk();
  const before = flattenRecording(stored.recording);
  const after = flattenRecording(proposed);
  let site: string | null = null;
  try {
    site = new URL(stored.recording.site).origin;
  } catch {
    site = null;
  }
  for (let i = 0; i < after.length; i++) {
    const b = before[i];
    const a = after[i]!;
    if (b !== undefined && canonical(b.step) === canonical(a.step)) continue;
    for (const [which, rec] of [["before", b?.recorded], ["after", a.recorded]] as const) {
      if (rec === undefined) return `step ${i + 1} is not in the stored Journey`;
      const floor = healFloor(rec, riskOf);
      if (floor.floor !== "healable") return `step ${i + 1} (${which}): ${floor.reason}`;
    }
    if (a.step.kind === "navigate") {
      const o = originOf(a.step.url);
      if (o !== null && o !== site) return `step ${i + 1}: the retargeted URL is on ${o}, not the Journey's origin ${site ?? "(none)"}`;
    }
  }
  return null;
}

/**
 * #467: a proposal names each changed step by its flat index AND, when the step has one, its stable
 * id — refused when they disagree (the index points at a different step than the one that was healed,
 * or the file was edited). Null when every named id is the stored step's at that index.
 */
export function proposalStepIdViolation(stored: Journey, steps: readonly { readonly index: number; readonly stepId?: string }[]): string | null {
  const flat = flattenRecording(stored.recording);
  for (const s of steps) {
    if (s.stepId === undefined) continue;
    const have = flat[s.index]?.recorded.stepId;
    if (have !== s.stepId) return `step ${s.index + 1} is named ${s.stepId}, but the Journey's step ${s.index + 1} is ${have ?? "(no id)"}`;
  }
  return null;
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
  const floor = proposalFloorViolation(input.base, input.draft.recording);
  if (floor !== null) throw new JourneyProposalProofError(`refusing to store a proposal the heal floor refuses: ${floor}`);
  const idClash = proposalStepIdViolation(input.base, input.draft.steps);
  if (idClash !== null) throw new JourneyProposalProofError(`refusing to store a proposal whose step ids disagree with the Journey: ${idClash}`);
  const baseHash = journeyReviewHash(input.base);
  const secrets = [...(input.secrets ?? [])];
  // Every string: the run's secret values. Free text (not the recording or a step): also
  // credential-shaped values and sensitive URL parameters (#453 review).
  const scrub = (v: unknown, free = true): unknown =>
    typeof v === "string"
      ? free
        ? redactUrl(redactCredentialShapes(secrets.length === 0 ? v : redactText(v, secrets)))
        : secrets.length === 0
          ? v
          : redactText(v, secrets)
      : Array.isArray(v)
        ? v.map((x) => scrub(x, free))
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, free)]))
          : v;
  const screenshotOf = (n: number): string | undefined => input.attempts.find((a) => a.n === n)?.observation?.screenshot;
  const steps = input.draft.steps.map((s) => {
    const shot = screenshotOf(s.attempt);
    const before = s.evidence[0]?.before;
    const after = s.evidence[0]?.after;
    return {
      index: s.index,
      ...(s.stepId === undefined ? {} : { stepId: s.stepId }),
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
  // The recording, the steps, ids, hashes and SHAs keep their shape (secret values only); the
  // rest is free text.
  type Body = typeof body;
  const plain = JSON.parse(JSON.stringify(body)) as Body;
  const strict = scrub(plain, false) as Body;
  const free = scrub(plain, true) as Body;
  const scrubbed = {
    ...free,
    ...Object.fromEntries((["v", "kind", "proposalId", "journeyId", "baseHash", "proposedHash", "createdAt", "recording"] as const).map((k) => [k, strict[k]])),
    steps: free.steps.map((st, i) => ({ ...st, before: strict.steps[i]!.before, after: strict.steps[i]!.after })),
    changes: { ...free.changes, ...("baseSha" in strict.changes ? { baseSha: strict.changes.baseSha } : {}), ...("headSha" in strict.changes ? { headSha: strict.changes.headSha } : {}) },
    attempts: free.attempts.map((a, i) => ({ ...a, candidate: strict.attempts[i]!.candidate })),
  };
  const parsed = JourneyProposalSchema.safeParse(scrubbed);
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
  const floor = proposalFloorViolation(stored, proposal.recording);
  if (floor !== null) return new JourneyProposalProofError(`proposal '${proposal.proposalId}' changes a step the heal floor refuses: ${floor}`);
  const idClash = proposalStepIdViolation(stored, proposal.steps);
  if (idClash !== null) return new JourneyProposalProofError(`proposal '${proposal.proposalId}' names a step by an id the Journey's step does not have: ${idClash}`);
  if (journeyReviewHash(proposedJourney(stored, proposal)) !== proposal.proposedHash) {
    return new JourneyProposalProofError(`proposal '${proposal.proposalId}' does not match its recorded hash — the file was edited`);
  }
  return null;
}

/** Deletes the pending proposal (after it was accepted). */
export async function deleteJourneyProposal(journeysDir: string, journeyId: string): Promise<void> {
  await removeFile(proposalPath(journeysDir, journeyId));
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
  await writeJson(path, record);
  await removeFile(proposalPath(journeysDir, journeyId));
  return { path };
}
