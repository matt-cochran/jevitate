/**
 * #434: mechanical requirements-quality rules for job stories and persona definitions, paraphrasing
 * the individual-characteristic writing rules of the INCOSE Guide to Writing Requirements (GtWR).
 * Rule ids are stable and case-insensitive; check the phrasing and ids against the current GtWR
 * edition when the guide changes. Pure and deterministic: no I/O, clock, or model calls.
 */

export type GtwrCharacteristic =
  | "necessary"
  | "appropriate"
  | "unambiguous"
  | "complete"
  | "singular"
  | "feasible"
  | "verifiable"
  | "correct"
  | "conforming";

/** #434: one requirements-quality problem found in a job story or persona field. */
export interface QualityFinding {
  ruleId: string;
  characteristic: GtwrCharacteristic;
  severity: "warn" | "fail";
  field: string;
  message: string;
  match?: string;
}

/** #434: documentation/listing entry for a rule the checker can emit. */
export interface GtwrRule {
  readonly id: string;
  readonly characteristic: GtwrCharacteristic;
  readonly description: string;
}

/** #434: the catalog of GtWR-derived rules. `GTWR_RULES` must list every id the checker emits. */
export const GTWR_RULES: readonly GtwrRule[] = [
  { id: "gtwr:vague-term", characteristic: "unambiguous", description: "Vague or unverifiable terms (user-friendly, fast, easy, as needed, several, …)." },
  { id: "gtwr:escape-clause", characteristic: "verifiable", description: "Escape clauses that defer a decision (if possible, where practical, when necessary)." },
  { id: "gtwr:combinator", characteristic: "singular", description: "Combinators that join two requirements (and/or, as well as, both … and)." },
  { id: "gtwr:open-ended", characteristic: "complete", description: "Open-ended lists or trailing markers (etc, including but not limited to, …)." },
  { id: "gtwr:absolute", characteristic: "verifiable", description: "Unqualified absolutes that cannot be verified (always, never, all, every, 100%)." },
  { id: "gtwr:negative", characteristic: "unambiguous", description: "An outcome phrased as a negation (not, no, never) rather than a positive result." },
  { id: "gtwr:pronoun-reference", characteristic: "unambiguous", description: "An outcome or motivation opening with a bare pronoun (it, this, that, they)." },
  { id: "gtwr:empty-field", characteristic: "conforming", description: "A required field is missing or blank." },
  { id: "gtwr:too-long", characteristic: "unambiguous", description: "A single field over 300 characters, too dense to read unambiguously." },
  { id: "gtwr:multiple-outcomes", characteristic: "singular", description: "Several outcomes in one story (a semicolon, or more than one 'so I can' / 'so that')." },
  { id: "gtwr:trigger-is-persona", characteristic: "conforming", description: "The trigger names a persona ('As a …') instead of the situation the job arises in." },
  { id: "gtwr:outcome-is-feature", characteristic: "necessary", description: "The outcome names a control to operate rather than the result the user wants." },
];

const VAGUE_TERMS: readonly RegExp[] = [
  /\buser-friendly\b/i,
  /\beasy\b/i,
  /\beasily\b/i,
  /\bfast\b/i,
  /\bquickly\b/i,
  /\bsimple\b/i,
  /\bintuitive\b/i,
  /\befficient\b/i,
  /\bseamless\b/i,
  /\bflexible\b/i,
  /\brobust\b/i,
  /\bappropriate\b/i,
  /\badequate\b/i,
  /\bsufficient\b/i,
  /\bas needed\b/i,
  /\bas required\b/i,
  /\band so on\b/i,
  /\bvarious\b/i,
  /\bsome\b/i,
  /\bseveral\b/i,
  /\bmany\b/i,
  /\bfew\b/i,
];

const ESCAPE_CLAUSES: readonly RegExp[] = [
  /\bif possible\b/i,
  /\bwhere possible\b/i,
  /\bwhere practical\b/i,
  /\bas far as possible\b/i,
  /\bif necessary\b/i,
  /\bwhen necessary\b/i,
  /\bto the extent possible\b/i,
];

const COMBINATORS: readonly RegExp[] = [/\band\/or\b/i, /\bas well as\b/i, /\bboth\b[\s\S]{0,80}?\band\b/i];

const OPEN_ENDED: readonly RegExp[] = [/\betc\.?\s*$/i, /\bincluding but not limited to\b/i, /\.\.\./];

const ABSOLUTES: readonly RegExp[] = [/\balways\b/i, /\bnever\b/i, /\ball\b/i, /\bevery\b/i, /100\s?%/, /\bcompletely\b/i, /\btotally\b/i];

const NEGATIVES: readonly RegExp[] = [/\bnot\b/i, /\bno\b/i, /\bnever\b/i];

const PRONOUN_START = /^\s*(it|this|that|they)\b/i;
const TRIGGER_IS_PERSONA = /^\s*as an?\b/i;
const OUTCOME_IS_FEATURE = /^\s*(use|click|see the|have a button)\b/i;
const SO_ICAN = /so i can/gi;
const SO_THAT = /so that/gi;

/** #434: the first substring matched by any pattern, or undefined. */
function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m !== null) return m[0];
  }
  return undefined;
}

function occurrenceCount(text: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return (text.match(re) ?? []).length;
}

/** #434: the mechanical checks that apply to a single statement field. */
export function checkStatement(text: string, field: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const push = (id: string, characteristic: GtwrCharacteristic, severity: "warn" | "fail", message: string, match?: string): void => {
    findings.push(match === undefined ? { ruleId: id, characteristic, severity, field, message } : { ruleId: id, characteristic, severity, field, message, match });
  };

  const vague = firstMatch(text, VAGUE_TERMS);
  if (vague !== undefined) push("gtwr:vague-term", "unambiguous", "warn", `Vague or unverifiable term (“${vague}”).`, vague);

  const escape = firstMatch(text, ESCAPE_CLAUSES);
  if (escape !== undefined) push("gtwr:escape-clause", "verifiable", "warn", `Escape clause defers the requirement (“${escape}”).`, escape);

  const combinator = firstMatch(text, COMBINATORS);
  if (combinator !== undefined) push("gtwr:combinator", "singular", "warn", `Combinator joins two requirements (“${combinator}”).`, combinator);

  const openEnded = firstMatch(text, OPEN_ENDED);
  if (openEnded !== undefined) push("gtwr:open-ended", "complete", "warn", `Open-ended list or marker (“${openEnded}”).`, openEnded);

  const absolute = firstMatch(text, ABSOLUTES);
  if (absolute !== undefined) push("gtwr:absolute", "verifiable", "warn", `Unverifiable absolute (“${absolute}”).`, absolute);

  if (field === "outcome") {
    const negative = firstMatch(text, NEGATIVES);
    if (negative !== undefined) push("gtwr:negative", "unambiguous", "warn", `Outcome is phrased as a negation (“${negative}”).`, negative);
  }

  if (field === "outcome" || field === "motivation") {
    const pronoun = PRONOUN_START.exec(text);
    if (pronoun !== null) push("gtwr:pronoun-reference", "unambiguous", "warn", `Opens with a bare pronoun (“${pronoun[1]}”).`, pronoun[1]);
  }

  if (text.length > 300) push("gtwr:too-long", "unambiguous", "warn", "Field exceeds 300 characters.");

  if (field === "outcome" && (text.includes(";") || occurrenceCount(text, SO_ICAN) + occurrenceCount(text, SO_THAT) > 1))
    push("gtwr:multiple-outcomes", "singular", "warn", "Several outcomes in one story.");

  return findings;
}

function isNonBlank(text: string | undefined): text is string {
  return text !== undefined && text.trim() !== "";
}

/** #434: findings sorted by field, then ruleId, then match — the deterministic report order. */
function sorted(findings: QualityFinding[]): QualityFinding[] {
  return findings.sort((a, b) => {
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    const am = a.match ?? "";
    const bm = b.match ?? "";
    if (am !== bm) return am < bm ? -1 : 1;
    return 0;
  });
}

/** #434: check a job story's trigger, motivation and outcome. */
export function checkJobStory(job: { trigger?: string; motivation?: string; outcome?: string }): QualityFinding[] {
  const findings: QualityFinding[] = [];
  for (const field of ["trigger", "motivation", "outcome"] as const) {
    const text = job[field];
    if (!isNonBlank(text)) {
      findings.push({ ruleId: "gtwr:empty-field", characteristic: "conforming", severity: "fail", field, message: `Job story ${field} is required.` });
      continue;
    }
    findings.push(...checkStatement(text, field));
  }

  if (isNonBlank(job.trigger)) {
    const match = TRIGGER_IS_PERSONA.exec(job.trigger);
    if (match !== null)
      findings.push({ ruleId: "gtwr:trigger-is-persona", characteristic: "conforming", severity: "warn", field: "trigger", message: `Trigger names a persona (“${match[0].trim()}”), not a situation.`, match: match[0].trim() });
  }

  if (isNonBlank(job.outcome)) {
    const match = OUTCOME_IS_FEATURE.exec(job.outcome);
    if (match !== null)
      findings.push({ ruleId: "gtwr:outcome-is-feature", characteristic: "necessary", severity: "warn", field: "outcome", message: `Outcome names a control (“${match[0].trim()}”), not a result.`, match: match[0].trim() });
  }

  return sorted(findings);
}

/** #434: check a persona's description and role. Only the description is required. */
export function checkPersona(p: { description?: string; role?: string }): QualityFinding[] {
  const findings: QualityFinding[] = [];
  if (!isNonBlank(p.description)) {
    findings.push({ ruleId: "gtwr:empty-field", characteristic: "conforming", severity: "fail", field: "description", message: "Persona description is required." });
  } else {
    findings.push(...checkStatement(p.description, "description"));
  }
  if (isNonBlank(p.role)) findings.push(...checkStatement(p.role, "role"));
  return sorted(findings);
}

/** #434: strip one leading template prefix case-insensitively, then whitespace. */
function stripPrefix(text: string, prefix: string): string {
  const trimmed = text.trimStart();
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trimStart() : trimmed;
}

/** #434: render a job story as `When …, I want to …, so I can ….`. */
export function renderJobStory(job: { trigger: string; motivation: string; outcome: string }): string {
  const trigger = stripPrefix(job.trigger, "when ").trim();
  const motivation = stripPrefix(job.motivation, "i want to ").trim();
  const outcome = stripPrefix(job.outcome, "so i can ").trim().replace(/\.\s*$/, "").trimEnd();
  return `When ${trigger}, I want to ${motivation}, so I can ${outcome}.`;
}
