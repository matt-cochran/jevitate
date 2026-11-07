import { explainCheck, expectedResultFromDelta } from "@jevitate/explore";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AnnotationDraftSchema,
  FsJourneyStore,
  applyAnnotationDraft,
  describeStep,
  flatJourneySteps,
  intentCoverage,
  journeyAssertions,
  secretParamValues,
  type AnnotationChange,
  type AnnotationDraft,
  type IntentCoverage,
  type Journey,
  type ApprovalProvenance,
} from "@jevitate/journey";
import { assertNoSecretInPayload, redactText, redactUrl, type GenerationPort, type GenerationProvenance } from "@jevitate/ai-core";
import { contentHash, clock } from "@jevitate/domain";
import type { StepObserver } from "@jevitate/interpreter";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import { ApprovalNeedsHumanError, approvalRefusal, makeApprovalConfirm, type ApprovalDeps, type ApprovalConfirm, type ApprovalRequest } from "./approval-provenance.js";
import { readDemoDraft } from "./demo-aspect-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { AnnotationTransactionError, annotationApprovalPath, annotationTransaction, parseAnnotationApproval, readAnnotationFile, removeAnnotationDraft, withAnnotationTransaction, writeAnnotationApproval, type AnnotationApproval, type AnnotationFile, type AnnotationTransaction, type AnnotationOrigin } from "./journey-annotation-approval-store.js";
import { runJourneyProgrammatically, UnknownJourneyError, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #246 — `jevitate journey annotate`: replay a Journey, capture redacted before/after page evidence
 * per step, and ask the generation gateway to DRAFT each step's objective / expected result (and the
 * Journey's goal / success criteria when missing). The draft goes to a sidecar file and NEVER into
 * the Journey: `approveJourneyAnnotations` writes it only on an explicit human approval, and only
 * while the Journey is unchanged since the draft (content hash).
 */

/** Visible text kept per page for the model (redacted first, then bounded). */
const EVIDENCE_TEXT_CHARS = 1500;

export class AnnotationDraftNotFoundError extends Error {
  readonly code = "E_JOURNEY_ANNOTATIONS_NOT_FOUND";
}
export class InvalidAnnotationDraftError extends Error {
  readonly code = "E_INVALID_ANNOTATIONS_DRAFT";
}
/** The Journey changed after the draft was made — approving would annotate steps it never saw. */
export class StaleAnnotationDraftError extends Error {
  readonly code = "E_JOURNEY_ANNOTATIONS_STALE";
}

/**
 * Where a Journey's draft lives: `<journeys>/.drafts/<id>.annotations.json` (`<ns>/<id>` for a shared
 * Journey). A dot-folder, so `journey list` and namespace discovery never read it as a Journey.
 */
export function annotationDraftPath(journeysDir: string, id: string): string {
  const parts = id.split("/");
  return join(journeysDir, ".drafts", ...parts.slice(0, -1), `${parts[parts.length - 1] ?? id}.annotations.json`);
}

/** The Journey's content hash — what a draft is bound to. */
export function journeyContentHash(journey: Journey): string {
  return contentHash(journey);
}

async function loadJourney(dir: string, id: string): Promise<Journey> {
  const journey = await new FsJourneyStore(dir).get(id);
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}'`);
  return journey;
}

interface PageEvidence {
  readonly url: string;
  readonly heading: string;
  readonly text: string;
}

/** BROWSER CODE — the page's main heading (else its title) and visible text. */
function readPage(): { heading: string; text: string } {
  const h1 = document.querySelector("h1");
  const heading = ((h1 as HTMLElement | null)?.innerText ?? h1?.textContent ?? "").trim() || (document.title ?? "");
  return { heading, text: document.body?.innerText ?? "" };
}

/** Redacted page evidence (never throws: an unreadable page is empty evidence). */
async function capture(actor: Actor, secrets: readonly string[]): Promise<PageEvidence> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const raw = await page.evaluate(readPage).catch(() => ({ heading: "", text: "" }));
  const scrub = (s: string): string => redactText(s, secrets);
  return {
    url: scrub(redactUrl(page.url())),
    heading: scrub(raw.heading.replace(/\s+/g, " ").trim()).slice(0, 300),
    // Redact the WHOLE text before bounding it, so a cut never splits a secret past the redactor.
    text: scrub(raw.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()).slice(0, EVIDENCE_TEXT_CHARS),
  };
}

/**
 * #755 — the corpus a drafted success criterion must be grounded in: the final page as replayed (URL,
 * heading, visible text) plus every assertion the Journey already makes. A criterion may quote that
 * page text or restate an assertion; a claim the evidence does not show is unverifiable.
 */
interface GroundingCorpus {
  readonly text: string;
  readonly words: ReadonlySet<string>;
}

/** Filler words that carry no claim of their own, so they need no evidence on the page. */
const GROUNDING_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "when", "then", "than",
  "are", "was", "were", "has", "have", "had", "its", "their", "there", "here", "all", "any",
  "not", "only", "what", "which", "who", "now", "also", "page", "final", "shows", "show",
  "showing", "displays", "display", "displayed", "lists", "listed", "list", "contains", "contain",
  "includes", "include", "exists", "exist", "success", "criterion", "criteria", "after", "before",
]);

function foldText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordsOf(s: string): string[] {
  return foldText(s).split(/[^a-z0-9]+/).filter((w) => w !== "");
}

/** The excerpts a criterion quotes (double/single/curly quotes or backticks), folded for comparison. */
function quotedExcerpts(text: string): string[] {
  const out: string[] = [];
  const re = /["'“”‘’`]([^"'“”‘’`]{1,300})["'“”‘’`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const q = foldText(m[1]!);
    if (q !== "") out.push(q);
  }
  return out;
}

/** #755 — does the final page or an existing assertion show what `criterion` claims? */
function criterionIsGrounded(criterion: string, corpus: GroundingCorpus): boolean {
  const quotes = quotedExcerpts(criterion);
  if (quotes.length > 0) return quotes.every((q) => corpus.text.includes(q));
  const words = wordsOf(criterion).filter((w) => w.length >= 3 && !GROUNDING_STOPWORDS.has(w));
  if (words.length === 0) return false;
  return words.every((w) => corpus.words.has(w));
}

export interface AnnotateJourneyOptions
  extends Omit<RunJourneyProgrammaticallyOptions, "interpreter" | "policy" | "selfHealer"> {
  /** The generation gateway that drafts the text (`--real` / `--fake-ai`). */
  gen: GenerationPort;
  /** Testing seam for the draft's timestamp. */
  now?: () => string;
}

export interface AnnotateJourneyResult {
  readonly id: string;
  readonly draftPath: string;
  readonly replay: AnnotationDraft["replay"];
  readonly drafted: { readonly objectives: number; readonly expectedResults: number; readonly goal: boolean; readonly successCriteria: number };
  /** What approving the draft would change (the same diff `--approve` shows). */
  readonly proposed: AnnotationChange[];
  readonly coverage: IntentCoverage;
  /** #755: drafted success criteria dropped because the final page and the assertions do not show them. */
  readonly unverifiableCriteria: string[];
  /** #251 `--screenshots`: the replay's masked screenshots and their `index.md`. */
  readonly screenshotPaths?: string[];
  readonly screenshotIndex?: string;
  readonly screenshotsSkipped?: Array<{ readonly step: number; readonly reason: string }>;
}

/**
 * Replays the Journey through `runJourneyProgrammatically` (the same session, site policy, fixtures
 * and fail-closed policy as `journey run`) with an observing interpreter, then drafts. A replay that
 * stops early still drafts the steps it reached (`replay.outcome: "stopped"`).
 *
 * Environments (#247): every browser/session option `journey run` takes rides in `opts` and is
 * handed to `runJourneyProgrammatically` unchanged — including `environment` (`--env`/`--base-url`,
 * resolved by `resolveJourneyEnvironment`), so the replay is rebased and allowlisted exactly as a run.
 */
export async function annotateJourney(opts: AnnotateJourneyOptions): Promise<AnnotateJourneyResult> {
  const journey = await loadJourney(opts.dir, opts.id);
  const journeyHash = journeyContentHash(journey);
  const secrets = secretParamValues(journey, opts.params);
  const flat = flatJourneySteps(journey);

  const before = new Map<number, PageEvidence>();
  const after = new Map<number, PageEvidence | null>();
  const observer: StepObserver = {
    beforeStep: async ({ actor, index }) => {
      before.set(index, await capture(actor, secrets));
    },
    afterStep: async ({ actor, index, outcome }) => {
      after.set(index, outcome === "done" ? await capture(actor, secrets) : null);
    },
  };
  const { gen, now, ...runOpts } = opts;
  const run = await runJourneyProgrammatically({ ...runOpts, observer });
  const reachedSteps = before.size;
  const replay: AnnotationDraft["replay"] = run.outcome === "quarantined"
    ? { outcome: "stopped", reachedSteps, totalSteps: flat.length, reason: redactText(run.reason, secrets).slice(0, 2000) }
    : { outcome: "completed", reachedSteps, totalSteps: flat.length };

  const m = journey.metadata;
  const context = redactText(
    m.goal ?? [m.name, m.description, journey.recording.intent].filter((s) => s !== undefined && s !== "").join(" — "),
    secrets,
  );
  const clean = (s: string | null | undefined): string | undefined => {
    const t = s === null || s === undefined ? "" : redactText(s, secrets).trim();
    return t === "" ? undefined : t;
  };

  let provenance: GenerationProvenance | undefined;
  const steps: AnnotationDraft["steps"] = [];
  const stepLines: string[] = [];
  for (const s of flat) {
    const described = redactText(describeStep(s.recorded.step), secrets);
    const b = before.get(s.index);
    const needObjective = (s.recorded.objective ?? "").trim() === "";
    const needExpected = (s.recorded.expectedResult ?? "").trim() === "";
    let objective = s.recorded.objective;
    // #303 (`--action-deltas`): the expected result is drafted by code from what the step changed.
    const observed = run.actionDeltas?.steps.find((x) => x.step === s.index + 1);
    const fromDelta = needExpected && observed !== undefined ? clean(expectedResultFromDelta(observed.delta)) : undefined;
    if (b !== undefined && fromDelta !== undefined && !needObjective) {
      const a = after.get(s.index) ?? null;
      steps.push({
        index: s.index,
        step: described.slice(0, 1000),
        expectedResult: fromDelta,
        evidence: { before: { url: b.url, heading: b.heading }, after: a === null ? null : { url: a.url, heading: a.heading } },
      });
    } else if (b !== undefined && (needObjective || needExpected)) {
      const a = after.get(s.index) ?? null;
      const input = { journey: context, stepNumber: s.index + 1, totalSteps: flat.length, step: described, before: b, after: a };
      assertNoSecretInPayload(input, secrets); // fail closed: nothing secret reaches a model
      const { output, provenance: p } = await gen.generate("journey.step", input);
      provenance = p;
      const draftObjective = needObjective ? clean(output.objective) : undefined;
      const draftExpected = needExpected ? (fromDelta ?? clean(output.expectedResult)) : undefined;
      objective = draftObjective ?? objective;
      if (draftObjective !== undefined || draftExpected !== undefined) {
        steps.push({
          index: s.index,
          step: described.slice(0, 1000),
          ...(draftObjective === undefined ? {} : { objective: draftObjective }),
          ...(draftExpected === undefined ? {} : { expectedResult: draftExpected }),
          evidence: {
            before: { url: b.url, heading: b.heading },
            after: a === null ? null : { url: a.url, heading: a.heading },
          },
        });
      }
    }
    stepLines.push(`${s.index + 1}. ${described}${objective === undefined ? "" : ` — ${redactText(objective, secrets)}`}`.slice(0, 1200));
  }

  let goal: string | undefined;
  let successCriteria: string[] | undefined;
  const unverifiableCriteria: string[] = [];
  // #755: the assertions the Journey already makes (step postconditions and end state) — shown to the
  // model and the only other evidence a drafted success criterion may claim besides the final page.
  const assertionTexts = journeyAssertions(journey).map((site) => redactText(explainCheck(site.check).text, secrets));
  const needGoal = (m.goal ?? "").trim() === "";
  const needCriteria = (m.successCriteria ?? []).length === 0;
  if (needGoal || needCriteria) {
    const lastReached = [...before.keys()].sort((x, y) => y - x)[0];
    const finalPage = lastReached === undefined ? null : (after.get(lastReached) ?? before.get(lastReached) ?? null);
    const input = {
      name: redactText(m.name, secrets).slice(0, 500),
      ...(m.description === undefined ? {} : { description: redactText(m.description, secrets).slice(0, 2000) }),
      ...(journey.recording.intent === undefined ? {} : { intent: redactText(journey.recording.intent, secrets).slice(0, 2000) }),
      steps: stepLines.slice(0, 200),
      assertions: assertionTexts.map((a) => a.slice(0, 500)).slice(0, 200),
      finalPage,
    };
    assertNoSecretInPayload(input, secrets);
    const { output, provenance: p } = await gen.generate("journey.goal", input);
    provenance = p;
    if (needGoal) goal = clean(output.goal);
    if (needCriteria) {
      const corpusText = foldText([finalPage?.url ?? "", finalPage?.heading ?? "", finalPage?.text ?? "", ...assertionTexts].join("\n"));
      const corpus: GroundingCorpus = { text: corpusText, words: new Set(wordsOf(corpusText)) };
      const drafted = output.successCriteria.map((c) => clean(c)).filter((c): c is string => c !== undefined);
      const kept: string[] = [];
      for (const criterion of drafted) {
        if (criterionIsGrounded(criterion, corpus)) kept.push(criterion);
        else unverifiableCriteria.push(criterion);
      }
      if (kept.length > 0) successCriteria = kept;
      else if (drafted.length > 0 && assertionTexts.length > 0) {
        // #755: nothing drafted was shown by the evidence — fall back to one minimal, truthful assertion.
        const fallback = clean(assertionTexts[assertionTexts.length - 1]);
        if (fallback !== undefined) successCriteria = [fallback];
      }
    }
  }

  const draft: AnnotationDraft = AnnotationDraftSchema.parse({
    kind: "jevitate.journey-annotations.draft",
    version: 1,
    journeyId: opts.id,
    journeyHash,
    createdAtIso: (now ?? (() => clock.nowIso()))(),
    provenance: provenance === undefined
      ? { adapter: "none", model: "none", promptVersion: "none" }
      : { adapter: provenance.adapter, model: provenance.model, promptVersion: provenance.promptVersion },
    replay,
    ...(goal === undefined ? {} : { goal }),
    ...(successCriteria === undefined ? {} : { successCriteria }),
    steps,
  });
  assertNoSecretInPayload(draft, secrets, "journey annotation draft"); // the last line: never at rest
  const draftPath = annotationDraftPath(opts.dir, opts.id);
  await mkdir(dirname(draftPath), { recursive: true, mode: 0o700 });
  await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });

  return {
    id: opts.id,
    draftPath,
    replay,
    drafted: {
      objectives: steps.filter((s) => s.objective !== undefined).length,
      expectedResults: steps.filter((s) => s.expectedResult !== undefined).length,
      goal: goal !== undefined,
      successCriteria: successCriteria?.length ?? 0,
    },
    proposed: applyAnnotationDraft(journey, draft).changes,
    coverage: intentCoverage(journey),
    unverifiableCriteria,
    ...(run.screenshotPaths === undefined ? {} : { screenshotPaths: run.screenshotPaths }),
    ...(run.screenshotIndex === undefined ? {} : { screenshotIndex: run.screenshotIndex }),
    ...(run.screenshotsSkipped === undefined ? {} : { screenshotsSkipped: run.screenshotsSkipped }),
  };
}

export interface ApproveAnnotationsResult {
  readonly id: string;
  readonly draftPath: string;
  readonly changes: AnnotationChange[];
  readonly coverage: IntentCoverage;
}

/** Reads and validates a Journey's draft (not found / invalid are typed refusals). */
export async function readAnnotationDraft(dir: string, id: string): Promise<{ draft: AnnotationDraft; draftPath: string }> {
  const draftPath = annotationDraftPath(dir, id);
  let raw: string;
  try {
    raw = await readFile(draftPath, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      throw new AnnotationDraftNotFoundError(`no annotation draft for journey '${id}' (${draftPath}) — run \`jevitate journey annotate ${id}\` first`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidAnnotationDraftError(`${draftPath} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = AnnotationDraftSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidAnnotationDraftError(`${draftPath} is not a valid annotation draft: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  if (result.data.journeyId !== id) {
    throw new InvalidAnnotationDraftError(`${draftPath} is a draft for journey '${result.data.journeyId}', not '${id}'`);
  }
  return { draft: result.data, draftPath };
}

export type AnnotationState = "missing" | "pending-human" | "approved-pending-apply" | "applied-current" | "stale" | "invalid" | "recovery-required";
export interface AnnotationStatus {
  readonly kind: "journey-annotation-status";
  readonly version: 1;
  readonly id: string;
  readonly state: AnnotationState;
  readonly currentContentHash: string;
  readonly currentReviewHash: string;
  readonly draftPresent: boolean;
  readonly transaction: AnnotationTransaction | null;
  readonly approval: Pick<AnnotationApproval, "phase" | "at" | "provenance"> | null;
  readonly changesCount: number | null;
  readonly reason: "draft-missing" | "draft-stale" | "invalid-state" | "transaction-conflict" | "apply-incomplete" | null;
}
interface AnnotationPreview {
  status: AnnotationStatus;
  journey: Journey;
  candidate: Journey;
  changes: AnnotationChange[];
  draft: AnnotationFile | null;
  receipt: AnnotationFile | null;
  record: AnnotationApproval | null;
}

/** Internal native candidate projection; no caller-supplied Journey, policy or receipt is accepted. */
export async function previewJourneyAnnotations(dir: string, id: string): Promise<AnnotationPreview> {
  const store = new FsJourneyStore(dir);
  let journey: Journey | null;
  try { journey = await store.getGuarded(id); } catch { throw new AnnotationTransactionError(); }
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}'`);
  const currentContentHash = journeyContentHash(journey);
  const currentReviewHash = journeyReviewHash(journey);
  let draft: AnnotationFile | null = null;
  let receipt: AnnotationFile | null = null;
  let record: AnnotationApproval | null = null;
  const base = { kind: "journey-annotation-status" as const, version: 1 as const, id, currentContentHash, currentReviewHash };
  const result = (state: AnnotationState, reason: AnnotationStatus["reason"], transaction: AnnotationTransaction | null = record?.transaction ?? null, candidate = journey, changes: AnnotationChange[] = []): AnnotationPreview => ({
    status: { ...base, state, reason, draftPresent: draft !== null, transaction,
      approval: record === null || transaction?.hash !== record.transaction.hash ? null : { phase: record.phase, at: record.at, provenance: record.provenance },
      changesCount: state === "invalid" || state === "stale" || state === "recovery-required" || state === "missing" ? null : changes.length },
    journey, candidate, changes, draft, receipt, record,
  });
  try {
    const path = annotationDraftPath(dir, id);
    draft = await readAnnotationFile(dir, path);
    receipt = await readAnnotationFile(dir, annotationApprovalPath(path));
    record = parseAnnotationApproval(receipt, id);
    const draftHash = draft === null ? null : contentHash({ domain: "jevitate.annotation-draft.v1", raw: draft.raw });
    if (record !== null) {
      const t = record.transaction;
      if (currentContentHash === t.afterContentHash && currentReviewHash !== t.afterReviewHash) return result("invalid", "invalid-state");
      const sameDraft = draft === null || draftHash === t.draftHash;
      if (sameDraft && (currentContentHash === t.afterContentHash || (record.phase === "applied" && currentReviewHash === t.afterReviewHash))) {
        return result(record.phase === "applied" ? "applied-current" : "approved-pending-apply", record.phase === "applied" ? null : "apply-incomplete");
      }
      if (record.phase === "approved" && (currentContentHash !== t.beforeContentHash || draftHash !== t.draftHash)) return result("recovery-required", "transaction-conflict");
      if (record.phase === "applied" && (draft === null || draftHash === t.draftHash)) return result("stale", "transaction-conflict");
    }
    if (draft === null) return result("missing", "draft-missing");
    const parsed = AnnotationDraftSchema.parse(JSON.parse(draft.raw));
    if (parsed.journeyId !== id) return result("invalid", "invalid-state");
    if (parsed.journeyHash !== currentContentHash) return result("stale", "draft-stale");
    const applied = applyAnnotationDraft(journey, parsed);
    const candidate = store.normalizeForWrite(applied.journey);
    const transaction = annotationTransaction(id, { beforeContentHash: currentContentHash, draftHash: draftHash!, afterContentHash: journeyContentHash(candidate), afterReviewHash: journeyReviewHash(candidate) });
    if (record?.phase === "approved" && record.transaction.hash !== transaction.hash) return result("recovery-required", "transaction-conflict");
    return result(record?.phase === "approved" ? "approved-pending-apply" : "pending-human", record?.phase === "approved" ? "apply-incomplete" : null, transaction, candidate, applied.changes);
  } catch { return result("invalid", "invalid-state"); }
}

export async function annotationStatus(dir: string, id: string): Promise<AnnotationStatus> {
  return (await previewJourneyAnnotations(dir, id)).status;
}

export interface AnnotationApplyOptions {
  readonly approval?: ApprovalDeps;
  readonly reviewedHash?: string;
  readonly showChanges?: (changes: readonly AnnotationChange[]) => void;
  readonly demoAuthority?: AnnotationDemoAuthority;
}
export interface AnnotationDemoAuthority { readonly provenance: ApprovalProvenance }
const demoAuthorities = new WeakMap<AnnotationDemoAuthority, { root: string; id: string; hash: string; provenance: ApprovalProvenance; origin: Extract<AnnotationOrigin, { kind: "demo" }>; demoFile: { path: string; identity: string } }>();

/** Demo's one native confirmation seals exactly this annotation transaction. Lookalikes are rejected. */
export async function confirmDemoAnnotations(dir: string, id: string, request: ApprovalRequest, confirm: ApprovalConfirm): Promise<AnnotationDemoAuthority> {
  const before = await previewJourneyAnnotations(dir, id);
  const t = before.status.transaction;
  if (!["pending-human", "approved-pending-apply", "applied-current"].includes(before.status.state) || t === null || request.kind !== "demo" || request.id !== id || request.contentHash !== t.afterReviewHash) throw new AnnotationTransactionError();
  const demo = await readDemoDraft(dir, id);
  if (demo.record.journeyHash !== t.beforeContentHash) throw new AnnotationTransactionError();
  const origin: Extract<AnnotationOrigin, { kind: "demo" }> = { kind: "demo", draftHash: demo.digest, reviewHash: t.afterReviewHash, waivers: request.waivers.map((waiver) => ({ ...waiver })) };
  let provenance: ApprovalProvenance;
  if (before.status.state === "pending-human") provenance = await confirm(request);
  else {
    if (before.record?.origin.kind !== "demo" || contentHash(before.record.origin) !== contentHash(origin)) throw new AnnotationTransactionError();
    provenance = structuredClone(before.record.provenance);
  }
  const after = await previewJourneyAnnotations(dir, id);
  const checkedDemo = await readDemoDraft(dir, id);
  if (after.status.state !== before.status.state || after.status.transaction?.hash !== t.hash || after.draft?.identity !== before.draft?.identity || after.receipt?.identity !== before.receipt?.identity || checkedDemo.identity !== demo.identity) throw new AnnotationTransactionError();
  const authority: AnnotationDemoAuthority = Object.freeze({ provenance: structuredClone(provenance) });
  demoAuthorities.set(authority, { root: resolve(dir), id, hash: t.hash, provenance: structuredClone(provenance), origin, demoFile: { path: demo.path, identity: demo.identity } });
  return authority;
}

/** A sealed demo grant stays associated with the exact native demo record through apply/promotion. */
export async function validateDemoAnnotations(authority: AnnotationDemoAuthority): Promise<void> {
  const binding = demoAuthorities.get(authority);
  if (binding === undefined) throw new AnnotationTransactionError();
  const demo = await readDemoDraft(binding.root, binding.id);
  if (demo.identity !== binding.demoFile.identity || demo.digest !== binding.origin.draftHash) throw new AnnotationTransactionError();
  const preview = await previewJourneyAnnotations(binding.root, binding.id);
  if (!["pending-human", "approved-pending-apply", "applied-current"].includes(preview.status.state) || preview.status.transaction?.hash !== binding.hash) throw new AnnotationTransactionError();
  if (preview.record?.transaction.hash === binding.hash && (contentHash(preview.record.origin) !== contentHash(binding.origin) || contentHash(preview.record.provenance) !== contentHash(binding.provenance))) throw new AnnotationTransactionError();
}

/** Finish only the same native demo record, after render/promotion/export have succeeded. */
export async function finalizeDemoAnnotations(authority: AnnotationDemoAuthority): Promise<void> {
  const binding = demoAuthorities.get(authority);
  if (binding === undefined) throw new AnnotationTransactionError();
  await validateDemoAnnotations(authority);
  const status = await annotationStatus(binding.root, binding.id);
  if (status.state !== "applied-current" || status.transaction?.hash !== binding.hash || status.currentReviewHash !== binding.origin.reviewHash) throw new AnnotationTransactionError();
  await removeAnnotationDraft(binding.root, binding.demoFile.path, binding.demoFile);
}

export type AnnotationApplyResult = Omit<AnnotationStatus, "kind" | "state"> & ApproveAnnotationsResult & { readonly kind: "journey-annotation-apply"; readonly state: "applied-current" };

/** Confirm once, durably journal before mutation, then atomically apply or recover the exact native transaction. */
export async function approveJourneyAnnotations(dir: string, id: string, opts: AnnotationApplyOptions = {}): Promise<AnnotationApplyResult> {
  return withAnnotationTransaction<AnnotationApplyResult>(dir, id, async () => {
    let preview = await previewJourneyAnnotations(dir, id);
    const t = preview.status.transaction;
    if (preview.status.state === "missing") throw new AnnotationDraftNotFoundError("No native annotation draft or applied approval exists.");
    if (preview.status.state === "stale") throw new StaleAnnotationDraftError("The annotation draft or approval is stale; review a draft for the current Journey.");
    if (t === null || !["pending-human", "approved-pending-apply", "applied-current"].includes(preview.status.state) || (opts.reviewedHash !== undefined && opts.reviewedHash !== t.hash)) throw new AnnotationTransactionError();
    const demoBinding = opts.demoAuthority === undefined ? undefined : demoAuthorities.get(opts.demoAuthority);
    if (opts.demoAuthority !== undefined && (demoBinding?.root !== resolve(dir) || demoBinding.id !== id || demoBinding.hash !== t.hash)) throw new AnnotationTransactionError();
    if (opts.demoAuthority !== undefined) await validateDemoAnnotations(opts.demoAuthority);
    if ((preview.status.state === "approved-pending-apply" || preview.status.state === "applied-current") && preview.record?.provenance.channel !== "tty" && opts.demoAuthority === undefined) throw new ApprovalNeedsHumanError("This saved demo approval is not a human annotation approval; resume through its native demo approval path.");
    const draftPath = annotationDraftPath(dir, id);
    const receiptPath = annotationApprovalPath(draftPath);
    if (preview.status.state === "pending-human") {
      opts.showChanges?.(preview.changes);
      let provenance: ApprovalProvenance;
      if (opts.demoAuthority !== undefined) {
        provenance = structuredClone(demoBinding!.provenance);
      } else {
        provenance = await makeApprovalConfirm(opts.approval)({ kind: "annotations", id, contentHash: t.hash, waivers: [] });
      }
      if (opts.demoAuthority === undefined && provenance.channel !== "tty") throw new ApprovalNeedsHumanError("Annotation apply requires the native human terminal confirmation.");
      const checked = await previewJourneyAnnotations(dir, id);
      if (checked.status.state !== "pending-human" || checked.status.transaction?.hash !== t.hash || checked.draft?.identity !== preview.draft?.identity || checked.receipt?.identity !== preview.receipt?.identity) throw new AnnotationTransactionError();
      if (opts.demoAuthority !== undefined) await validateDemoAnnotations(opts.demoAuthority);
      const record: AnnotationApproval = { kind: "journey-annotation-approval", version: 1, id, transaction: t, phase: "approved", at: clock.nowIso(), provenance, origin: demoBinding?.origin ?? { kind: "annotations" } };
      await writeAnnotationApproval(dir, receiptPath, record, preview.receipt);
      preview = await previewJourneyAnnotations(dir, id);
    }
    const changes = preview.changes;
    if (preview.status.state === "approved-pending-apply") {
      if (opts.demoAuthority !== undefined) await validateDemoAnnotations(opts.demoAuthority);
      if (preview.record === null || preview.record.transaction.hash !== t.hash) throw new AnnotationTransactionError();
      if (preview.status.currentContentHash !== t.afterContentHash) {
        if (preview.status.currentContentHash !== t.beforeContentHash || preview.draft === null || journeyContentHash(preview.candidate) !== t.afterContentHash) throw new AnnotationTransactionError();
        try { await new FsJourneyStore(dir).putGuarded(preview.candidate, t.beforeContentHash); }
        catch { throw new AnnotationTransactionError(); }
      }
      const after = await previewJourneyAnnotations(dir, id);
      if (after.status.state !== "approved-pending-apply" || after.status.currentContentHash !== t.afterContentHash || after.receipt?.identity !== preview.receipt?.identity) throw new AnnotationTransactionError();
      await writeAnnotationApproval(dir, receiptPath, { ...preview.record, phase: "applied" }, preview.receipt);
      preview = await previewJourneyAnnotations(dir, id);
    }
    if (preview.status.state !== "applied-current" || preview.status.transaction?.hash !== t.hash) throw new AnnotationTransactionError();
    if (preview.draft !== null) await removeAnnotationDraft(dir, draftPath, preview.draft);
    const final = await annotationStatus(dir, id);
    if (final.state !== "applied-current" || final.transaction?.hash !== t.hash) throw new AnnotationTransactionError();
    return { ...final, kind: "journey-annotation-apply", state: "applied-current", draftPath, changes, coverage: intentCoverage(preview.journey) };
  }).catch((error: unknown) => {
    if (error instanceof UnknownJourneyError || error instanceof AnnotationDraftNotFoundError || error instanceof StaleAnnotationDraftError || error instanceof AnnotationTransactionError || approvalRefusal(error) !== null) throw error;
    throw new AnnotationTransactionError();
  });
}

/** `journey run`'s informational intent line (#246): how many steps say why. Never fails a run. */
export async function journeyIntentCoverage(dir: string, id: string): Promise<IntentCoverage | undefined> {
  try {
    const journey = await new FsJourneyStore(dir).get(id);
    return journey === null ? undefined : intentCoverage(journey);
  } catch {
    return undefined;
  }
}
