import { JourneyRunEvidenceWriter } from "./journey-run-evidence.js";
import { type RunMode } from "./journey-run-hooks.js";
import { FsJourneyStore, JourneyRegistry, describeStep, flatJourneySteps, lintJourney, lintJourneyDoneCheck, lintUploadFixtures, secretParamNames, secretParamValues, stampAnchorStepIds, type Journey, type JourneyApproval, type JourneyLintFinding, type ApprovalProvenance } from "@jevitate/journey";
import { programmaticProvenance, type ApprovalConfirm } from "./approval-provenance.js";
import { journeyEntry } from "./forge-verify.js";
import { checkProposal, deleteJourneyProposal, proposedJourney, rejectJourneyProposal, requireJourneyProposal } from "./journey-proposal-store.js";
import { journeyReviewHash } from "./journey-review.js";
import { readApprovedSnapshot, writeApprovedSnapshot } from "./journey-review-store.js";
import { anchorRuleMode, assertAnchorRules, journeyAnchorIssues, refLintFindings } from "./journey-anchor-gate.js";
import { journeyCatalogGate, loadCatalog, resolveCatalogDir } from "./catalog-api.js";
import { journeyDoneCheckFindings } from "./catalog-refs.js";
import type { JevSetup } from "./jev-advisor.js";
import { clock, contentHash, timePhase } from "@jevitate/domain";
import { dirname } from "node:path";
import { findProjectDir, type LayoutDeps } from "./project-dir.js";
import { resolveMissionFixture } from "@jevitate/explore";
import { ensureStepIds, fixtureNoRoot } from "@jevitate/recording";
import { redactErrorSecrets, operatorAllowedOrigins } from "./journey-api-redaction.js";
import { JourneyProposalArgsError, StaleReviewError, UnknownJourneyError, WeakJourneyError } from "./journey-api-errors.js";
import type { HealRunFields, MutationReplayOptions, RunJourneyProgrammaticallyOptions } from "./journey-api-heal.js";
import { prepareStoredJourneyRun, runPreparedStoredJourney, type MutationReplayFields, type RunEvidenceScope, type RunJourneyResult as MovedRunJourneyResult, type StoredJourneyRunContext, type StoredJourneyRunState } from "./journey-api-run.js";

export { effectiveAllowedOrigins, evidenceErrorOf, prefixParams, redactErrorSecrets, redactSecretParams, redactSecretValues, runSecretValues } from "./journey-api-redaction.js";
export { operatorAllowedOrigins };
export { JourneyProposalArgsError, JourneyRequiresAuthError, StaleReviewError, UnknownJourneyError, WeakJourneyError } from "./journey-api-errors.js";
export { draftOnStored, watchEscapedWrites, watchOffAllowlistWrites } from "./journey-api-heal.js";
export type { HealRunFields, MutationReplayOptions, RunJourneyProgrammaticallyOptions } from "./journey-api-heal.js";
export type { MutationReplayFields } from "./journey-api-run.js";


/** #401: the assertion-strength lint's verdict for one Journey (`journey lint`). */
export interface JourneyLintResult {
  id: string;
  findings: JourneyLintFinding[];
  errors: number;
  warnings: number;
}


/**
 * #488/#498: the project root relative `upload` fixture paths resolve against and must lie inside —
 * the directory holding a found `.jevitate/` project, and nothing else. No project ⇒ undefined, and
 * every upload is refused (`fixture-no-root`): a git root or the working directory (`/`, `$HOME`)
 * would confine nothing (0.12.0 review H1).
 */
export function journeyFixtureBaseDir(deps: LayoutDeps = {}): string | undefined {
  const project = findProjectDir(deps);
  return project === null ? undefined : dirname(project);
}

/**
 * #498: a mission's `--fixture`, checked at mission start against the project root — refused
 * (`fixture-no-root`) when there is no project, rather than only stat-checked (0.12.0 review H1).
 */
export async function resolveProjectMissionFixture(path: string, deps: LayoutDeps = {}): Promise<string> {
  const root = journeyFixtureBaseDir(deps);
  if (root === undefined) throw fixtureNoRoot(path);
  return resolveMissionFixture(path, root);
}

/**
 * #401: the assertion-strength lint (#401) for one Journey by id — an unknown id is refused,
 * exactly as `journey run`/`promote` refuse one (`UnknownJourneyError`). Pure read; no browser.
 */
export async function lintJourneyById(
  dir: string,
  id: string,
  opts: { readRequests?: readonly string[]; catalogDir?: string | null; baseDir?: string } = {},
): Promise<JourneyLintResult> {
  const registry = new JourneyRegistry(new FsJourneyStore(dir));
  const journey = await registry.get(id);
  if (!journey) {
    throw new UnknownJourneyError(`unknown journey '${id}'`);
  }
  // #466: the 0.10 anchor rules are warnings here (lintJourney's own, plus the catalog's jobStep/serves references).
  const { refIssues } = await journeyAnchorIssues(journey, { catalogDir: opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir: dir });
  // #488: resolve relative upload fixture paths against the project root (the `.jevitate` parent).
  const baseDir = opts.baseDir ?? journeyFixtureBaseDir();
  const lintOpts = {
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }),
  };
  // #498: with no project, every literal upload fixture is refused at run time — say so here too.
  const noRoot = baseDir === undefined ? lintUploadFixtures(journey, undefined) : [];
  // #800: the linked job's done-check findings (missing / invalid / cannot be false), about this Journey, and
  // (design §3.1) those of its own metadata.done, by the same rules.
  const doneFindings: JourneyLintFinding[] = [];
  const ownDone = journey.metadata.job === undefined ? lintJourneyDoneCheck(journey, lintOpts) : [];
  if (journey.metadata.job !== undefined) {
    const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
    const catalog = await loadCatalog(catalogDir, dir);
    ownDone.push(...journeyDoneCheckFindings(catalog, journey));
  }
  for (const f of ownDone) doneFindings.push({ rule: f.rule, level: f.level, message: f.message, ...(f.fix === undefined ? {} : { fix: f.fix }) });
  const findings = [...lintJourney(journey, lintOpts), ...noRoot, ...refLintFindings(refIssues), ...doneFindings];
  return {
    id,
    findings,
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
  };
}

/**
 * Promotes a local Journey (#124, mirrors `promoteMissionTarget` in
 * `mission-api.ts`) so it becomes discoverable via `journey find`/MCP
 * `find_capabilities` and runnable via `run_journey` — a human-approval gate,
 * same as `mission target promote`. An unknown id is refused with
 * `UnknownJourneyError` (never silently created). Returns the persisted,
 * now-promoted Journey.
 *
 * #401: lints first — a Journey whose assertions cannot prove its outcome is refused
 * (`WeakJourneyError`) unless the reviewer accepts it with a non-empty `--accept-weak <reason>`,
 * which is recorded on the Journey (`metadata.acceptedWeak`). Warnings never block.
 *
 * #432: records the approval (`metadata.approval`: the review hash, when, the waiver) and keeps a
 * snapshot of the approved Journey (`.approved/<id>.json`). Given `reviewedHash` (what the reviewer's
 * sheet showed), a Journey that changed since is refused (`StaleReviewError`) before anything else.
 *
 * #433: then the catalog gate (`journeyCatalogGate`): a Journey linking a job/persona that is not
 * approved is refused (`UnvettedLinksError`) unless `acceptUnvetted` (recorded in
 * `approval.waivers`), and the shared pre-approval findings are acknowledged (`acceptFindings`,
 * recorded in `approval.acceptedFindings`) — the same pipeline `persona|job approve` and
 * `demo approve` use. `catalogDir` (default: the project's `.jevitate/`) holds personas/jobs.
 */
export interface PromoteJourneyOptions {
  acceptWeak?: string;
  reviewedHash?: string;
  acceptUnvetted?: string;
  acceptFindings?: string;
  /** The catalog's directory; undefined: the project's `.jevitate/` (none outside a project). */
  catalogDir?: string | null;
  /** Which approval path asks (`demo approve` promotes through here too). */
  action?: "journey promote" | "demo approve";
  /** #434/#435: the advisory Jev layer of the pre-approval readiness and analysis (`--real`), or why it is skipped. */
  jev?: JevSetup;
  /**
   * #437: confirms the approval (after every gate, before anything is written) and returns its
   * provenance — the CLI's `makeApprovalConfirm` (a typed confirmation on a TTY, the escape hatch,
   * or the MCP channel). Omitted: recorded as `non-interactive` (`programmaticProvenance`).
   */
  confirm?: ApprovalConfirm;
  /**
   * #453: accept this pending self-heal proposal (its id) instead of promoting the stored Journey as
   * is. The proposal is re-checked (stale / proof untouched), goes through every gate as the
   * Journey it would make, is confirmed with the proposal shown, and `reviewedHash` is compared with
   * ITS `proposedHash`. Only this writes the stored Journey.
   */
  proposal?: string;
  /** #453: reject this pending proposal (its id) — needs `reason`; the stored Journey is untouched. */
  rejectProposal?: string;
  reason?: string;
  /** #453: how the rejection was made (`rejectionProvenance`); omitted: the programmatic one. */
  rejectProvenance?: ApprovalProvenance;
  /** #498: the project root upload fixtures must lie inside; default `journeyFixtureBaseDir()`. */
  fixtureBaseDir?: string;
}

export async function promoteJourney(dir: string, id: string, opts: PromoteJourneyOptions = {}): Promise<Journey> {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);

  const existing = await registry.get(id);
  if (!existing) {
    throw new UnknownJourneyError(`unknown journey '${id}'`);
  }
  if (opts.proposal !== undefined && opts.rejectProposal !== undefined) {
    throw new JourneyProposalArgsError("--proposal and --reject-proposal are exclusive: accept or reject, not both");
  }
  if (opts.rejectProposal !== undefined) {
    const why = opts.reason?.trim() ?? "";
    if (why === "") throw new JourneyProposalArgsError("--reject-proposal needs --reason <text> (it is recorded with the rejection)");
    await rejectJourneyProposal(dir, id, opts.rejectProposal, { reason: why, provenance: opts.rejectProvenance ?? programmaticProvenance() });
    return existing;
  }
  // #453: the proposal being accepted, re-checked against the stored Journey; the gates below judge the Journey it would make.
  const proposal = opts.proposal === undefined ? null : await requireJourneyProposal(dir, id, opts.proposal);
  if (proposal !== null) {
    const problem = checkProposal(existing, proposal);
    if (problem !== null) throw problem;
  }
  const reviewed: Journey = proposal === null ? existing : proposedJourney(existing, proposal);
  // #467: promote mints a stable id for every step that lacks one — BEFORE hashing, so the approval
  // binds to the Journey as stored (the store's own mint is then a no-op). Only ids are added.
  const mintedRecording = ensureStepIds(reviewed.recording);
  // #466: and stamps each anchor with the id of the step it follows (its integer `step` is kept for the bundle).
  const subject: Journey = stampAnchorStepIds(mintedRecording === reviewed.recording ? reviewed : { ...reviewed, recording: mintedRecording });
  // #432: approval binds to what the reviewer read — refused when the Journey changed since. A review
  // of the Journey before promote minted its missing step ids still matches (it differs only by them).
  const contentHash = journeyReviewHash(subject);
  const reviewedNow = opts.reviewedHash?.trim().toLowerCase();
  if (reviewedNow !== undefined && reviewedNow !== contentHash && (subject === reviewed || reviewedNow !== journeyReviewHash(reviewed))) {
    throw new StaleReviewError(
      `journey '${id}' changed after its review sheet was produced (reviewed ${reviewedNow}, now ${contentHash}) — review it again: jevitate journey review ${id}`,
    );
  }
  // #498: an upload fixture outside the project root (or a sensitive one inside it) is refused at
  // run time, so it is never promoted either — not waivable by --accept-weak (no override flag).
  const refused = lintUploadFixtures(subject, opts.fixtureBaseDir ?? journeyFixtureBaseDir()).filter(
    (f) => f.rule === "upload-outside-project" || f.rule === "upload-sensitive-file",
  );
  if (refused.length > 0) {
    throw new WeakJourneyError(
      [
        `journey '${id}' uploads ${refused.length} fixture(s) that would be refused:`,
        ...refused.map((f) => f.message),
        "move the fixture into the project as a dedicated test fixture file",
      ].join("\n"),
      refused,
    );
  }
  const errors = lintJourney(subject).filter((f) => f.level === "error");
  const reason = opts.acceptWeak?.trim() ?? "";
  if (errors.length > 0 && reason === "") {
    throw new WeakJourneyError(
      [
        `journey '${id}' has ${errors.length} assertion-strength error(s):`,
        ...errors.map((f) => f.message),
        "strengthen the Journey or pass --accept-weak <reason>",
      ].join("\n"),
      errors,
    );
  }
  const acceptedWeak = errors.length > 0 ? { reason, rules: [...new Set(errors.map((f) => f.rule))] } : undefined;
  const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
  const gate = await journeyCatalogGate(subject, {
    catalogDir,
    journeysDir: dir,
    action: opts.action ?? "journey promote",
    ...(opts.acceptUnvetted === undefined ? {} : { acceptUnvetted: opts.acceptUnvetted }),
    ...(opts.acceptFindings === undefined ? {} : { acceptFindings: opts.acceptFindings }),
    ...(opts.jev === undefined ? {} : { jev: opts.jev }),
  });
  // #466: a new promotion, or a re-promotion that changed beyond step ids, must follow the anchor rules;
  // an unchanged or step-id-only (#467 backfill) re-approval only warns (lint / the review sheet).
  const priorHash = existing.metadata.approval?.contentHash;
  const mode = anchorRuleMode(subject, priorHash === undefined ? {} : { approvedHash: priorHash, approvedSnapshot: (await readApprovedSnapshot(dir, id)) ?? existing });
  if (mode === "enforce") assertAnchorRules(id, await journeyAnchorIssues(subject, { catalogDir, journeysDir: dir, enforce: true }));
  // #437: the person confirms the approval and each waiver given with it (or it is refused) — then it is recorded with how it was made.
  // #469: in CI, the confirmation first asks the forge whether a merged, approved PR made this Journey (`pr-review`).
  const entry = journeyEntry(dir, id, contentHash);
  const provenance =
    opts.confirm === undefined
      ? programmaticProvenance()
      : await opts.confirm({
          kind: opts.action === "demo approve" ? "demo" : "journey",
          id,
          contentHash,
          ...(entry === null ? {} : { entry }),
          ...(proposal === null
            ? {}
            : {
                proposal: {
                  id: proposal.proposalId,
                  baseHash: proposal.baseHash,
                  steps: proposal.steps.map((st) => ({ number: st.index + 1, before: describeStep(st.before), after: describeStep(st.after) })),
                },
              }),
          waivers: [
            ...(acceptedWeak === undefined ? [] : [{ flag: "--accept-weak", reason: acceptedWeak.reason, detail: acceptedWeak.rules.join(", ") }]),
            ...(gate.waivers ?? []).map((w) => ({ flag: "--accept-unvetted", reason: w.reason, detail: w.items.join(", ") })),
            ...(gate.acceptedFindings === undefined ? [] : [{ flag: "--accept-findings", reason: gate.acceptedFindings.reason, detail: gate.acceptedFindings.findings.join(", ") }]),
          ],
        });
  const approval: JourneyApproval = {
    contentHash,
    at: clock.nowIso(),
    provenance,
    ...(acceptedWeak === undefined ? {} : { acceptedWeak: { ...acceptedWeak, provenance } }),
    ...(gate.waivers === undefined ? {} : { waivers: gate.waivers.map((w) => ({ ...w, provenance })) }),
    ...(gate.acceptedFindings === undefined ? {} : { acceptedFindings: { ...gate.acceptedFindings, provenance } }),
    ...(proposal === null ? {} : { proposal: { id: proposal.proposalId, baseHash: proposal.baseHash, steps: proposal.steps.map((st) => st.index) } }),
  };
  const promoted: Journey = {
    ...subject,
    // #466: subject's metadata — the existing one plus the anchors' stamped step ids (what the approval hashed).
    metadata: { ...subject.metadata, promoted: true, ...(acceptedWeak === undefined ? {} : { acceptedWeak }), approval },
  };
  await store.put(promoted);
  // #432: the Journey as approved — the next review diffs against it ("change since last approval").
  await writeApprovedSnapshot(dir, promoted);
  // #453: an accepted proposal is spent.
  if (proposal !== null) await deleteJourneyProposal(dir, id);
  return (await registry.get(id)) ?? promoted;
}

/**
 * The one programmatic surface for "run this published Journey by id" —
 * used by BOTH the CLI `journey run` action and external callers. Builds
 * the real `FsJourneyStore` + `JourneyRegistry`, resolves the journey
 * (unknown id -> `UnknownJourneyError`), validates params UP FRONT with
 * `journeyParamSchema`/`validateParams` (unknown/missing param ->
 * `ParamValidationError`, from `@jevitate/journey`) BEFORE any browser is
 * launched, then builds the real Actor + `JourneyRunner` and runs.
 */
/** The result of a stored-journey run: `journey-api-run.ts`'s shape, still named and exported here. */
export type RunJourneyResult = MovedRunJourneyResult & MutationReplayFields & HealRunFields;

/**
 * #812/#800: a surface's run (one with a `runRecorder`: `journey run` and `run_journey`) writes its
 * RunEvidence v1 record to its own directory beside the #790 record, whatever the outcome, refusals and
 * errors included. Writing it never changes the outcome: why it could not be written is `evidenceError`
 * on the result, or on the error the run threw, as `runRecordError` is.
 */
export async function runJourneyProgrammatically(opts: RunJourneyProgrammaticallyOptions, mutation: MutationReplayOptions = {}): Promise<RunJourneyResult & { evidenceError?: string }> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  // #852: loading the stored Journey is `prepare`; writing its evidence after the run is `report`.
  const stored = await timePhase("prepare", () => registry.get(opts.id));
  if (!stored) {
    throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  }
  opts.runRecorder?.noteJourney(stored);
  const evidence = runEvidenceFor(opts, stored);
  if (evidence !== undefined) opts.runRecorder?.deriveFrom(evidence.writer);
  let result: RunJourneyResult;
  try {
    result = await runStoredJourney(opts, mutation, stored, evidence);
  } catch (err) {
    const problem = evidence?.finish(err);
    if (problem !== undefined && err !== null && typeof err === "object") (err as { evidenceError?: string }).evidenceError = problem;
    throw err;
  }
  const problem = await timePhase("report", async () => evidence?.finish(undefined, result));
  const withReceipts = evidence === undefined ? result : { ...result, writes: evidence.writer.receipts() };
  return problem === undefined ? withReceipts : { ...withReceipts, evidenceError: problem };
}


const STEP_KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ERROR_CODE = /^E_[A-Z0-9_]{1,62}$/;

function runEvidenceFor(opts: RunJourneyProgrammaticallyOptions, stored: Journey): RunEvidenceScope | undefined {
  const recorder = opts.runRecorder;
  if (recorder === undefined) return undefined;
  let dir: string;
  let writer: JourneyRunEvidenceWriter;
  try {
    const at = recorder.evidenceDir();
    // Run records are off (`JEVITATE_RUN_RECORD=off`): no evidence either, and the recorder watches for itself.
    if (at === undefined) return undefined;
    dir = at;
    writer = new JourneyRunEvidenceWriter({
      channel: recorder.channel,
      journey: { id: opts.id, hash: contentHash(stored) },
      params: opts.params,
      secretParamNames: secretParamNames(stored),
      origin: opts.environment?.baseUrl ?? stored.recording.site,
      ...(opts.environment?.name === undefined ? {} : { environment: opts.environment.name }),
      keyFile: recorder.evidenceKeyFile,
    });
  } catch {
    // A record that cannot even start never fails the run: the #790 record still says what ran.
    return undefined;
  }
  const reported = new Set<number>();
  let kinds: string[] = flatJourneySteps(stored).map((s) => s.recorded.step.kind);
  const kindOf = (index: number): string => {
    const k = kinds[index - 1] ?? "unknown";
    return STEP_KIND.test(k) ? k : "other";
  };
  const hooks: { mode: RunMode | undefined } = { mode: undefined };
  return {
    writer,
    hooks,
    observer: () => ({
      beforeStep: async ({ index }) => writer.beginStep(index + 1),
      afterStep: async ({ index, recorded, outcome }) => {
        reported.add(index + 1);
        writer.noteStep({
          index: index + 1,
          kind: kindOf(index + 1),
          outcome: outcome === "done" ? "ok" : outcome === "failed" ? "failed" : "skipped",
          // A failed step may have failed its action or its expect: which, this run does not tell.
          postcondition: outcome === "failed" ? { known: false, reason: "not-gathered" } : outcome === "done" && "expect" in recorded.step && recorded.step.expect !== undefined ? "held" : "none",
        });
      },
    }),
    ran: (journey) => {
      writer.noteJourney(journey);
      kinds = flatJourneySteps(journey).map((s) => s.recorded.step.kind);
    },
    finish: (err, result) => {
      if (err !== undefined) {
        const e = err as { code?: unknown; extra?: { at?: unknown } } | null;
        const code = typeof e?.code === "string" && ERROR_CODE.test(e.code) ? e.code : undefined;
        const at = e?.extra?.at;
        if (code !== undefined && typeof at === "number" && Number.isInteger(at) && at >= 1) {
          reported.add(at);
          writer.noteStep({ index: at, kind: kindOf(at), outcome: "refused", postcondition: "none", refusal: code });
        }
        writer.note(code === undefined ? "the run ended with an error" : `the run ended with ${code}`);
      } else if (result !== undefined) writer.note(`the run ended ${STEP_KIND.test(result.outcome) ? result.outcome : "with an outcome"}`);
      for (let i = 1; i <= kinds.length; i++) if (!reported.has(i)) writer.noteStep({ index: i, kind: kindOf(i), outcome: "not-reached", postcondition: "none" });
      return writer.finish(dir);
    },
  };
}

async function runStoredJourney(opts: RunJourneyProgrammaticallyOptions, mutation: MutationReplayOptions, stored: Journey, evidence: RunEvidenceScope | undefined): Promise<RunJourneyResult> {
  await opts.assertRunnable?.(stored);
  const ctx: StoredJourneyRunContext = { opts, mutation, stored, evidence, fixtureBaseDir: journeyFixtureBaseDir, operatorAllowedOrigins: (journey) => operatorAllowedOrigins(journey, opts.environment, opts.allow) };
  const prep = await prepareStoredJourneyRun(ctx);
  const fx = opts.fixtures?.(prep.journey.recording.site, prep.allowedOrigins, stored.recording.site);
  const state: StoredJourneyRunState = { params: { ...prep.secretPlan.params, ...prep.inputParams }, declaredSecrets: undefined };
  try {
    return await runPreparedStoredJourney(prep, state, fx, ctx);
  } catch (err) {
    // A replay that ends before the run's own secret set is told it (a fixture's setup): what it knew by then.
    mutation.onRunSecrets?.([...new Set([...secretParamValues(stored, state.params), ...(fx?.secrets() ?? []), ...prep.secretPlan.values])]);
    // #399: an error escaping the run (a crash, a closed page) may echo a navigated URL that
    // carried a secret parameter — its message and stack are redacted, its class kept.
    throw redactErrorSecrets(err, secretParamValues(prep.journey, { ...prep.inputParams, ...state.params }));
  } finally {
    state.declaredSecrets?.release();
    await fx?.restore();
    if (mutation.onFixtureRestoreFailed !== undefined && fx?.restoreFailed() === true) mutation.onFixtureRestoreFailed();
  }
}
