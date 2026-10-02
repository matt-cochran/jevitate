import { expectedResultFromDelta } from "@jevitate/explore";
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
  secretParamValues,
  type AnnotationChange,
  type AnnotationDraft,
  type IntentCoverage,
  type Journey,
} from "@jevitate/journey";
import { assertNoSecretInPayload, redactText, redactUrl, type GenerationPort, type GenerationProvenance } from "@jevitate/ai-core";
import { contentHash, clock } from "@jevitate/domain";
import type { StepObserver } from "@jevitate/interpreter";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
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
      finalPage,
    };
    assertNoSecretInPayload(input, secrets);
    const { output, provenance: p } = await gen.generate("journey.goal", input);
    provenance = p;
    if (needGoal) goal = clean(output.goal);
    if (needCriteria) {
      const criteria = output.successCriteria.map((c) => clean(c)).filter((c): c is string => c !== undefined);
      if (criteria.length > 0) successCriteria = criteria;
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
