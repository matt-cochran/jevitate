import { JOURNEY_MISSION_OUTCOME, JOURNEY_RUN_OUTCOMES, MISSION_EXIT_CODES, MISSION_OUTCOMES, type MissionOutcome } from "@jevitate/domain";
import { flatJourneySteps, SECRET_PARAM_NAME_RE, type CatalogApproval, type Journey } from "@jevitate/journey";
import { CatalogInputError, findJob, findPersona, type Catalog, type CatalogJourney } from "./catalog.js";
import { describeRefIssue, jobRefIssues, journeyRefIssues, RESERVED_ANCHORS } from "./catalog-refs.js";

/**
 * #464 (d464a) — the PURE builder of a Journeeze catalog bundle, version 1.0 (journeeze-saas
 * `docs/contract/catalog-bundle-v1.md` at 61f8c92, schema `catalog-bundle.v1.json`). No I/O, no
 * clock: catalog-bundle-api.ts loads the catalog, the raw persona entries, the `check.json` records
 * and the producer identity, and writes what this returns.
 *
 * What goes out, and how (each rule is the contract's):
 *  - personas: `{id, description, role, otherFields, approval}` — every descriptive key, so §8's
 *    persona hash (`{id, …description, role and otherFields}`) recomputes to jevitate's
 *    `personaContentHash`. Session keys (`storageState`, `login`) never leave.
 *  - jobs: the `jobs.json` entry as loaded (every jtbd and campaign field — the hash input), with its
 *    approval reduced to the contract's `{contentHash, at, channel}` (approval is outside the hash).
 *  - journeys: PROMOTED Journeys only, the file as jevitate reads it (the review-hash input), with
 *    approval provenance reduced to `{channel, agentSignals}` (no OS user, no reason, no PR reviewer —
 *    bookkeeping outside the hash), and `link {job, persona, anchors, serves}` from its metadata.
 *  - checks: one per check item that ran, keyed (target.id, commit, runId); a baseline only from a
 *    clean run whose `journeyHash` is the exported Journey's approved hash.
 *  - findings: whatever the d464c source hands in (`CatalogBundleFinding`), guarded; none by default.
 *  - demos and media: NONE in 0.10 — a demo must carry the jz-mask-v1 + synthetic-data attestation,
 *    which jevitate cannot make yet, and the contract says a producer that cannot meet it exports no
 *    media. So no `demos`, no `files`.
 *  - `generatedAt` is left out on purpose: the same catalog gives the same bytes, so the upload's
 *    `Idempotency-Key` (sha256 of bundle.json) dedupes a re-publish.
 *
 * Failure policy: personal data or a credential typed in clear anywhere, or a job the bundle cannot
 * carry (a structural reference problem, text that is not one line), REFUSES the export
 * (`CatalogBundleInputError`, exit 64) — nothing is guessed or silently rewritten. A Journey or a
 * check the bundle cannot carry is LEFT OUT with a warning (nothing else references it in a way the
 * reader would refuse). A persona key the bundle cannot carry drops that key and the persona's
 * approval (its hash could not recompute) with a warning.
 */

// ── The bundle (catalog-bundle.v1.json), as jevitate produces it ─────────────────────────────

export const BUNDLE_KIND = "journeeze.catalog-bundle" as const;
export const BUNDLE_VERSION = 1 as const;
/** The schema minor this producer is built against (contract 61f8c92). */
export const BUNDLE_MINOR = 0 as const;

export interface BundleApproval {
  readonly contentHash: string;
  readonly at: string;
  readonly channel?: string;
}

export interface BundlePersona {
  readonly id: string;
  readonly description?: string;
  readonly role?: string;
  readonly otherFields?: Readonly<Record<string, string | number | boolean>>;
  readonly approval?: BundleApproval;
}

/** A `jobs.json` entry as loaded, with its approval in the contract's shape. */
export type BundleJob = Readonly<Record<string, unknown>> & { readonly id: string; readonly approval?: BundleApproval };

export interface BundleAnchor {
  readonly name: string;
  /** 1-based step of the Journey's flat step list. */
  readonly step: number;
  readonly jobStep?: string;
  readonly boundary?: "start" | "end";
}

export interface BundleLink {
  readonly job: string;
  readonly persona?: string;
  readonly anchors?: readonly BundleAnchor[];
  readonly serves?: readonly string[];
}

export interface BundleJourneyEntry {
  /** The Journey file (opaque to the reader beyond a few metadata fields). */
  readonly journey: Readonly<Record<string, unknown>>;
  readonly link?: BundleLink;
}

export const CHECK_TARGET_KINDS = ["journey", "goal", "mission", "invariant", "verify_fix", "regression"] as const;
export type BundleCheckTargetKind = (typeof CHECK_TARGET_KINDS)[number];

export interface BundleBaselinePoint {
  /** An anchor name, or the reserved `job_start` / `job_end`. */
  readonly anchor: string;
  readonly step: number;
  /** Milliseconds from the first step's start to this step's completion. */
  readonly atMs: number;
}

export interface BundleBaseline {
  readonly steps: number;
  readonly totalMs: number;
  readonly anchors: readonly BundleBaselinePoint[];
}

export interface BundleCheck {
  readonly target: { readonly id: string; readonly kind?: BundleCheckTargetKind };
  readonly commit: string;
  readonly at: string;
  readonly runId?: string;
  readonly journey?: string;
  readonly journeyHash?: string;
  readonly outcome: MissionOutcome;
  readonly exitCode: number;
  readonly journeyOutcome?: (typeof JOURNEY_RUN_OUTCOMES)[number];
  readonly failureKind?: string;
  readonly durationMs?: number;
  readonly baseline?: BundleBaseline;
}

/**
 * d464c HOOK: one machine finding as the contract's `findings[]` carries it (§4.4) — UX claims with
 * the derived fingerprint, defects and hangs with jevitate's. 0.10 exports no media, so no
 * `screenshot`/`box`. The d464c deliverable produces these (fingerprint + PII scan) and passes them in
 * through `CatalogBundleInput.findings`; until then the bundle carries `findings: []`.
 */
export interface CatalogBundleFinding {
  readonly fingerprint: string;
  readonly kind: "ux" | "defect" | "hang";
  readonly claim?: "next-step-unclear" | "no-feedback" | "blocked-action" | "error-unrecoverable" | "destructive-unguarded" | "fact-conflict" | "other";
  readonly producerClaim?: string;
  readonly severity: "info" | "minor" | "major";
  readonly confidence?: number;
  readonly commit?: string;
  readonly at: string;
  readonly target?: string;
  readonly journey?: string;
  readonly step?: number;
  readonly anchor?: string;
  /** A route TEMPLATE: no query, fragment, host or record id. */
  readonly route?: string;
  readonly tflowId?: string;
  readonly controls?: readonly string[];
  readonly observation: string;
  readonly userImpact?: string;
  readonly recommendation?: string;
  readonly citation?: { readonly source: string; readonly ref: string };
}

export interface CatalogBundleV1 {
  readonly kind: typeof BUNDLE_KIND;
  readonly version: typeof BUNDLE_VERSION;
  readonly minor: typeof BUNDLE_MINOR;
  readonly producer: { readonly tool: "jevitate"; readonly version: string; readonly commit?: string };
  readonly product: { readonly name: string };
  readonly catalog: {
    readonly personas: readonly BundlePersona[];
    readonly jobs: readonly BundleJob[];
    readonly journeys: readonly BundleJourneyEntry[];
  };
  readonly checks: readonly BundleCheck[];
  readonly findings: readonly CatalogBundleFinding[];
}

// ── Input ────────────────────────────────────────────────────────────────────────────────────

/** One `jevitate check` record (`check.json`'s `data`, or the bare result) and where it came from. */
export interface CheckRecordInput {
  readonly source: string;
  readonly record: unknown;
}

export interface CatalogBundleInput {
  /** `producer.version` (semver) and `producer.commit` (the product repo's HEAD, when known). */
  readonly producer: { readonly version: string; readonly commit?: string };
  readonly productName: string;
  readonly catalog: Catalog;
  /** Each persona's raw `personas.json` keys (all but its `name`/`id`) — the persona hash input. */
  readonly personaFields: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly checks: readonly CheckRecordInput[];
  /** d464c: the machine findings to export (default none). */
  readonly findings?: readonly CatalogBundleFinding[];
}

export interface CatalogBundleBuild {
  readonly bundle: CatalogBundleV1;
  /** Items left out or degraded, each with why. */
  readonly warnings: readonly string[];
}

/** The catalog cannot be exported as it is (personal data, a credential typed in clear, a job the bundle cannot carry) — exit 64. */
export class CatalogBundleInputError extends CatalogInputError {
  override readonly code: string = "E_CATALOG_EXPORT_INPUT";
  constructor(readonly issues: readonly string[]) {
    super(`the catalog cannot be exported as a Journeeze bundle (${issues.length} problem(s)): ${issues.join("; ")}`);
  }
}

// ── The contract's text and id rules (catalog-bundle.v1.json $defs) ──────────────────────────

const CATALOG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]{1,40})?$/;
const DATE_TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FAILURE_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;
const OTHER_FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ONE_LINE_RE = /^(?=.*\S)[^\u0000-\u001f\u007f]+$/u;
const PERSONAL_DATA_RES = [/[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}/u, /[0-9]{9,}/u];
const URL_RES = [/:\/\//u, /(?:^|[^A-Za-z0-9])[Ww][Ww][Ww]\./u];
const RECORD_ID_RES = [
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/u,
  /(?<![0-9A-Za-z])(?=[0-9a-fA-F]*[0-9])[0-9a-fA-F]{8,}(?![0-9A-Za-z])/u,
  /[0-9]{6,}/u,
];
const ROUTE_TEMPLATE_RE = /^(\/(\{[A-Za-z][A-Za-z0-9_]{0,63}\}|[A-Za-z0-9._~-]+))*\/?$/u;
const TFLOW_ID_RE = /^[a-z0-9._:-]{1,96}$/u;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/u;
const APPROVAL_CHANNELS: ReadonlySet<string> = new Set(["tty", "mcp", "ci", "non-interactive", "pr-review", "other"]);
const RESERVED: ReadonlySet<string> = new Set(RESERVED_ANCHORS);
const SESSION_KEYS: ReadonlySet<string> = new Set(["storageState", "login"]);
const PERSONA_NAMED_KEYS: ReadonlySet<string> = new Set(["id", "name", "description", "role", "approval", "storageState", "login"]);
const MAX_MS = 86_400_000;
const MAX_STEP = 200;
const LIMITS = { personas: 200, jobs: 500, journeys: 1000, checks: 5000, findings: 5000 } as const;

/** Looks like personal data (an email, or 9+ digits) — the contract's `noPersonalData`. */
export function looksPersonal(s: string): boolean {
  return PERSONAL_DATA_RES.some((re) => re.test(s));
}

/** The contract's `catalogText`: one printable line, no personal data. */
function catalogTextProblem(s: unknown): string | null {
  if (typeof s !== "string") return "is not text";
  if (!ONE_LINE_RE.test(s)) return "is not one printable line";
  if (looksPersonal(s)) return "looks like personal data (an email or 9+ digits)";
  return null;
}

/** The contract's `machineText`: `catalogText`, and no URL and no record id. */
function machineTextProblem(s: unknown, max: number): string | null {
  const p = catalogTextProblem(s);
  if (p !== null) return p;
  const t = s as string;
  if (t.length > max) return `is longer than ${max} characters`;
  if (URL_RES.some((re) => re.test(t))) return "carries a URL";
  if (RECORD_ID_RES.some((re) => re.test(t))) return "carries a record id";
  return null;
}

/** The contract's `routeTemplate`: a path template — no query string, fragment, host or record id. */
export function isRouteTemplate(route: string): boolean {
  return route.length >= 1 && route.length <= 256 && ROUTE_TEMPLATE_RE.test(route) && !RECORD_ID_RES.some((re) => re.test(route));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A deep copy through JSON — exactly what the reader sees (and hashes). */
function asJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** A catalog approval in the contract's shape; null when it cannot be carried (`at` not a date-time). */
function bundleApproval(a: CatalogApproval): BundleApproval | null {
  if (!SHA256_RE.test(a.contentHash) || !DATE_TIME_RE.test(a.at)) return null;
  const channel = a.provenance?.channel;
  return { contentHash: a.contentHash, at: a.at, ...(channel !== undefined && APPROVAL_CHANNELS.has(channel) ? { channel } : {}) };
}

// ── Personas ─────────────────────────────────────────────────────────────────────────────────

function bundlePersonas(input: CatalogBundleInput, refuse: string[], warn: string[]): BundlePersona[] {
  return input.catalog.personas.map((p) => {
    const fields = input.personaFields.get(p.id) ?? {};
    const where = `persona ${p.id}`;
    const dropped: string[] = [];
    const text = (key: "description" | "role", max: number): string | undefined => {
      const v = fields[key];
      if (typeof v !== "string") return undefined;
      if (looksPersonal(v)) {
        refuse.push(`${where}: ${key} looks like personal data (an email or 9+ digits)`);
        return undefined;
      }
      if (catalogTextProblem(v) !== null || v.length > max) {
        dropped.push(key);
        return undefined;
      }
      return v;
    };
    const description = text("description", 2000);
    const role = text("role", 200);
    const otherFields: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (PERSONA_NAMED_KEYS.has(k) || SESSION_KEYS.has(k)) continue;
      if (typeof v === "string" && looksPersonal(v)) {
        refuse.push(`${where}: ${k} looks like personal data (an email or 9+ digits)`);
        continue;
      }
      const scalar = (typeof v === "string" && v.length <= 1000) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";
      if (!OTHER_FIELD_KEY_RE.test(k) || !scalar) {
        dropped.push(k);
        continue;
      }
      otherFields[k] = v as string | number | boolean;
    }
    if (Object.keys(otherFields).length > 20) {
      dropped.push(...Object.keys(otherFields).slice(20));
      for (const k of Object.keys(otherFields).slice(20)) delete otherFields[k];
    }
    let approval = p.approval === undefined ? null : bundleApproval(p.approval);
    if (dropped.length > 0) {
      warn.push(
        `${where}: ${dropped.join(", ")} cannot travel in the bundle (one line of text; other keys: a simple name and a short text, number or boolean) — left out${p.approval === undefined ? "" : ", and so is its approval (its hash could not recompute)"}`,
      );
      approval = null;
    } else if (p.approval !== undefined && approval === null) {
      warn.push(`${where}: its approval's time is not an ISO date-time — exported without its approval`);
    }
    return {
      id: p.id,
      ...(description === undefined ? {} : { description }),
      ...(role === undefined ? {} : { role }),
      ...(Object.keys(otherFields).length === 0 ? {} : { otherFields }),
      ...(approval === null ? {} : { approval }),
    };
  });
}

// ── Jobs ─────────────────────────────────────────────────────────────────────────────────────

function jobTextIssues(job: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const catalogText = (path: string, v: unknown): void => {
    if (v === undefined) return;
    const p = catalogTextProblem(v);
    if (p !== null) out.push(`${path} ${p}`);
  };
  const personal = (path: string, v: unknown): void => {
    if (typeof v === "string" && looksPersonal(v)) out.push(`${path} looks like personal data (an email or 9+ digits)`);
  };
  for (const k of ["trigger", "motivation", "outcome"]) catalogText(k, job[k]);
  for (const k of ["context", "constraints"]) if (Array.isArray(job[k])) (job[k] as unknown[]).forEach((v, i) => catalogText(`${k}[${i}]`, v));
  if (Array.isArray(job.steps)) job.steps.forEach((s, i) => isRecord(s) && catalogText(`steps[${i}].name`, s.name));
  if (Array.isArray(job.desiredOutcomes)) {
    job.desiredOutcomes.forEach((o, i) => {
      if (!isRecord(o)) return;
      catalogText(`desiredOutcomes[${i}].object`, o.object);
      catalogText(`desiredOutcomes[${i}].clarifier`, o.clarifier);
    });
  }
  personal("goal", job.goal);
  for (const k of ["success", "preconditions"]) if (Array.isArray(job[k])) (job[k] as unknown[]).forEach((v, i) => personal(`${k}[${i}]`, v));
  return out;
}

function bundleJobs(input: CatalogBundleInput, refuse: string[], warn: string[]): BundleJob[] {
  const { catalog } = input;
  return catalog.jobs.map((j) => {
    const { approval: _a, ...rest } = asJson(j.job) as Record<string, unknown> & { approval?: unknown };
    for (const issue of jobTextIssues(rest)) refuse.push(`job ${j.id}: ${issue}`);
    for (const issue of jobRefIssues(catalog, j.id, { enforce: true })) if (issue.severity === "error") refuse.push(describeRefIssue(issue));
    let approval: BundleApproval | null = null;
    if (j.approval !== undefined) {
      approval = bundleApproval(j.approval);
      if (approval === null) warn.push(`job ${j.id}: its approval's time is not an ISO date-time — exported without its approval`);
    }
    return { ...rest, id: j.id, ...(approval === null ? {} : { approval }) };
  });
}

// ── Journeys ─────────────────────────────────────────────────────────────────────────────────

/** Every `{redacted:false, value}` under `node`, with its path — the typed values kept in clear. */
function clearValues(node: unknown, path: string, out: Array<{ path: string; value: string; secretField: boolean }>, secretField = false): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => clearValues(v, `${path}[${i}]`, out, secretField));
    return;
  }
  if (!isRecord(node)) return;
  // A step whose target reads as a credential (password, token, otp, …): its literal is a secret.
  const target = node.target;
  const secretHere = isRecord(target) && ["name", "label", "testId", "text"].some((k) => typeof target[k] === "string" && SECRET_PARAM_NAME_RE.test(target[k]));
  if (node.redacted === false && typeof node.value === "string") out.push({ path, value: node.value, secretField });
  for (const [k, v] of Object.entries(node)) clearValues(v, `${path}.${k}`, out, k === "value" ? secretHere || secretField : secretField);
}

/** Journey approval bookkeeping (outside the review hash) keeps only the channel and agent markers: no OS user, reason or reviewer. */
function trimProvenance(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trimProvenance);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "provenance" && isRecord(x)) out[k] = { channel: x.channel, agentSignals: Array.isArray(x.agentSignals) ? x.agentSignals : [] };
    else out[k] = trimProvenance(x);
  }
  return out;
}

interface ExportedJourney {
  readonly entry: BundleJourneyEntry;
  readonly cj: CatalogJourney;
}

/** Why a promoted Journey cannot travel in the bundle, or null when it can (with its link). */
function journeyLink(catalog: Catalog, cj: CatalogJourney): { link?: BundleLink } | { omit: string } {
  const m = cj.journey.metadata;
  if (!CATALOG_ID_RE.test(m.id)) return { omit: "its id is not a bundle id (1-64 of [A-Za-z0-9._-])" };
  if (m.name.length < 1 || m.name.length > 200) return { omit: "its name is not 1-200 characters" };
  if (m.persona !== undefined) {
    if (!CATALOG_ID_RE.test(m.persona)) return { omit: `metadata.persona ${JSON.stringify(m.persona)} is free text — the bundle needs a persona id from personas.json` };
    if (findPersona(catalog, m.persona) === undefined) return { omit: `metadata.persona '${m.persona}' is not a persona in personas.json` };
  }
  if (m.job !== undefined && findJob(catalog, m.job) === undefined) return { omit: `metadata.job '${m.job}' is not a job in jobs.json` };
  const structural = journeyRefIssues(catalog, cj, { enforce: true }).filter((i) => i.severity === "error");
  if (structural.length > 0) return { omit: structural.map(describeRefIssue).join("; ") };
  const flat = flatJourneySteps(cj.journey);
  const anchors: BundleAnchor[] = [];
  for (const a of m.anchors ?? []) {
    if (!CATALOG_ID_RE.test(a.name) || RESERVED.has(a.name)) return { omit: `anchor '${a.name}' is not a bundle anchor name (1-64 of [A-Za-z0-9._-], never job_start/job_end)` };
    if (a.stepId !== undefined) {
      const at = flat.findIndex((s) => s.recorded.stepId === a.stepId);
      if (at < 0) return { omit: `anchor '${a.name}' names stepId '${a.stepId}', which no step has` };
      if (at + 1 !== a.step) return { omit: `anchor '${a.name}': step ${a.step}, but its stepId '${a.stepId}' is step ${at + 1} — re-save the Journey so they agree` };
    }
    if (a.step > flat.length || a.step > MAX_STEP) return { omit: `anchor '${a.name}': step ${a.step} is not one of its ${flat.length} steps (at most ${MAX_STEP})` };
    if (m.job === undefined) continue;
    anchors.push({ name: a.name, step: a.step, ...(a.jobStep === undefined ? {} : { jobStep: a.jobStep }), ...(a.boundary === undefined ? {} : { boundary: a.boundary }) });
  }
  if (m.job === undefined) return {};
  return {
    link: {
      job: m.job,
      ...(m.persona === undefined ? {} : { persona: m.persona }),
      ...(anchors.length === 0 ? {} : { anchors }),
      ...(m.serves === undefined || m.serves.length === 0 ? {} : { serves: [...m.serves] }),
    },
  };
}

function bundleJourneys(catalog: Catalog, refuse: string[], warn: string[]): ExportedJourney[] {
  const out: ExportedJourney[] = [];
  for (const cj of catalog.journeys) {
    if (!cj.promoted) {
      warn.push(`journey ${cj.id}: not promoted — left out (only promoted Journeys are exported)`);
      continue;
    }
    const clear: Array<{ path: string; value: string; secretField: boolean }> = [];
    clearValues(cj.journey, "", clear);
    for (const c of clear) {
      if (c.secretField) refuse.push(`journey ${cj.id}: ${c.path.slice(1)} types a credential-looking field in clear — make it a secret parameter`);
      else if (looksPersonal(c.value)) refuse.push(`journey ${cj.id}: ${c.path.slice(1)} types personal data in clear (an email or 9+ digits) — use a parameter or a synthetic value`);
    }
    const linked = journeyLink(catalog, cj);
    if ("omit" in linked) {
      warn.push(`journey ${cj.id}: ${linked.omit} — left out`);
      continue;
    }
    const file = asJson(cj.journey) as unknown as Record<string, unknown> & { metadata: Record<string, unknown> };
    if (file.metadata.approval !== undefined) file.metadata.approval = trimProvenance(file.metadata.approval);
    out.push({ cj, entry: { journey: file, ...(linked.link === undefined ? {} : { link: linked.link }) } });
  }
  return out;
}

// ── Checks ───────────────────────────────────────────────────────────────────────────────────

const VERIFY_FIX_OUTCOME: Readonly<Record<string, MissionOutcome>> = {
  fixed: "clean",
  "still-reproduces": "defects-found",
  intermittent: "intermittent",
  inconclusive: "inconclusive",
};

const TARGET_KIND: Readonly<Record<string, BundleCheckTargetKind>> = { journey: "journey", goal: "goal", mission: "mission", "verify-fix": "verify_fix" };

function kebab(s: string): string {
  return s
    .replace(/^E_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

/** A check item's canonical outcome (+ the Journey run's own ending, + why it is inconclusive). */
function itemOutcome(item: Record<string, unknown>): { outcome: MissionOutcome; journeyOutcome?: (typeof JOURNEY_RUN_OUTCOMES)[number]; failureKind?: string } | null {
  const raw = typeof item.outcome === "string" ? item.outcome : undefined;
  const errorType = isRecord(item.error) && typeof item.error.type === "string" ? item.error.type : undefined;
  if (item.verdict === "pending-review") return { outcome: "pending-review", journeyOutcome: "healed-pending-review" };
  if (raw !== undefined && (JOURNEY_RUN_OUTCOMES as readonly string[]).includes(raw)) {
    const jo = raw as (typeof JOURNEY_RUN_OUTCOMES)[number];
    return { outcome: JOURNEY_MISSION_OUTCOME[jo], journeyOutcome: jo };
  }
  if (raw !== undefined && (MISSION_OUTCOMES as readonly string[]).includes(raw)) {
    const outcome = raw as MissionOutcome;
    const kind = errorType !== undefined && errorType !== raw && outcome === "inconclusive" ? kebab(errorType) : "";
    return { outcome, ...(FAILURE_KIND_RE.test(kind) ? { failureKind: kind } : {}) };
  }
  if (raw !== undefined && item.kind === "verify-fix" && VERIFY_FIX_OUTCOME[raw] !== undefined) return { outcome: VERIFY_FIX_OUTCOME[raw]! };
  // `not-started`, `host-starved`, an item error with no verdict: inconclusive, and why (contract §12.3).
  if (item.status === "error" || raw !== undefined) {
    const why = kebab(raw ?? errorType ?? "error");
    if (why === "crashed") return { outcome: "crashed" };
    return { outcome: "inconclusive", ...(FAILURE_KIND_RE.test(why) && why !== "inconclusive" ? { failureKind: why } : {}) };
  }
  return null;
}

function bundleTargetId(name: string): string | null {
  const id = name.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 64);
  return TARGET_ID_RE.test(id) ? id : null;
}

function intMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const ms = Math.round(v);
  return ms <= MAX_MS ? ms : null;
}

function bundleBaseline(raw: unknown, journey: Journey): { baseline: BundleBaseline } | { drop: string } {
  if (!isRecord(raw)) return { drop: "it is not a baseline record" };
  const steps = raw.steps;
  const totalMs = intMs(raw.totalMs);
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > MAX_STEP) return { drop: `its step count ${String(steps)} is not 1-${MAX_STEP}` };
  if (totalMs === null) return { drop: "its total time is not 0-86400000 ms" };
  const flat = flatJourneySteps(journey);
  const anchors: BundleBaselinePoint[] = [];
  for (const a of Array.isArray(raw.anchors) ? raw.anchors : []) {
    if (!isRecord(a) || typeof a.name !== "string") return { drop: "an anchor point has no name" };
    if (!CATALOG_ID_RE.test(a.name)) return { drop: `anchor point '${a.name}' is not a bundle anchor name` };
    let step: number | undefined;
    if (typeof a.stepId === "string") {
      const at = flat.findIndex((s) => s.recorded.stepId === a.stepId);
      if (at >= 0) step = at + 1;
    }
    if (step === undefined && typeof a.step === "number" && Number.isInteger(a.step)) step = a.step;
    if (step === undefined && a.name === "job_start") step = 1;
    if (step === undefined && a.name === "job_end") step = steps;
    if (step === undefined || step < 1 || step > MAX_STEP) return { drop: `anchor point '${a.name}' has no step` };
    const atMs = intMs(a.atMs);
    if (atMs === null) return { drop: `anchor point '${a.name}': its time is not 0-86400000 ms` };
    anchors.push({ anchor: a.name, step, atMs });
  }
  if (anchors.length > MAX_STEP + 2) return { drop: "it has more anchor points than the bundle carries" };
  return { baseline: { steps, totalMs, anchors } };
}

function bundleChecks(input: CatalogBundleInput, journeys: readonly ExportedJourney[], warn: string[]): BundleCheck[] {
  const byId = new Map(journeys.map((j) => [j.cj.id, j.cj]));
  const out = new Map<string, BundleCheck>();
  for (const { source, record } of input.checks) {
    const data = isRecord(record) && isRecord(record.data) ? record.data : record;
    if (!isRecord(data) || data.kind !== "jevitate-check" || !Array.isArray(data.items)) {
      warn.push(`${source}: not a jevitate check record — left out`);
      continue;
    }
    const commit = typeof data.targetBuild === "string" ? data.targetBuild.trim().toLowerCase() : "";
    if (!COMMIT_RE.test(commit)) {
      warn.push(`${source}: the check names no commit (run it with --target-build <commit sha>) — its items are left out`);
      continue;
    }
    const at = typeof data.startedAt === "string" ? data.startedAt : "";
    if (!DATE_TIME_RE.test(at)) {
      warn.push(`${source}: the check's start time is not an ISO date-time — its items are left out`);
      continue;
    }
    const checkRunId = `check-${at.replace(/[^0-9A-Za-z]+/g, "-").replace(/-+$/, "")}`;
    for (const item of data.items) {
      if (!isRecord(item) || item.kind === "approvals" || item.status === "skipped") continue;
      const name = typeof item.name === "string" ? item.name : "";
      const label = `${source}: item ${JSON.stringify(name)}`;
      const id = bundleTargetId(name);
      const outcome = itemOutcome(item);
      if (id === null || outcome === null) {
        warn.push(`${label}: ${id === null ? "its name is not a bundle target id" : `outcome ${JSON.stringify(item.outcome)} is not one the bundle knows`} — left out`);
        continue;
      }
      const kind = typeof item.kind === "string" ? TARGET_KIND[item.kind] : undefined;
      const runId = typeof item.runId === "string" && RUN_ID_RE.test(item.runId) ? item.runId : checkRunId;
      const journeyId = item.kind === "journey" && CATALOG_ID_RE.test(name) ? name : undefined;
      const journeyHash = typeof item.journeyHash === "string" && SHA256_RE.test(item.journeyHash) ? item.journeyHash : undefined;
      const durationMs = intMs(item.durationMs);
      let baseline: BundleBaseline | undefined;
      if (item.baseline !== undefined) {
        const cj = journeyId === undefined ? undefined : byId.get(journeyId);
        let why: string | undefined;
        if (outcome.outcome !== "clean") why = `the run was ${outcome.outcome}, and a baseline comes only from a clean run`;
        else if (journeyId === undefined || journeyHash === undefined) why = "the item names no Journey review hash";
        else if (cj === undefined) why = `Journey ${journeyId} is not in the bundle`;
        else if (cj.approval?.contentHash !== journeyHash || cj.contentHash !== journeyHash) why = `it was measured on a Journey revision (${journeyHash.slice(0, 12)}…) that is not ${journeyId}'s approved one`;
        else {
          const b = bundleBaseline(item.baseline, cj.journey);
          if ("drop" in b) why = b.drop;
          else baseline = b.baseline;
        }
        if (why !== undefined) warn.push(`${label}: baseline left out — ${why}`);
      }
      const check: BundleCheck = {
        target: { id, ...(kind === undefined ? {} : { kind }) },
        commit,
        at,
        runId,
        ...(journeyId === undefined ? {} : { journey: journeyId }),
        ...(journeyHash === undefined ? {} : { journeyHash }),
        outcome: outcome.outcome,
        exitCode: MISSION_EXIT_CODES[outcome.outcome],
        ...(outcome.journeyOutcome === undefined ? {} : { journeyOutcome: outcome.journeyOutcome }),
        ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
        ...(durationMs === null ? {} : { durationMs }),
        ...(baseline === undefined ? {} : { baseline }),
      };
      out.set(`${id}\u0000${commit}\u0000${runId}`, check);
    }
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at) || a.target.id.localeCompare(b.target.id) || (a.runId ?? "").localeCompare(b.runId ?? ""));
}

// ── Findings (the d464c hook's guard) ────────────────────────────────────────────────────────

/** Why a finding handed in by the d464c source breaks the contract's privacy rules (§7), or []. */
export function findingIssues(f: CatalogBundleFinding): string[] {
  const out: string[] = [];
  const where = `finding ${f.fingerprint}`;
  if (!FINGERPRINT_RE.test(f.fingerprint)) out.push(`${where}: fingerprint is not 16 hex characters`);
  if (f.route !== undefined && !isRouteTemplate(f.route)) out.push(`${where}: route ${JSON.stringify(f.route)} is not a route template (no query, fragment, host or record id)`);
  if (f.tflowId !== undefined && !TFLOW_ID_RE.test(f.tflowId)) out.push(`${where}: tflowId is not a tflow id`);
  const text = (k: string, v: string | undefined, max: number): void => {
    if (v === undefined) return;
    const p = machineTextProblem(v, max);
    if (p !== null) out.push(`${where}: ${k} ${p}`);
  };
  text("observation", f.observation, 600);
  text("userImpact", f.userImpact, 600);
  text("recommendation", f.recommendation, 600);
  (f.controls ?? []).forEach((c, i) => text(`controls[${i}]`, c, 120));
  return out;
}

// ── The bundle ───────────────────────────────────────────────────────────────────────────────

/** Builds the bundle (pure). Throws `CatalogBundleInputError` when the catalog cannot be exported. */
export function buildCatalogBundle(input: CatalogBundleInput): CatalogBundleBuild {
  const refuse: string[] = [];
  const warn: string[] = [];
  if (!SEMVER_RE.test(input.producer.version)) refuse.push(`producer version ${JSON.stringify(input.producer.version)} is not semver`);
  const nameProblem = catalogTextProblem(input.productName);
  if (nameProblem !== null || input.productName.length > 200) refuse.push(`product name ${JSON.stringify(input.productName)} ${nameProblem ?? "is longer than 200 characters"}`);
  const personas = bundlePersonas(input, refuse, warn);
  const jobs = bundleJobs(input, refuse, warn);
  const journeys = bundleJourneys(input.catalog, refuse, warn);
  const findings = input.findings ?? [];
  for (const f of findings) refuse.push(...findingIssues(f));
  for (const [what, n] of [["personas", personas.length], ["jobs", jobs.length], ["journeys", journeys.length], ["findings", findings.length]] as const) {
    if (n > LIMITS[what]) refuse.push(`${n} ${what}: the bundle carries at most ${LIMITS[what]}`);
  }
  if (refuse.length > 0) throw new CatalogBundleInputError(refuse);
  let checks = bundleChecks(input, journeys, warn);
  if (checks.length > LIMITS.checks) {
    warn.push(`${checks.length} check results: only the latest ${LIMITS.checks} are exported`);
    checks = checks.slice(-LIMITS.checks);
  }
  const commit = input.producer.commit !== undefined && COMMIT_RE.test(input.producer.commit) ? input.producer.commit : undefined;
  return {
    bundle: {
      kind: BUNDLE_KIND,
      version: BUNDLE_VERSION,
      minor: BUNDLE_MINOR,
      producer: { tool: "jevitate", version: input.producer.version, ...(commit === undefined ? {} : { commit }) },
      product: { name: input.productName },
      catalog: { personas, jobs, journeys: journeys.map((j) => j.entry) },
      checks,
      findings: [...findings],
    },
    warnings: warn,
  };
}
