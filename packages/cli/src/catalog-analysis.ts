import { contentHash } from "@jevitate/domain";
import {
  CatalogAnalysisSchema,
  GTWR_SET_CHARACTERISTICS,
  PAIR_RELATIONS,
  type CandidatePair,
  type CatalogAnalysis,
  type Finding,
  type GtwrSetCharacteristic,
  type PairRelation,
} from "@jevitate/journey";
import type { Answer, JudgmentState, Question } from "@jevitate/ai-core";
import { catalogJourney, findJob, findPersona, journeyLinks, personaLinkId, type Catalog, type CatalogJourney } from "./catalog.js";
import { buildCatalogStatus, renderAnalysisGroups } from "./catalog-review.js";
import { buildJourneyReview } from "./journey-review.js";
import { readVerifyRecord } from "./journey-review-store.js";
import { JEV_SKIPPED_PASS_REAL, jevLayerOf, type JevSetup } from "./jev-advisor.js";
import type { ApprovalSubject, PreApprovalAnalyzer } from "./pre-approval.js";

/**
 * #435 — catalog analysis: problems BETWEEN items (conflicts, duplicates, overlaps, gaps, drift),
 * grouped by the INCOSE Guide to Writing Requirements' set characteristics (complete, consistent,
 * feasible, comprehensible, able to be validated, correct).
 *
 *  - Candidate pairs are chosen by CODE, so cost is bounded (never O(n²) model calls): jobs that
 *    share a persona or trigger/outcome terms; Journeys whose expected writes (the #432 sheet's) hit
 *    the same resource, flagged when the methods oppose (create vs delete, enable vs disable) or
 *    when they do the same job as the same persona; personas with the same role or largely the same
 *    jobs. Each pair records why it was paired.
 *  - Jev classifies each judged pair as a typed Choice (compatible | duplicate | overlapping |
 *    conflicting | dependent) with a probability. The one-line reason is built by code from the two
 *    items' own text and the pairing evidence — never model prose.
 *  - The acknowledgment rule is code over the typed answer: on an APPROVAL, a `conflicting` or
 *    `duplicate` classification with probability ≥ `CONFLICT_ACK_THRESHOLD` on a pair involving the
 *    item being approved requires `--accept-findings "<reason>"`. Everything else is informational,
 *    and the on-demand `catalog analyze` never gates anything.
 *  - Per approval only the item's own pairs are judged, at most `APPROVAL_PAIR_CAP` of them; the
 *    rest are listed as overflow (never silently dropped). Answers are cached by content hash
 *    (jev-advisor.ts), so re-approving an unchanged item asks nothing new.
 *  - It only READS: it never writes a catalog file, a Journey or an approval.
 */

export const CATALOG_ANALYSIS = "catalog-analysis";

/** A `conflicting` / `duplicate` classification at or above this probability needs an acknowledgment to approve. */
export const CONFLICT_ACK_THRESHOLD = 0.7;
/** The most candidate pairs judged before one approval (the rest are reported as overflow). */
export const APPROVAL_PAIR_CAP = 8;
/** The default most candidate pairs judged by `catalog analyze` (`--max-pairs`). */
export const ANALYZE_PAIR_CAP = 50;

type ItemRef = string;

// ── Text helpers ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an the and or but of to in on at by for from with without into onto over under about as is are was were be been being it its this that these those i me my mine we us our " +
    "you your they them their he she his her when want wants can could would should will so then than there here what which who whom whose how why where not no yes do does done " +
    "did have has had get gets got make makes made need needs new some any all each every one more most other just also only very want able"
  ).split(" "),
);

/** The significant terms of a text: lowercase words of 3+ letters, stopwords dropped, a plural `s` folded. */
export function significantTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

function intersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] {
  return [...a].filter((x) => b.has(x));
}

function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const both = intersect(a, b).length;
  const either = new Set([...a, ...b]).size;
  return either === 0 ? 0 : both / either;
}

function quote(s: string, max = 120): string {
  const t = s.trim().replace(/\s+/g, " ");
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

// ── Write resources (Journeys) ───────────────────────────────────────────────────────────────

const OPPOSITE_ACTIONS: Readonly<Record<string, string>> = {
  enable: "disable", disable: "enable", publish: "unpublish", unpublish: "publish", archive: "unarchive", unarchive: "archive",
  lock: "unlock", unlock: "lock", follow: "unfollow", unfollow: "follow", subscribe: "unsubscribe", unsubscribe: "subscribe",
  block: "unblock", unblock: "block", activate: "deactivate", deactivate: "activate", share: "unshare", unshare: "share",
  approve: "reject", reject: "approve", open: "close", close: "open", start: "stop", stop: "start",
};
const OPPOSING_METHODS = new Set(["POST|DELETE", "DELETE|POST", "PUT|DELETE", "DELETE|PUT", "PATCH|DELETE", "DELETE|PATCH"]);
const ID_SEGMENT = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{36}|:[\w-]+|\{[^}]*\}|\*{1,2}|\[[^\]]*\])$/i;

interface WriteRef {
  readonly method: string;
  readonly endpoint: string;
  /** The resource path with ids and a trailing action dropped (`/api/posts`). */
  readonly resource: string;
  readonly action?: string;
}

/** #435: a write request's resource: the path without ids, wildcards and a trailing action verb. */
export function writeResource(method: string, endpoint: string): WriteRef {
  let path = endpoint.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    // not a URL: read it as a path
  }
  path = path.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter((s) => s !== "" && !ID_SEGMENT.test(s));
  const last = segments[segments.length - 1]?.toLowerCase();
  const action = last !== undefined && OPPOSITE_ACTIONS[last] !== undefined ? last : undefined;
  if (action !== undefined) segments.pop();
  return { method: method.toUpperCase(), endpoint, resource: `/${segments.join("/").toLowerCase()}`, ...(action === undefined ? {} : { action }) };
}

function journeyWrites(j: CatalogJourney): WriteRef[] {
  const seen = new Set<string>();
  const out: WriteRef[] = [];
  for (const w of buildJourneyReview(j.journey).sideEffects.writeRequests) {
    const ref = writeResource(w.method, w.endpoint);
    const key = `${ref.method} ${ref.resource} ${ref.action ?? ""}`;
    if (seen.has(key) || ref.resource === "/") continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ── Candidate pairing ────────────────────────────────────────────────────────────────────────

interface Item {
  readonly ref: ItemRef;
  readonly kind: "job" | "persona" | "journey";
  readonly id: string;
  /** Approved / promoted (an approved item is the stronger reason to compare against). */
  readonly vetted: boolean;
  /** The content hash (what the pair's cache key is bound to). */
  readonly hash: string;
  /** What the item says, for the Jev state and the reason line. */
  readonly text: string;
}

function itemsOf(catalog: Catalog): Item[] {
  return [
    ...catalog.jobs.map((j) => ({ ref: `job:${j.id}`, kind: "job" as const, id: j.id, vetted: j.status === "approved", hash: j.contentHash, text: j.story })),
    ...catalog.personas.map((p) => ({
      ref: `persona:${p.id}`,
      kind: "persona" as const,
      id: p.id,
      vetted: p.status === "approved",
      hash: p.contentHash,
      text: `${p.id}${p.role === undefined ? "" : ` (role: ${p.role})`}: ${p.description ?? "no description"}`,
    })),
    ...catalog.journeys.map((j) => ({ ref: `journey:${j.id}`, kind: "journey" as const, id: j.id, vetted: j.promoted, hash: j.contentHash, text: journeyText(j, catalog) })),
  ];
}

function journeyText(j: CatalogJourney, catalog: Catalog): string {
  const job = j.job === undefined ? undefined : findJob(catalog, j.job);
  const persona = personaLinkId(catalog, j);
  const writes = journeyWrites(j).map((w) => `${w.method} ${w.endpoint}`);
  return `${j.name}${job === undefined ? "" : ` — job: ${job.story}`}${persona === undefined ? "" : ` — as ${persona}`}${j.journey.metadata.goal === undefined ? "" : ` — goal: ${j.journey.metadata.goal}`}${writes.length === 0 ? "" : ` — writes: ${writes.join(", ")}`}`;
}

function jobPairs(catalog: Catalog): CandidatePair[] {
  const out: CandidatePair[] = [];
  const jobs = catalog.jobs;
  const terms = new Map(jobs.map((j) => [j.id, { trigger: significantTerms(j.job.trigger), outcome: significantTerms(j.job.outcome) }]));
  for (let i = 0; i < jobs.length; i++) {
    for (let k = i + 1; k < jobs.length; k++) {
      const a = jobs[i]!;
      const b = jobs[k]!;
      const reasons: string[] = [];
      const shared = a.personas.filter((p) => b.personas.includes(p));
      if (shared.length > 0) reasons.push(`both serve persona ${shared.map((p) => `'${p}'`).join(", ")}`);
      const ta = terms.get(a.id)!;
      const tb = terms.get(b.id)!;
      const all = (t: { trigger: Set<string>; outcome: Set<string> }) => new Set([...t.trigger, ...t.outcome]);
      const common = intersect(all(ta), all(tb));
      if (common.length >= 2 || (common.length === 1 && jaccard(all(ta), all(tb)) >= 0.3)) reasons.push(`shared trigger/outcome terms: ${common.sort().join(", ")}`);
      if (reasons.length > 0) out.push({ a: `job:${a.id}`, b: `job:${b.id}`, kind: "job", reasons });
    }
  }
  return out;
}

function personaPairs(catalog: Catalog): CandidatePair[] {
  const out: CandidatePair[] = [];
  const ps = catalog.personas;
  const jobsOf = (id: string) => new Set(catalog.jobs.filter((j) => j.personas.includes(id)).map((j) => j.id));
  for (let i = 0; i < ps.length; i++) {
    for (let k = i + 1; k < ps.length; k++) {
      const a = ps[i]!;
      const b = ps[k]!;
      const reasons: string[] = [];
      if (a.role !== undefined && b.role !== undefined && a.role.trim() !== "" && a.role.trim().toLowerCase() === b.role.trim().toLowerCase()) reasons.push(`same account role '${a.role.trim()}'`);
      const ja = jobsOf(a.id);
      const jb = jobsOf(b.id);
      const common = intersect(ja, jb);
      if (common.length > 0 && jaccard(ja, jb) >= 0.5) reasons.push(`largely the same jobs: ${common.sort().join(", ")}`);
      if (reasons.length > 0) out.push({ a: `persona:${a.id}`, b: `persona:${b.id}`, kind: "persona", reasons });
    }
  }
  return out;
}

function journeyPairs(catalog: Catalog): CandidatePair[] {
  const out: CandidatePair[] = [];
  const js = catalog.journeys;
  const writes = new Map(js.map((j) => [j.id, journeyWrites(j)]));
  for (let i = 0; i < js.length; i++) {
    for (let k = i + 1; k < js.length; k++) {
      const a = js[i]!;
      const b = js[k]!;
      const reasons: string[] = [];
      const pa = personaLinkId(catalog, a);
      if (a.job !== undefined && a.job === b.job && pa !== undefined && pa === personaLinkId(catalog, b)) reasons.push(`both do job '${a.job}' as persona '${pa}'`);
      const seen = new Set<string>();
      for (const wa of writes.get(a.id)!) {
        for (const wb of writes.get(b.id)!) {
          if (wa.resource !== wb.resource) continue;
          let why: string;
          if (OPPOSING_METHODS.has(`${wa.method}|${wb.method}`)) why = `opposing writes on ${wa.resource}: ${wa.method} ${wa.endpoint} vs ${wb.method} ${wb.endpoint}`;
          else if (wa.action !== undefined && wb.action !== undefined && OPPOSITE_ACTIONS[wa.action] === wb.action) why = `opposing writes on ${wa.resource}: ${wa.action} vs ${wb.action}`;
          else why = `both write ${wa.resource} (${wa.method} ${wa.endpoint}, ${wb.method} ${wb.endpoint})`;
          if (!seen.has(why)) {
            seen.add(why);
            reasons.push(why);
          }
        }
      }
      if (reasons.length > 0) out.push({ a: `journey:${a.id}`, b: `journey:${b.id}`, kind: "journey", reasons });
    }
  }
  return out;
}

/** #435: every candidate pair of the catalog, each with why code paired it. */
export function candidatePairs(catalog: Catalog): CandidatePair[] {
  return [...jobPairs(catalog), ...personaPairs(catalog), ...journeyPairs(catalog)];
}

/** The catalog an approval sees: the Journey being approved as it will be approved (demo approve annotates first). */
export function withJourney(catalog: Catalog, journey: CatalogJourney | undefined): Catalog {
  if (journey === undefined) return catalog;
  const others = catalog.journeys.filter((j) => j.id !== journey.id);
  return { ...catalog, journeys: [...others, journey].sort((x, y) => x.id.localeCompare(y.id)) };
}

// ── Jev classification ───────────────────────────────────────────────────────────────────────

const RELATION_MEANING: Readonly<Record<PairRelation, string>> = {
  compatible: "both can hold together; neither repeats nor contradicts the other",
  duplicate: "they describe the same job (or the same user, or the same flow)",
  overlapping: "one contains the other, or they largely cover the same ground",
  conflicting: "their outcomes cannot both hold (for the same user and data), or they leave the app in contradictory states",
  dependent: "one must happen before the other",
};

const RELATION_CHARACTERISTIC: Readonly<Record<PairRelation, GtwrSetCharacteristic>> = {
  compatible: "consistent",
  duplicate: "consistent",
  overlapping: "consistent",
  conflicting: "consistent",
  dependent: "comprehensible",
};

const RELATION_ACTION: Readonly<Record<PairRelation, string | undefined>> = {
  compatible: undefined,
  duplicate: "merge them, or retire one",
  overlapping: "split or reword them so one does not contain the other",
  conflicting: "reword one so both can hold, or scope them to different users or data",
  dependent: "state the order: make the earlier one a precondition of the later",
};

function pairQuestion(kind: CandidatePair["kind"]): Record<string, Question> {
  const what = kind === "job" ? "job stories" : kind === "persona" ? "personas" : "Journeys (recorded user flows)";
  return {
    relation: {
      kind: "choice",
      options: PAIR_RELATIONS,
      descriptions: RELATION_MEANING,
      instructions: `How do these two ${what} (A and B) relate? Answer only from their text.`,
    },
  };
}

function pairState(pair: CandidatePair, a: Item, b: Item): JudgmentState {
  return {
    goal: `Classify how two catalog ${pair.kind}s relate`,
    url: "about:catalog",
    controls: [],
    history: [],
    visibleText: [`A (${a.ref}): ${a.text}`, `B (${b.ref}): ${b.text}`, `Paired because: ${pair.reasons.join("; ")}`].join("\n"),
  };
}

function relationOf(a: Answer | undefined): { relation: PairRelation; probability: number } | undefined {
  if (a === undefined || a.kind !== "choice" || !(PAIR_RELATIONS as readonly string[]).includes(a.value)) return undefined;
  return { relation: a.value as PairRelation, probability: Math.min(1, Math.max(0, a.confidence)) };
}

// ── The analysis ─────────────────────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** The item being approved/reviewed: only its pairs are judged, and only advice involving it is given. Absent: the whole catalog. */
  readonly subject?: ApprovalSubject;
  /** The Jev layer; absent or skipped: the deterministic layer only. */
  readonly jev?: JevSetup;
  readonly pairCap?: number;
  /** True for an approval: the acknowledgment rule applies to the subject's pairs. */
  readonly gate?: boolean;
}

function f(code: string, severity: Finding["severity"], message: string, characteristic: GtwrSetCharacteristic, extra: { fix?: string; items?: string[]; probability?: number; ack?: boolean } = {}): Finding {
  return {
    analyzer: CATALOG_ANALYSIS,
    code,
    severity,
    message,
    ...(extra.fix === undefined ? {} : { fix: extra.fix }),
    requiresAcknowledgment: extra.ack === true,
    ...(extra.items === undefined || extra.items.length === 0 ? {} : { items: extra.items }),
    characteristic,
    ...(extra.probability === undefined ? {} : { probability: extra.probability }),
  };
}

function involves(ref: ItemRef, pair: Pick<CandidatePair, "a" | "b">): boolean {
  return pair.a === ref || pair.b === ref;
}

function completeness(catalog: Catalog, subjectRef: ItemRef | undefined): Finding[] {
  const out: Finding[] = [];
  const status = buildCatalogStatus(catalog);
  for (const p of catalog.personas) {
    if (subjectRef !== undefined && subjectRef !== `persona:${p.id}`) continue;
    if (!catalog.jobs.some((j) => j.status === "approved" && j.personas.includes(p.id))) {
      out.push(f(`gap.persona-no-approved-job:${p.id}`, "warn", `persona '${p.id}' has no approved job`, "complete", { fix: `write or approve a job that serves it (jevitate job approve <id>)`, items: [`persona:${p.id}`] }));
    }
  }
  for (const id of status.approvedJobsWithoutPromotedJourney) {
    if (subjectRef !== undefined && subjectRef !== `job:${id}`) continue;
    out.push(f(`gap.job-no-promoted-journey:${id}`, "warn", `approved job '${id}' has no promoted Journey`, "complete", { fix: "add a Journey that does it (explore-author-journey, record) and promote it", items: [`job:${id}`] }));
  }
  if (subjectRef?.startsWith("job:") === true) {
    const id = subjectRef.slice(4);
    const job = findJob(catalog, id);
    for (const pid of job?.personas ?? []) {
      if (!catalog.jobs.some((j) => j.id !== id && j.status === "approved" && j.personas.includes(pid))) {
        out.push(f(`fills.persona:${pid}`, "info", `approving job '${id}' gives persona '${pid}' its first approved job`, "complete", { items: [`persona:${pid}`] }));
      }
    }
  }
  if (subjectRef?.startsWith("journey:") === true) {
    const j = catalog.journeys.find((x) => `journey:${x.id}` === subjectRef);
    const pid = j === undefined ? undefined : personaLinkId(catalog, j);
    if (j?.job !== undefined && pid !== undefined) {
      const covered = catalog.journeys.some((x) => x.id !== j.id && x.promoted && x.job === j.job && personaLinkId(catalog, x) === pid);
      out.push(
        covered
          ? f("coverage.already-covered", "info", `job '${j.job}' as persona '${pid}' already has another promoted Journey — check this one adds something (see the pairs above)`, "consistent", { items: [`job:${j.job}`, `persona:${pid}`] })
          : f("coverage.fills-gap", "info", `promoting it covers job '${j.job}' as persona '${pid}', which has no other promoted Journey`, "complete", { items: [`job:${j.job}`, `persona:${pid}`] }),
      );
    }
  }
  return out;
}

async function updateAdvice(catalog: Catalog, subjectRef: ItemRef | undefined): Promise<Finding[]> {
  const out: Finding[] = [];
  const status = buildCatalogStatus(catalog);
  for (const s of status.stale) {
    const ref = `${s.kind}:${s.id}`;
    if (subjectRef !== undefined && subjectRef !== ref) continue;
    out.push(f(`update.stale:${ref}`, "warn", `consider re-reviewing ${s.kind} '${s.id}' because ${s.reason}`, "correct", { fix: `jevitate ${s.kind} review ${s.id}`, items: [ref] }));
  }
  for (const d of status.danglingLinks) {
    if (subjectRef !== undefined && subjectRef !== `journey:${d.journey}`) continue;
    out.push(f(`update.dangling:${d.journey}`, "warn", `consider updating journey '${d.journey}' because it links ${d.kind} '${d.id}', which the catalog does not declare`, "correct", { items: [`journey:${d.journey}`, `${d.kind}:${d.id}`] }));
  }
  if (catalog.journeysDir === undefined) return out;
  // The last recorded result of a promoted Journey: its mutation proof (`.verify/<id>.json`).
  for (const j of catalog.journeys) {
    if (!j.promoted) continue;
    const links = journeyLinks(catalog, j);
    const related = [`journey:${j.id}`, ...(links.job === undefined ? [] : [`job:${links.job.id}`]), ...(links.persona === undefined ? [] : [`persona:${links.persona.id}`])];
    if (subjectRef !== undefined && !related.includes(subjectRef)) continue;
    const rec = await readVerifyRecord(catalog.journeysDir, j.id);
    if (rec === null || rec.verdict === "proven") continue;
    const current = rec.contentHash === j.contentHash;
    out.push(
      f(
        `update.proof:${j.id}`,
        "warn",
        `consider updating journey '${j.id}'${links.job === undefined ? "" : ` (job '${links.job.id}')`} because its last mutation proof is ${rec.verdict} (${rec.at}${current ? "" : ", on an older version"})${rec.reason === undefined ? "" : `: ${rec.reason}`}`,
        rec.verdict === "insensitive" ? "able to be validated" : "feasible",
        { fix: `jevitate journey verify ${j.id} --mutate, then fix the Journey or its job`, items: related },
      ),
    );
  }
  return out;
}

async function suggestMissingJobs(catalog: Catalog, subjectRef: ItemRef | undefined, setup: JevSetup | undefined): Promise<Finding[]> {
  if (setup === undefined || !("advisor" in setup)) return [];
  const out: Finding[] = [];
  for (const p of catalog.personas) {
    if (subjectRef !== undefined && subjectRef !== `persona:${p.id}`) continue;
    const jobs = catalog.jobs.filter((j) => j.personas.includes(p.id));
    if (jobs.length === 0) continue; // the deterministic gap already says so
    const state: JudgmentState = {
      goal: "Judge whether this persona's job list is complete",
      url: "about:catalog",
      controls: [],
      history: [],
      visibleText: [`Persona '${p.id}'${p.role === undefined ? "" : ` (role: ${p.role})`}: ${p.description ?? "no description"}`, ...jobs.map((j) => `Job ${j.id}: ${j.story}`)].join("\n"),
    };
    const questions: Record<string, Question> = { complete: { kind: "noul", instructions: "Do these jobs cover what this kind of user obviously needs to do with the product (no obvious job missing)?" } };
    try {
      const { answers } = await setup.advisor.ask(state, questions);
      const a = answers.complete;
      const prob = a?.kind === "noul" ? a.probability : undefined;
      if (prob !== undefined && prob < 0.5) {
        out.push(f(`suggest.missing-jobs:${p.id}`, "info", `persona '${p.id}' may be missing jobs (a suggestion, never created): its ${jobs.length} job(s) may not cover what this user obviously needs`, "complete", { probability: prob, items: [`persona:${p.id}`], fix: "consider adding the job(s) this user needs to .jevitate/jobs.json" }));
      }
    } catch (err) {
      out.push(f(`jev.failed:missing-jobs:${p.id}`, "warn", `Jev could not judge persona '${p.id}''s job list: ${err instanceof Error ? err.message : String(err)}`, "complete"));
    }
  }
  return out;
}

function pairFinding(pair: CandidatePair, a: Item, b: Item, subjectRef: ItemRef | undefined, gate: boolean): Finding {
  const items = [pair.a, pair.b];
  const other = subjectRef === undefined ? `${pair.a}~${pair.b}` : pair.a === subjectRef ? pair.b : pair.a;
  const c = pair.classification;
  if (c === undefined) {
    return f(`pair:${other}`, "info", `candidate pair ${pair.a} and ${pair.b} (${pair.reasons.join("; ")}) — not classified`, "consistent", { items });
  }
  const gating = (c.relation === "conflicting" || c.relation === "duplicate") && c.probability >= CONFLICT_ACK_THRESHOLD;
  const ack = gate && gating && subjectRef !== undefined && involves(subjectRef, pair);
  const severity: Finding["severity"] = gating ? "fail" : c.relation === "compatible" || c.relation === "dependent" ? "info" : "warn";
  const action = RELATION_ACTION[c.relation];
  return f(`${c.relation}:${other}`, severity, `${c.relation}: ${a.ref} and ${b.ref} — ${c.reason}`, RELATION_CHARACTERISTIC[c.relation], {
    items,
    probability: c.probability,
    ...(action === undefined ? {} : { fix: action }),
    ack,
  });
}

function pairReason(pair: CandidatePair, a: Item, b: Item): string {
  return `${quote(a.text)} vs ${quote(b.text)} (paired: ${pair.reasons.join("; ")})`;
}

function refOfSubject(s: ApprovalSubject): ItemRef {
  return `${s.kind}:${s.id}`;
}

/**
 * #435: the catalog analysis — of the whole catalog (`catalog analyze`), or incrementally of the
 * item being approved/reviewed (`opts.subject`: only its pairs, only advice involving it). Never writes.
 */
export async function analyzeCatalog(catalog: Catalog, opts: AnalyzeOptions = {}): Promise<{ report: CatalogAnalysis; findings: Finding[] }> {
  const subjectRef = opts.subject === undefined ? undefined : refOfSubject(opts.subject);
  const cap = Math.max(1, opts.pairCap ?? (subjectRef === undefined ? ANALYZE_PAIR_CAP : APPROVAL_PAIR_CAP));
  const items = new Map(itemsOf(catalog).map((i) => [i.ref, i]));
  const all = candidatePairs(catalog).filter((p) => subjectRef === undefined || involves(subjectRef, p));
  // Judge first what matters most: pairs with an approved/promoted item, then the best-evidenced.
  const vetted = (p: CandidatePair) => Number(items.get(p.a)?.vetted === true) + Number(items.get(p.b)?.vetted === true);
  const ranked = all.map((p, i) => ({ p, i })).sort((x, y) => vetted(y.p) - vetted(x.p) || y.p.reasons.length - x.p.reasons.length || x.i - y.i).map(({ p }) => p);
  const judged = ranked.slice(0, cap);
  const overflow = ranked.slice(cap);
  const setup = opts.jev;
  const advisor = setup !== undefined && "advisor" in setup ? setup.advisor : undefined;
  const findings: Finding[] = [];
  const pairs: CandidatePair[] = [];
  for (const pair of judged) {
    const a = items.get(pair.a)!;
    const b = items.get(pair.b)!;
    let classified: CandidatePair = pair;
    if (advisor !== undefined) {
      try {
        const { answers, cached } = await advisor.ask(pairState(pair, a, b), pairQuestion(pair.kind));
        const rel = relationOf(answers.relation);
        if (rel !== undefined) classified = { ...pair, classification: { ...rel, reason: pairReason(pair, a, b), cached } };
      } catch (err) {
        findings.push(f(`jev.failed:${pair.a}~${pair.b}`, "warn", `Jev could not classify ${pair.a} and ${pair.b}: ${err instanceof Error ? err.message : String(err)} — listed unclassified`, "consistent", { items: [pair.a, pair.b] }));
      }
    }
    pairs.push(classified);
    findings.push(pairFinding(classified, a, b, subjectRef, opts.gate === true));
  }
  if (overflow.length > 0) {
    findings.push(
      f("pairs.overflow", "warn", `${overflow.length} more candidate pair(s) were not judged (cap ${cap}): ${overflow.map((p) => `${p.a}~${p.b}`).join(", ")}`, "consistent", {
        fix: subjectRef === undefined ? "raise --max-pairs, or analyze again after resolving the judged pairs" : "run `jevitate catalog analyze --real` to judge them all",
        items: [...new Set(overflow.flatMap((p) => [p.a, p.b]))],
      }),
    );
  }
  if (advisor === undefined && judged.length > 0) {
    findings.push(f("jev.skipped", "info", `Jev classification skipped: ${setup !== undefined && "skipped" in setup ? setup.skipped : JEV_SKIPPED_PASS_REAL} — the candidate pairs are listed unclassified`, "consistent"));
  }
  findings.push(...completeness(catalog, subjectRef));
  findings.push(...(await updateAdvice(catalog, subjectRef)));
  findings.push(...(await suggestMissingJobs(catalog, subjectRef, setup)));
  const groups = GTWR_SET_CHARACTERISTICS.map((characteristic) => ({ characteristic, findings: findings.filter((x) => x.characteristic === characteristic) })).filter((g) => g.findings.length > 0);
  const report = CatalogAnalysisSchema.parse({
    scope: opts.subject === undefined ? { kind: "catalog" } : { kind: opts.subject.kind, id: opts.subject.id },
    catalogHash: contentHash([...items.values()].map((i) => [i.ref, i.hash]).sort()),
    threshold: CONFLICT_ACK_THRESHOLD,
    pairCap: cap,
    pairs,
    overflow,
    groups,
    jev: jevLayerOf(setup),
  });
  return { report, findings };
}

/** #435: the incremental analysis before every approval (and in every review sheet). */
export const catalogAnalysisAnalyzer: PreApprovalAnalyzer = {
  id: CATALOG_ANALYSIS,
  appliesTo: ["persona", "job", "journey"],
  async analyze(subject, catalog, ctx) {
    const view = subject.kind === "journey" && ctx.journey !== undefined ? withJourney(catalog, catalogJourney(ctx.journey)) : catalog;
    const known =
      subject.kind === "journey" ? view.journeys.some((j) => j.id === subject.id) : subject.kind === "job" ? findJob(view, subject.id) !== undefined : findPersona(view, subject.id) !== undefined;
    if (!known) return [];
    const { findings } = await analyzeCatalog(view, { subject, ...(ctx.jev === undefined ? {} : { jev: ctx.jev }), gate: ctx.action !== "review" });
    return findings;
  },
};

// ── Rendering ────────────────────────────────────────────────────────────────────────────────

/** #435: `jevitate catalog analyze` as text or Markdown. */
export function renderCatalogAnalysis(r: CatalogAnalysis, style: "markdown" | "text"): string {
  const md = style === "markdown";
  const h1 = (s: string): string => (md ? `# ${s}` : `${s}\n${"=".repeat(s.length)}`);
  const h2 = (s: string): string => (md ? `## ${s}` : s.toUpperCase());
  const li = (s: string): string => `${md ? "" : "  "}- ${s}`;
  const all = r.groups.flatMap((g) => g.findings);
  const jev = r.jev.status === "skipped" ? `skipped — ${r.jev.reason ?? ""}` : `ran — ${r.jev.asked} question(s) asked, ${r.jev.cached} answered from the cache`;
  const out = [
    h1("Catalog analysis"),
    "",
    `Catalog hash: ${r.catalogHash}`,
    `Jev classification (advisory): ${jev}`,
    `Candidate pairs: ${r.pairs.length} judged (cap ${r.pairCap})${r.overflow.length === 0 ? "" : `, ${r.overflow.length} over the cap (listed, not judged)`}`,
    `Acknowledgment threshold (on approval): conflicting / duplicate at p ≥ ${r.threshold}`,
    "",
    h2("Candidate pairs"),
    "",
    ...(r.pairs.length === 0
      ? [li("none")]
      : r.pairs.map((p) => li(`${p.a} ~ ${p.b}: ${p.classification === undefined ? "unclassified" : `${p.classification.relation} (p=${p.classification.probability.toFixed(2)}${p.classification.cached ? ", cached" : ""})`} — paired: ${p.reasons.join("; ")}`))),
    ...(r.overflow.length === 0 ? [] : ["", h2("Over the cap (not judged)"), "", ...r.overflow.map((p) => li(`${p.a} ~ ${p.b} — paired: ${p.reasons.join("; ")}`))]),
    "",
    h2("Findings by GtWR set characteristic"),
    "",
    ...(all.length === 0 ? [li("none")] : renderAnalysisGroups(all, style)),
  ];
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
