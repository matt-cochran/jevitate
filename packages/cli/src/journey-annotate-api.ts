import type { MissionFixtures } from "./mission-fixtures.js";
import { explainCheck, expectedResultFromDelta } from "@jevitate/explore";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AnnotationDraftMismatchError,
  AnnotationDraftSchema,
  FsJourneyStore,
  applyAnnotationDraft,
  describeStep,
  flatJourneySteps,
  intentCoverage,
  journeyAssertions,
  type AnnotationChange,
  type AnnotationDraft,
  type IntentCoverage,
  type Journey,
} from "@jevitate/journey";
import { redactUrl, type GenerationPort, type GenerationProvenance } from "@jevitate/ai-core";
import { contentHash, clock } from "@jevitate/domain";
import type { StepObserver } from "@jevitate/interpreter";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import { runJourneyProgrammatically, UnknownJourneyError, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { NOT_A_CREDENTIAL_WAY_OUT, fixtureSecretNeeds, secretBoundNeeds } from "./secret-params.js";

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
async function capture(actor: Actor): Promise<PageEvidence> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const raw = await page.evaluate(readPage).catch(() => ({ heading: "", text: "" }));
  return {
    url: redactUrl(page.url()),
    heading: raw.heading.replace(/\s+/g, " ").trim().slice(0, 300),
    text: raw.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, EVIDENCE_TEXT_CHARS),
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

/** Annotating sends the replay's pages to a model, and nothing secret-bound goes to a model. */
export class SecretBoundJourneyError extends Error {
  readonly code = "E_MODEL_REFUSED_SECRET";
  constructor(id: string, what: readonly string[]) {
    super(`journey '${id}' needs ${what.join(", ")}, and nothing secret-bound goes to a model, so it can't be annotated; nothing was sent. Write its objective and expected result by hand, or annotate a Journey that needs no secret (sign in with a stored session). ${NOT_A_CREDENTIAL_WAY_OUT}`);
    this.name = "SecretBoundJourneyError";
  }
}

function assertNoSecretForModel(journey: Journey, params: Readonly<Record<string, string>>): void {
  const needs = secretBoundNeeds(journey, params);
  if (needs.length > 0) throw new SecretBoundJourneyError(journey.metadata.id, needs);
}

function assertNoFixtureSecret(id: string, fx: MissionFixtures | undefined): void {
  const needs = fixtureSecretNeeds(fx);
  if (needs.length > 0) throw new SecretBoundJourneyError(id, needs);
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
  assertNoSecretForModel(journey, opts.params);
  const flat = flatJourneySteps(journey);

  const before = new Map<number, PageEvidence>();
  const after = new Map<number, PageEvidence | null>();
  const observer: StepObserver = {
    beforeStep: async ({ actor, index }) => {
      before.set(index, await capture(actor));
    },
    afterStep: async ({ actor, index, outcome }) => {
      after.set(index, outcome === "done" ? await capture(actor) : null);
    },
  };
  const { gen, now, ...runOpts } = opts;
  // A fixture is known once it is built: its secret outputs refuse before setup, a hook's after it.
  let fixture: MissionFixtures | undefined;
  const fixtures = opts.fixtures === undefined ? {} : {
    fixtures: (...a: Parameters<NonNullable<typeof opts.fixtures>>) => {
      fixture = opts.fixtures?.(...a);
      assertNoFixtureSecret(opts.id, fixture);
      return fixture;
    },
  };
  const run = await runJourneyProgrammatically({ ...runOpts, ...fixtures, observer });
  if (fixture !== undefined && fixture.secrets().length > 0) throw new SecretBoundJourneyError(opts.id, ["a fixture secret"]);
  const reachedSteps = before.size;
  const replay: AnnotationDraft["replay"] = run.outcome === "quarantined"
    ? { outcome: "stopped", reachedSteps, totalSteps: flat.length, reason: run.reason.slice(0, 2000) }
    : { outcome: "completed", reachedSteps, totalSteps: flat.length };

  const m = journey.metadata;
  const context = m.goal ?? [m.name, m.description, journey.recording.intent].filter((s) => s !== undefined && s !== "").join(" — ");
  const clean = (s: string | null | undefined): string | undefined => {
    const t = s === null || s === undefined ? "" : s.trim();
    return t === "" ? undefined : t;
  };

  let provenance: GenerationProvenance | undefined;
  const steps: AnnotationDraft["steps"] = [];
  const stepLines: string[] = [];
  for (const s of flat) {
    const described = describeStep(s.recorded.step);
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
    stepLines.push(`${s.index + 1}. ${described}${objective === undefined ? "" : ` — ${objective}`}`.slice(0, 1200));
  }

  let goal: string | undefined;
  let successCriteria: string[] | undefined;
  const unverifiableCriteria: string[] = [];
  // #755: the assertions the Journey already makes (step postconditions and end state) — shown to the
  // model and the only other evidence a drafted success criterion may claim besides the final page.
  const assertionTexts = journeyAssertions(journey).map((site) => explainCheck(site.check).text);
  const needGoal = (m.goal ?? "").trim() === "";
  const needCriteria = (m.successCriteria ?? []).length === 0;
  if (needGoal || needCriteria) {
    const lastReached = [...before.keys()].sort((x, y) => y - x)[0];
    const finalPage = lastReached === undefined ? null : (after.get(lastReached) ?? before.get(lastReached) ?? null);
    const input = {
      name: m.name.slice(0, 500),
      ...(m.description === undefined ? {} : { description: m.description.slice(0, 2000) }),
      ...(journey.recording.intent === undefined ? {} : { intent: journey.recording.intent.slice(0, 2000) }),
      steps: stepLines.slice(0, 200),
      assertions: assertionTexts.map((a) => a.slice(0, 500)).slice(0, 200),
      finalPage,
    };
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

/**
 * The human approval gate (like `journey promote`): applies the reviewed draft to the Journey and
 * removes the draft. Refuses — writing nothing — when the Journey changed since the draft was made
 * (its content hash differs) or the draft names steps the Journey does not have.
 */
export async function approveJourneyAnnotations(dir: string, id: string): Promise<ApproveAnnotationsResult> {
  const journey = await loadJourney(dir, id);
  const { draft, draftPath } = await readAnnotationDraft(dir, id);
  if (journeyContentHash(journey) !== draft.journeyHash) {
    throw new StaleAnnotationDraftError(
      `journey '${id}' changed after this draft was made (${draftPath}) — re-run \`jevitate journey annotate ${id}\` to draft against the current Journey`,
    );
  }
  let applied: { journey: Journey; changes: AnnotationChange[] };
  try {
    applied = applyAnnotationDraft(journey, draft);
  } catch (err) {
    if (err instanceof AnnotationDraftMismatchError) throw new InvalidAnnotationDraftError(err.message);
    throw err;
  }
  if (applied.changes.length > 0) await new FsJourneyStore(dir).put(applied.journey);
  await rm(draftPath, { force: true });
  return { id, draftPath, changes: applied.changes, coverage: intentCoverage(applied.journey) };
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
