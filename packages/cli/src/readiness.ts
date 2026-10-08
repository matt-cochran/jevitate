import { GTWR_RULES, checkJobStory, checkPersona, type Finding, type JourneyReview, type QualityFinding } from "@jevitate/journey";
import type { Answer, JudgmentState, Question } from "@jevitate/ai-core";
import { catalogJourney, findJob, findPersona, journeyLinks, type Catalog, type CatalogJob, type CatalogJourney, type CatalogPersona } from "./catalog.js";
import { buildJourneyReview } from "./journey-review.js";
import { readVerifyRecord } from "./journey-review-store.js";
import { JEV_SKIPPED_PASS_REAL } from "./jev-advisor.js";
import type { ApprovalSubject, PreApprovalAnalyzer, PreApprovalContext } from "./pre-approval.js";

/**
 * #434 — the Readiness section of every review sheet (`journey|job|persona review --readiness`, and
 * every approval: `persona approve`, `job approve`, `journey promote`, `demo approve`), as two
 * pre-approval analyzers kept visibly apart:
 *
 *  1. `readiness` — deterministic checks, each pass / warn / fail with a fix-it line: the links
 *     exist and are approved, the intent is complete, the lint passes, the mutation proof is known
 *     and current; a job's story parts; and the INCOSE GtWR writing rules (gtwr-rules.ts) on job
 *     stories and personas, each citing its rule id and characteristic. Blocking stays with the
 *     gates that already exist (lint errors → `--accept-weak`, unapproved links →
 *     `--accept-unvetted`, broken links → the catalog-links acknowledgment), so readiness never
 *     double-gates: none of its findings requires an acknowledgment.
 *  2. `readiness-jev` — advisory Jev questions (typed Noul answers, each with its probability)
 *     through the judgment gateway. A low probability becomes "not ready because … (GtWR:
 *     <characteristic>)". Jev never decides: none of these findings requires an acknowledgment, and
 *     none changes an exit code. Without an advisor (no `--real`, no key) it reports why it skipped.
 */

export const READINESS = "readiness";
export const READINESS_JEV = "readiness-jev";

/** A Jev probability below this is "not ready because …". */
export const READINESS_LOW_PROBABILITY = 0.5;

type Severity = Finding["severity"];

function finding(analyzer: string, code: string, severity: Severity, message: string, extra: { fix?: string; items?: string[]; characteristic?: string; probability?: number } = {}): Finding {
  return {
    analyzer,
    code,
    severity,
    message,
    ...(extra.fix === undefined ? {} : { fix: extra.fix }),
    requiresAcknowledgment: false,
    ...(extra.items === undefined || extra.items.length === 0 ? {} : { items: extra.items }),
    ...(extra.characteristic === undefined ? {} : { characteristic: extra.characteristic }),
    ...(extra.probability === undefined ? {} : { probability: extra.probability }),
  };
}

const check = (code: string, severity: Severity, message: string, extra: { fix?: string; items?: string[]; characteristic?: string } = {}): Finding =>
  finding(READINESS, code, severity, severity === "info" ? `pass — ${message}` : message, extra);

// ── Deterministic: GtWR writing rules ────────────────────────────────────────────────────────

const RULE_TEXT = new Map(GTWR_RULES.map((r) => [r.id, r.description]));

/** #434: one GtWR rule finding as a readiness finding (`gtwr:<rule>@<field>`), citing the rule and characteristic. */
export function gtwrFinding(q: QualityFinding): Finding {
  return finding(READINESS, `${q.ruleId}@${q.field}`, q.severity, `${q.field}: ${q.message} (rule ${q.ruleId}, GtWR: ${q.characteristic})`, {
    fix: `reword the ${q.field} — ${RULE_TEXT.get(q.ruleId) ?? q.ruleId}`,
    characteristic: q.characteristic,
  });
}

// ── Deterministic: per subject ───────────────────────────────────────────────────────────────

function jobChecks(job: CatalogJob, catalog: Catalog): Finding[] {
  const out: Finding[] = [];
  const missing = (["trigger", "motivation", "outcome"] as const).filter((p) => job.job[p].trim() === "");
  out.push(
    missing.length === 0
      ? check("readiness.story", "info", "the job story has its trigger, motivation and outcome")
      : check("readiness.story", "fail", `the job story is missing its ${missing.join(", ")}`, { fix: `write it as "When [trigger], I want to [motivation], so I can [outcome]."`, characteristic: "conforming" }),
  );
  if (job.personas.length === 0) {
    out.push(check("readiness.personas", "warn", "it serves no persona", { fix: `add the persona ids it serves to its "personas"` }));
  } else {
    const unknown = job.personas.filter((id) => findPersona(catalog, id) === undefined);
    const unvetted = job.personas.filter((id) => {
      const p = findPersona(catalog, id);
      return p !== undefined && p.status !== "approved";
    });
    if (unknown.length > 0) out.push(check("readiness.personas", "fail", `it serves persona(s) the catalog does not declare: ${unknown.join(", ")}`, { fix: "declare them in .jevitate/personas.json", items: unknown.map((id) => `persona:${id}`) }));
    else if (unvetted.length > 0) out.push(check("readiness.personas", "warn", `its persona(s) are not approved: ${unvetted.join(", ")}`, { fix: unvetted.map((id) => `jevitate persona approve ${id}`).join("; "), items: unvetted.map((id) => `persona:${id}`) }));
    else out.push(check("readiness.personas", "info", `every persona it serves is approved (${job.personas.join(", ")})`));
  }
  out.push(...checkJobStory(job.job).map(gtwrFinding));
  return out;
}

function personaChecks(p: CatalogPersona, catalog: Catalog): Finding[] {
  const out: Finding[] = [];
  out.push(
    (p.description ?? "").trim() === ""
      ? check("readiness.description", "fail", "it has no description of who this user is", { fix: `add a "description" to the persona in .jevitate/personas.json`, characteristic: "conforming" })
      : check("readiness.description", "info", "it describes who this user is"),
  );
  const jobs = catalog.jobs.filter((j) => j.personas.includes(p.id));
  out.push(
    jobs.length === 0
      ? check("readiness.jobs", "warn", "no job in the catalog serves it", { fix: `list it in a job's "personas" (.jevitate/jobs.json)` })
      : check("readiness.jobs", "info", `${jobs.length} job(s) serve it (${jobs.map((j) => j.id).join(", ")})`),
  );
  out.push(...checkPersona({ ...(p.description === undefined ? {} : { description: p.description }), ...(p.role === undefined ? {} : { role: p.role }) }).map(gtwrFinding));
  return out;
}

async function journeyChecks(j: CatalogJourney, catalog: Catalog): Promise<Finding[]> {
  const out: Finding[] = [];
  const links = journeyLinks(catalog, j);
  const id = j.id;
  // 1. it links an existing job and persona
  if (links.job === undefined || links.persona === undefined) {
    out.push(
      check("readiness.links", "warn", `it links ${links.job === undefined && links.persona === undefined ? "no job and no persona" : links.job === undefined ? "no job" : "no persona"}`, {
        fix: "set metadata.job and metadata.persona to catalog ids (.jevitate/jobs.json, .jevitate/personas.json)",
      }),
    );
  } else if (links.job.status === "unknown" || links.persona.status === "unknown") {
    const dangling = [...(links.job.status === "unknown" ? [`job:${links.job.id}`] : []), ...(links.persona.status === "unknown" ? [`persona:${links.persona.id}`] : [])];
    out.push(check("readiness.links", "fail", `it links item(s) the catalog does not declare: ${dangling.join(", ")}`, { fix: "fix metadata.job / metadata.persona, or declare them", items: dangling }));
  } else {
    out.push(check("readiness.links", "info", `it links job '${links.job.id}' and persona '${links.persona.id}'`));
    // 2. both are approved
    out.push(
      links.unvetted.length === 0
        ? check("readiness.links-approved", "info", "its job and persona are approved")
        : check("readiness.links-approved", "warn", `not approved: ${links.unvetted.join(", ")}`, {
            fix: "jevitate job|persona review/approve <id> (promote otherwise needs --accept-unvetted)",
            items: links.unvetted.map((u) => u.replace(/ \(.*\)$/, "")),
          }),
    );
  }
  const lastVerify = catalog.journeysDir === undefined ? null : await readVerifyRecord(catalog.journeysDir, id);
  const review = buildJourneyReview(j.journey, { lastVerify });
  // 3. the intent is complete: goal, success criteria, each step's objective and expected result
  const noExpected = review.steps.filter((s) => s.expectedResult === undefined).map((s) => s.number);
  const gaps = [...review.summary.missingIntent, ...(noExpected.length === 0 ? [] : [`${noExpected.length} of ${review.steps.length} step(s) have no expected result (step ${noExpected.join(", ")})`])];
  out.push(
    gaps.length === 0
      ? check("readiness.intent", "info", "its goal, success criteria and every step's objective and expected result are written")
      : check("readiness.intent", "warn", `the intent is incomplete: ${gaps.map((g) => g.replace(/ — draft it with .*$/, "")).join("; ")}`, { fix: `draft it with \`jevitate journey annotate ${id}\``, characteristic: "complete" }),
  );
  // 4a. the lint passes
  out.push(
    review.proof.lint.errors === 0
      ? check("readiness.lint", "info", `\`journey lint\` passes${review.proof.lint.warnings === 0 ? "" : ` (${review.proof.lint.warnings} warning(s))`}`)
      : check("readiness.lint", "fail", `\`journey lint\` has ${review.proof.lint.errors} error(s): its assertions cannot prove its outcome`, {
          fix: `strengthen it (jevitate journey lint ${id}); promote refuses without --accept-weak`,
          characteristic: "verifiable",
        }),
  );
  // 4b. the mutation proof is known and current
  out.push(verifyCheck(review, id));
  return out;
}

function verifyCheck(review: JourneyReview, id: string): Finding {
  const v = review.proof.verify;
  const fix = `jevitate journey verify ${id} --mutate`;
  if (v.status === "not-verified") return check("readiness.verify", "warn", "its mutation proof is unknown: `journey verify --mutate` never ran", { fix, characteristic: "verifiable" });
  if (v.stale) return check("readiness.verify", "warn", `its mutation proof (${v.verdict}, ${v.at}) is for an older version: the Journey changed since`, { fix, characteristic: "verifiable" });
  if (v.verdict !== "proven") return check("readiness.verify", "warn", `its mutation proof is ${v.verdict} (${v.at})${v.reason === undefined ? "" : `: ${v.reason}`}`, { fix, characteristic: "verifiable" });
  return check("readiness.verify", "info", `its mutation proof is current and proven (${v.at})`);
}

function subjectJourney(subject: ApprovalSubject, catalog: Catalog, ctx: PreApprovalContext): CatalogJourney | undefined {
  return ctx.journey === undefined ? catalog.journeys.find((x) => x.id === subject.id) : catalogJourney(ctx.journey);
}

/** #434: the deterministic readiness checks and GtWR rule findings. */
export const readinessAnalyzer: PreApprovalAnalyzer = {
  id: READINESS,
  appliesTo: ["persona", "job", "journey"],
  async analyze(subject, catalog, ctx) {
    if (ctx.readiness !== true) return [];
    if (subject.kind === "job") {
      const job = findJob(catalog, subject.id);
      return job === undefined ? [] : jobChecks(job, catalog);
    }
    if (subject.kind === "persona") {
      const p = findPersona(catalog, subject.id);
      return p === undefined ? [] : personaChecks(p, catalog);
    }
    const j = subjectJourney(subject, catalog, ctx);
    return j === undefined ? [] : journeyChecks(j, catalog);
  },
};

// ── Jev: advisory questions ──────────────────────────────────────────────────────────────────

interface ReadinessQuestion {
  /** The question name sent to Jev (and the finding code, `jev.<name>`). */
  readonly name: string;
  /** Asked so that YES means ready: a low probability is "not ready". */
  readonly instructions: string;
  readonly characteristic: string;
  /** "not ready because …" — what a low answer means. */
  readonly notReady: string;
  readonly ready: string;
}

const JOB_QUESTIONS: readonly ReadinessQuestion[] = [
  { name: "outcome_oriented", instructions: "Is this job story about the outcome the user wants, rather than a description of a product feature?", characteristic: "necessary", notReady: "the story reads as a feature description, not an outcome", ready: "the story is outcome-oriented" },
  { name: "trigger_is_situation", instructions: "Is the trigger (the 'When …' part) a situation the user is in, rather than a description of who the user is?", characteristic: "conforming", notReady: "the trigger describes a persona, not a situation", ready: "the trigger is a situation" },
  { name: "unambiguous", instructions: "Would two careful readers agree on exactly what this job means?", characteristic: "unambiguous", notReady: "two readers could disagree on what this job means", ready: "it reads unambiguously" },
  { name: "verifiable", instructions: "Could an automated success check prove that the outcome ('so I can …') was reached?", characteristic: "verifiable", notReady: "no success check could prove this outcome", ready: "a success check could prove the outcome" },
  { name: "singular", instructions: "Is this one job, rather than several jobs combined?", characteristic: "singular", notReady: "it combines several jobs", ready: "it is one job" },
  { name: "necessary", instructions: "Is this a real user need, rather than an implementation detail?", characteristic: "necessary", notReady: "it reads as an implementation detail, not a user need", ready: "it is a real user need" },
];

const PERSONA_QUESTIONS: readonly ReadinessQuestion[] = [
  { name: "unambiguous", instructions: "Would two careful readers picture the same kind of user from this persona description?", characteristic: "unambiguous", notReady: "two readers could picture different users", ready: "it describes one recognisable kind of user" },
  { name: "singular", instructions: "Does this describe one kind of user, rather than several different kinds of user combined?", characteristic: "singular", notReady: "it combines several kinds of user", ready: "it is one kind of user" },
  { name: "necessary", instructions: "Does this persona describe a real kind of user of the product, rather than a system, a feature or a test account?", characteristic: "necessary", notReady: "it reads as a system, a feature or a test account, not a user", ready: "it is a real kind of user" },
];

const JOURNEY_OUTCOME: ReadinessQuestion = { name: "accomplishes_outcome", instructions: "Do these steps accomplish the job's outcome (the 'so I can …') for this persona?", characteristic: "correct", notReady: "its steps may not accomplish the job's outcome for this persona", ready: "its steps accomplish the job's outcome" };
const JOURNEY_END_STATE: ReadinessQuestion = { name: "end_state_proves_outcome", instructions: "Do the end-state checks prove that the outcome was reached, rather than only that a page loaded?", characteristic: "verifiable", notReady: "its end-state checks may only prove that a page loaded, not the outcome", ready: "its end-state checks prove the outcome" };
const JOURNEY_RELATED: ReadinessQuestion = { name: "steps_related", instructions: "Is every step needed for the job (no step unrelated to it)?", characteristic: "necessary", notReady: "some steps look unrelated to the job", ready: "every step serves the job" };
const JOURNEY_PLAUSIBLE: ReadinessQuestion = { name: "plausible_for_persona", instructions: "Are these actions plausible for this persona's role (for example, not a buyer doing an administrator's action)?", characteristic: "appropriate", notReady: "its actions look implausible for this persona's role", ready: "its actions fit the persona's role" };
const JOURNEY_DELTAS: ReadinessQuestion = { name: "expected_matches_deltas", instructions: "Does each step's written expected result match what the step was recorded doing (its requests and checks)?", characteristic: "correct", notReady: "some steps' written expected results do not match what they were recorded doing", ready: "the written expected results match the recorded steps" };

function journeyQuestions(hasJob: boolean, hasPersona: boolean): ReadinessQuestion[] {
  return [...(hasJob ? [JOURNEY_OUTCOME] : []), JOURNEY_END_STATE, JOURNEY_RELATED, ...(hasPersona ? [JOURNEY_PLAUSIBLE] : []), JOURNEY_DELTAS];
}

function stateOf(goal: string, url: string, lines: readonly string[], history: readonly string[] = []): JudgmentState {
  return { goal, url, controls: [], history: [...history], visibleText: lines.join("\n") };
}

function personaText(p: CatalogPersona | undefined, id: string): string {
  if (p === undefined) return `Persona '${id}'`;
  return `Persona '${p.id}'${p.role === undefined ? "" : ` (account role: ${p.role})`}: ${p.description ?? "(no description)"}`;
}

function journeyState(j: CatalogJourney, catalog: Catalog): { state: JudgmentState; hasJob: boolean; hasPersona: boolean } {
  const links = journeyLinks(catalog, j);
  const job = links.job === undefined ? undefined : findJob(catalog, links.job.id);
  const persona = links.persona === undefined ? undefined : findPersona(catalog, links.persona.id);
  const review = buildJourneyReview(j.journey);
  const recorded = (n: number): string[] => review.sideEffects.writeRequests.filter((w) => w.step === n).map((w) => `${w.method} ${w.endpoint}`);
  const steps = review.steps.map((s) =>
    [
      `${s.number}. ${s.action}`,
      ...(s.objective === undefined ? [] : [`objective: ${s.objective}`]),
      ...(s.expectedResult === undefined ? [] : [`expected: ${s.expectedResult}`]),
      ...(s.assertion === undefined ? [] : [`checked: ${s.assertion}`]),
      ...(recorded(s.number).length === 0 ? [] : [`recorded requests: ${recorded(s.number).join(", ")}`]),
    ].join(" — "),
  );
  const lines = [
    `Journey '${j.id}': ${j.name}`,
    ...(job === undefined ? [] : [`Job: ${job.story}`]),
    ...(links.persona === undefined ? [] : [personaText(persona, links.persona.id)]),
    ...(review.summary.goal === undefined ? [] : [`Goal: ${review.summary.goal}`]),
    ...review.summary.successCriteria.map((c) => `Success criterion: ${c.description}`),
    `End-state checks: ${review.proof.endState.length === 0 ? "none" : review.proof.endState.join("; ")}`,
  ];
  return { state: stateOf(job?.story ?? review.summary.goal ?? j.name, j.journey.recording.site, lines, steps), hasJob: job !== undefined, hasPersona: links.persona !== undefined };
}

function questionsOf(qs: readonly ReadinessQuestion[]): Record<string, Question> {
  return Object.fromEntries(qs.map((q) => [q.name, { kind: "noul", instructions: q.instructions } satisfies Question]));
}

function probabilityOf(a: Answer | undefined): number | undefined {
  if (a === undefined) return undefined;
  if (a.kind === "noul") return a.probability;
  if (a.kind === "score") return a.value;
  return a.confidence;
}

/** #434: one Jev answer as an advisory finding — never requiring an acknowledgment. */
function jevFinding(q: ReadinessQuestion, a: Answer | undefined, cached: boolean): Finding {
  const p = probabilityOf(a);
  const prob = p === undefined ? undefined : Math.min(1, Math.max(0, p));
  const asked = `asked: "${q.instructions}"${cached ? " (cached answer)" : ""}`;
  if (prob === undefined) return finding(READINESS_JEV, `jev.${q.name}`, "warn", `no answer to "${q.instructions}"`, { characteristic: q.characteristic });
  return prob < READINESS_LOW_PROBABILITY
    ? finding(READINESS_JEV, `jev.${q.name}`, "warn", `not ready because ${q.notReady} (GtWR: ${q.characteristic}) — ${asked}`, { characteristic: q.characteristic, probability: prob })
    : finding(READINESS_JEV, `jev.${q.name}`, "info", `${q.ready} — ${asked}`, { characteristic: q.characteristic, probability: prob });
}

/** #434: the advisory Jev readiness questions (Noul, with probabilities). */
export const jevReadinessAnalyzer: PreApprovalAnalyzer = {
  id: READINESS_JEV,
  appliesTo: ["persona", "job", "journey"],
  async analyze(subject, catalog, ctx) {
    if (ctx.readiness !== true) return [];
    let qs: readonly ReadinessQuestion[];
    let state: JudgmentState;
    if (subject.kind === "job") {
      const job = findJob(catalog, subject.id);
      if (job === undefined) return [];
      qs = JOB_QUESTIONS;
      state = stateOf("Review this job story", "about:catalog", [
        `Job story: ${job.story}`,
        `Trigger (When …): ${job.job.trigger}`,
        `Motivation (I want to …): ${job.job.motivation}`,
        `Outcome (so I can …): ${job.job.outcome}`,
        ...job.personas.map((id) => personaText(findPersona(catalog, id), id)),
      ]);
    } else if (subject.kind === "persona") {
      const p = findPersona(catalog, subject.id);
      if (p === undefined) return [];
      qs = PERSONA_QUESTIONS;
      state = stateOf("Review this persona", "about:catalog", [personaText(p, p.id)]);
    } else {
      const j = subjectJourney(subject, catalog, ctx);
      if (j === undefined) return [];
      const built = journeyState(j, catalog);
      qs = journeyQuestions(built.hasJob, built.hasPersona);
      state = built.state;
    }
    const setup = ctx.jev;
    if (setup === undefined || !("advisor" in setup)) {
      return [finding(READINESS_JEV, "jev.skipped", "info", `Jev review skipped: ${setup === undefined ? JEV_SKIPPED_PASS_REAL : setup.skipped}`)];
    }
    let result: { answers: Record<string, Answer>; cached: boolean };
    try {
      result = await setup.advisor.ask(state, questionsOf(qs));
    } catch (err) {
      // Advisory: a failed model call never gates an approval — the deterministic layer stands.
      return [finding(READINESS_JEV, "jev.failed", "warn", `Jev review could not run: ${err instanceof Error ? err.message : String(err)} — the deterministic checks above still apply`)];
    }
    return qs.map((q) => jevFinding(q, result.answers[q.name], result.cached));
  },
};
