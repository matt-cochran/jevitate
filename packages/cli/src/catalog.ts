import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash } from "@jevitate/domain";
import {
  CATALOG_ID_RE,
  CatalogApprovalSchema,
  FsJourneyStore,
  JobSchema,
  renderJobStory,
  type CatalogApproval,
  type CatalogItemStatus,
  type CatalogRefIssue,
  type Job,
  type Journey,
  type JourneyApproval,
  type JourneyCatalogLinks,
} from "@jevitate/journey";
import { journeyReviewHash } from "./journey-review.js";

/**
 * #433 — the catalog: personas, jobs and Journeys, with their ids, content hashes and approval
 * state, loaded in one place (`CatalogLoader`) for every approval path, every review sheet and
 * `catalog status` — and for the readiness (#434) and catalog-analysis (#435) analyzers.
 *
 * Files (in the project's `.jevitate/`):
 *  - `personas.json` — the #427 personas file, extended: an entry may carry `description`, `role`
 *    and its `approval`, beside its session settings (`storageState`, `login`). A catalog-only
 *    persona (no session yet) is allowed. The persona's id is its #427 `name` (`id` is accepted too).
 *  - `jobs.json` — job stories (`JobSchema`); `.jevitate/campaign/jobs.json` (the test-campaign
 *    skill's old place) is read when `jobs.json` does not exist.
 *
 * Content hashes leave the approval out, so approving does not change what was approved. A
 * persona's hash covers what the persona IS (id, description, role, any other descriptive key),
 * not its session settings: re-minting a session or moving a storage state is not a new persona.
 * A missing file is an empty catalog — a project without personas/jobs works exactly as before;
 * a file that exists but cannot be read as the catalog is refused (`CatalogInputError`), never skipped.
 */

export const PERSONAS_FILE = "personas.json";
export const JOBS_FILE = "jobs.json";
/** The test-campaign skill's jobs file before #433 — still read for compatibility. */
export const LEGACY_JOBS_FILE = join("campaign", "jobs.json");

/** A catalog file that exists but is not a valid catalog — refused (exit 64), never skipped. */
export class CatalogInputError extends Error {
  readonly code: string = "E_CATALOG_INPUT";
}

/**
 * #465: `job approve` of a job with a structural reference problem (catalog-refs.ts `assertJobRefs`) —
 * refused, exit 64 (fix the jobs file). A `CatalogInputError`, so every catalog command reports it.
 */
export class BrokenJobRefsError extends CatalogInputError {
  override readonly code: string = "E_JOB_BROKEN_REF";
  constructor(
    message: string,
    readonly issues: readonly CatalogRefIssue[],
  ) {
    super(message);
  }
}

/** `persona|job review|approve <id>`: no such item in the catalog. */
export class UnknownCatalogItemError extends Error {
  constructor(
    readonly kind: "persona" | "job",
    message: string,
  ) {
    super(message);
  }
  get code(): string {
    return this.kind === "persona" ? "E_UNKNOWN_PERSONA" : "E_UNKNOWN_JOB";
  }
}

export interface CatalogPersona {
  readonly id: string;
  readonly description?: string;
  readonly role?: string;
  readonly hasStorageState: boolean;
  readonly hasLogin: boolean;
  readonly approval?: CatalogApproval;
  readonly contentHash: string;
  readonly status: CatalogItemStatus;
}

export interface CatalogJob {
  readonly id: string;
  readonly job: Job;
  /** The job story in the template's words. */
  readonly story: string;
  /** The personas it serves (`personas`, plus a legacy single `persona`). */
  readonly personas: readonly string[];
  readonly approval?: CatalogApproval;
  readonly contentHash: string;
  readonly status: CatalogItemStatus;
}

export interface CatalogJourney {
  readonly id: string;
  readonly name: string;
  readonly promoted: boolean;
  readonly journey: Journey;
  /** `metadata.job`, as written. */
  readonly job?: string;
  /** `metadata.persona`, as written (a catalog persona id, or free text). */
  readonly personaText?: string;
  readonly approval?: JourneyApproval;
  /** `journeyReviewHash`. */
  readonly contentHash: string;
  /** Promoted with a recorded approval whose hash is no longer the Journey's. */
  readonly changedSinceApproval: boolean;
}

export interface Catalog {
  /** The project data dir the catalog files live in, or null outside a project (an empty catalog). */
  readonly dir: string | null;
  readonly personasFile: string | null;
  readonly jobsFile: string | null;
  readonly personas: readonly CatalogPersona[];
  readonly jobs: readonly CatalogJob[];
  readonly journeys: readonly CatalogJourney[];
  /** #434/#435: the journeys directory the Journeys were loaded from (their `.verify/` records live beside them). */
  readonly journeysDir?: string;
}

function statusOf(approval: CatalogApproval | undefined, hash: string): CatalogItemStatus {
  if (approval === undefined) return "draft";
  return approval.contentHash === hash ? "approved" : "stale";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CatalogInputError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ── personas.json ─────────────────────────────────────────────────────────────────────────────

/** The session settings (#427): operational, not part of what a persona is (left out of its hash). */
const SESSION_KEYS = new Set(["storageState", "login"]);

/** Where an entry lives in the raw file, so an approval is written back to that same entry. */
type PersonaSlot = { readonly form: "list"; readonly index: number } | { readonly form: "map"; readonly key: string };

interface RawPersona {
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly slot: PersonaSlot;
}

function personaList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.personas)) return raw.personas;
  return null;
}

function rawPersonas(raw: unknown, path: string): RawPersona[] {
  const list = personaList(raw);
  if (list !== null) {
    return list.map((entry, index) => {
      if (!isRecord(entry)) throw new CatalogInputError(`${path}: entry ${index} must be an object {"name": string, …}`);
      const name = entry.name ?? entry.id;
      if (typeof name !== "string") throw new CatalogInputError(`${path}: entry ${index} needs a "name" (its persona id)`);
      if (entry.name !== undefined && entry.id !== undefined && entry.name !== entry.id) {
        throw new CatalogInputError(`${path}: entry ${index} has both "name" ${JSON.stringify(entry.name)} and "id" ${JSON.stringify(entry.id)} — one persona id`);
      }
      const { name: _n, id: _i, ...fields } = entry;
      return { id: name, fields, slot: { form: "list", index } };
    });
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([id, value]) => {
      if (typeof value === "string") return { id, fields: { storageState: value }, slot: { form: "map", key: id } };
      if (!isRecord(value)) throw new CatalogInputError(`${path}: ${id} must map to a storage state path or an object`);
      return { id, fields: { ...value }, slot: { form: "map", key: id } };
    });
  }
  throw new CatalogInputError(`${path} must be an object or an array of personas`);
}

function catalogPersona(p: RawPersona, path: string): CatalogPersona {
  if (!CATALOG_ID_RE.test(p.id)) throw new CatalogInputError(`${path}: persona id ${JSON.stringify(p.id)} must be 1-64 of [A-Za-z0-9._-], starting alphanumeric`);
  const { description, role, approval: rawApproval } = p.fields;
  if (description !== undefined && (typeof description !== "string" || description.length > 2000)) {
    throw new CatalogInputError(`${path}: persona ${p.id}: description must be text (at most 2000 characters)`);
  }
  if (role !== undefined && (typeof role !== "string" || role.length > 200)) throw new CatalogInputError(`${path}: persona ${p.id}: role must be text (at most 200 characters)`);
  let approval: CatalogApproval | undefined;
  if (rawApproval !== undefined) {
    const parsed = CatalogApprovalSchema.safeParse(rawApproval);
    if (!parsed.success) throw new CatalogInputError(`${path}: persona ${p.id}: approval is not a valid approval record (${parsed.error.issues.map((i) => i.message).join("; ")})`);
    approval = parsed.data;
  }
  const hash = personaContentHash(p.id, p.fields);
  return {
    id: p.id,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof role === "string" ? { role } : {}),
    hasStorageState: typeof p.fields.storageState === "string",
    hasLogin: p.fields.login !== undefined,
    ...(approval === undefined ? {} : { approval }),
    contentHash: hash,
    status: statusOf(approval, hash),
  };
}

/** #433: a persona's content hash — its id and descriptive keys, without its approval or session settings. */
export function personaContentHash(id: string, fields: Readonly<Record<string, unknown>>): string {
  const described: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(fields)) if (k !== "approval" && !SESSION_KEYS.has(k)) described[k] = v;
  return contentHash(described);
}

// ── jobs.json ─────────────────────────────────────────────────────────────────────────────────

function jobList(raw: unknown, path: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.jobs)) return raw.jobs;
  throw new CatalogInputError(`${path} must be an array of jobs (or {"jobs": [...]})`);
}

function catalogJob(entry: unknown, index: number, path: string): CatalogJob {
  const where = isRecord(entry) && typeof entry.id === "string" ? `job ${JSON.stringify(entry.id)}` : `entry ${index}`;
  const parsed = JobSchema.safeParse(entry);
  if (!parsed.success) {
    throw new CatalogInputError(`${path}: ${where}: ${parsed.error.issues.map((i) => (i.path.length === 0 ? i.message : `${i.path.join(".")}: ${i.message}`)).join("; ")}`);
  }
  return catalogJobOf(parsed.data);
}

/**
 * #433/#465: a parsed job as the catalog holds it. Reference problems (catalog-refs.ts) never
 * refuse a load: they are reported by `catalog status`/`analyze` and the review sheet, and an
 * approval refuses only the structural ones of the job being approved.
 */
export function catalogJobOf(job: Job): CatalogJob {
  const hash = jobContentHash(job);
  return {
    id: job.id,
    job,
    story: renderJobStory(job),
    personas: [...new Set([...(job.personas ?? []), ...(job.persona === undefined ? [] : [job.persona])])],
    ...(job.approval === undefined ? {} : { approval: job.approval }),
    contentHash: hash,
    status: statusOf(job.approval, hash),
  };
}

/**
 * #433: a job's content hash — the job without its approval. #465: every jtbd field counts
 * (`extensions` included), so editing a step, an outcome, a target or an extension needs re-approval.
 */
export function jobContentHash(job: Job): string {
  const { approval: _a, ...rest } = job;
  return contentHash(rest);
}

// ── Journeys ──────────────────────────────────────────────────────────────────────────────────

export function catalogJourney(journey: Journey): CatalogJourney {
  const m = journey.metadata;
  const hash = journeyReviewHash(journey);
  return {
    id: m.id,
    name: m.name,
    promoted: m.promoted,
    journey,
    ...(m.job === undefined ? {} : { job: m.job }),
    ...(m.persona === undefined ? {} : { personaText: m.persona }),
    ...(m.approval === undefined ? {} : { approval: m.approval }),
    contentHash: hash,
    changedSinceApproval: m.promoted && m.approval !== undefined && m.approval.contentHash !== hash,
  };
}

// ── The loader ────────────────────────────────────────────────────────────────────────────────

export interface CatalogLoaderOptions {
  /** The project data dir (`<repo>/.jevitate`) holding personas.json and jobs.json; null: no catalog files. */
  readonly catalogDir: string | null;
  /** The journeys directory. */
  readonly journeysDir: string;
}

/**
 * #433: loads personas + jobs + Journeys with their ids, content hashes and approval state. Shared
 * by every approval path (`persona|job approve`, `journey promote`, `demo approve`), the review
 * sheets and `catalog status` — and exported for the #434 / #435 analyzers.
 */
export class CatalogLoader {
  constructor(private readonly opts: CatalogLoaderOptions) {}

  /** The personas file path (whether or not it exists), or null without a catalog dir. */
  personasPath(): string | null {
    return this.opts.catalogDir === null ? null : join(this.opts.catalogDir, PERSONAS_FILE);
  }

  /** The jobs file in use: `jobs.json`, else the legacy `campaign/jobs.json`; null when neither exists. */
  jobsPath(): string | null {
    if (this.opts.catalogDir === null) return null;
    const main = join(this.opts.catalogDir, JOBS_FILE);
    const legacy = join(this.opts.catalogDir, LEGACY_JOBS_FILE);
    if (existsSync(main) && existsSync(legacy)) {
      throw new CatalogInputError(`both ${main} and ${legacy} exist — merge the jobs into ${main} and remove ${legacy} (one jobs file, so nothing diverges silently)`);
    }
    if (existsSync(main)) return main;
    return existsSync(legacy) ? legacy : null;
  }

  async loadPersonas(): Promise<{ file: string | null; personas: CatalogPersona[] }> {
    const path = this.personasPath();
    if (path === null || !existsSync(path)) return { file: null, personas: [] };
    const personas = rawPersonas(await readJsonFile(path), path).map((p) => catalogPersona(p, path));
    const seen = new Set<string>();
    for (const p of personas) {
      if (seen.has(p.id)) throw new CatalogInputError(`${path}: persona ${p.id} is declared twice`);
      seen.add(p.id);
    }
    return { file: path, personas };
  }

  async loadJobs(): Promise<{ file: string | null; jobs: CatalogJob[] }> {
    const path = this.jobsPath();
    if (path === null) return { file: null, jobs: [] };
    const jobs = jobList(await readJsonFile(path), path).map((e, i) => catalogJob(e, i, path));
    const seen = new Set<string>();
    for (const j of jobs) {
      if (seen.has(j.id)) throw new CatalogInputError(`${path}: job ${j.id} is declared twice`);
      seen.add(j.id);
    }
    return { file: path, jobs };
  }

  async loadJourneys(): Promise<CatalogJourney[]> {
    const store = new FsJourneyStore(this.opts.journeysDir);
    const out: CatalogJourney[] = [];
    for (const meta of await store.list()) {
      const journey = await store.get(meta.id);
      if (journey !== null) out.push(catalogJourney(journey));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async load(): Promise<Catalog> {
    const [{ file: personasFile, personas }, { file: jobsFile, jobs }, journeys] = await Promise.all([this.loadPersonas(), this.loadJobs(), this.loadJourneys()]);
    return { dir: this.opts.catalogDir, personasFile, jobsFile, personas, jobs, journeys, journeysDir: this.opts.journeysDir };
  }
}

export function findPersona(catalog: Catalog, id: string): CatalogPersona | undefined {
  return catalog.personas.find((p) => p.id === id);
}

export function findJob(catalog: Catalog, id: string): CatalogJob | undefined {
  return catalog.jobs.find((j) => j.id === id);
}

export function requirePersona(catalog: Catalog, id: string): CatalogPersona {
  const p = findPersona(catalog, id);
  if (p !== undefined) return p;
  const where = catalog.dir === null ? "no .jevitate/ project was found (run inside a project, or pass --dir)" : `${join(catalog.dir, PERSONAS_FILE)} declares ${catalog.personas.length === 0 ? "no personas" : `${catalog.personas.map((x) => x.id).join(", ")}`}`;
  throw new UnknownCatalogItemError("persona", `unknown persona '${id}' — ${where}`);
}

export function requireJob(catalog: Catalog, id: string): CatalogJob {
  const j = findJob(catalog, id);
  if (j !== undefined) return j;
  const where = catalog.dir === null ? "no .jevitate/ project was found (run inside a project, or pass --dir)" : catalog.jobsFile === null ? `there is no ${join(catalog.dir, JOBS_FILE)}` : `${catalog.jobsFile} declares ${catalog.jobs.map((x) => x.id).join(", ")}`;
  throw new UnknownCatalogItemError("job", `unknown job '${id}' — ${where}`);
}

/** The Journeys whose catalog persona link is this persona. */
export function journeysForPersona(catalog: Catalog, personaId: string): CatalogJourney[] {
  return catalog.journeys.filter((j) => personaLinkId(catalog, j) === personaId);
}

export function journeysForJob(catalog: Catalog, jobId: string): CatalogJourney[] {
  return catalog.journeys.filter((j) => j.job === jobId);
}

/**
 * The persona id a Journey links: `metadata.persona` when it names a catalog persona; when the
 * Journey links a job, its persona is ALWAYS read as an id (an unknown one is a dangling link).
 * Otherwise `metadata.persona` is free text and links nothing.
 */
export function personaLinkId(catalog: Catalog, j: CatalogJourney): string | undefined {
  const text = j.personaText?.trim();
  if (text === undefined || text === "") return undefined;
  if (findPersona(catalog, text) !== undefined) return text;
  return j.job !== undefined ? text : undefined;
}

type LinkStatus = CatalogItemStatus | "unknown";

/** #433: a Journey's links, their approval state, what is unvetted and why it needs re-review. */
export function journeyLinks(catalog: Catalog, j: CatalogJourney): JourneyCatalogLinks {
  const job = j.job === undefined ? undefined : findJob(catalog, j.job);
  const jobLink = j.job === undefined ? undefined : { id: j.job, status: (job?.status ?? "unknown") as LinkStatus, ...(job === undefined ? {} : { story: job.story }) };
  const personaId = personaLinkId(catalog, j);
  const personaLink = personaId === undefined ? undefined : { id: personaId, status: (findPersona(catalog, personaId)?.status ?? "unknown") as LinkStatus };
  const unvetted = [
    ...(jobLink !== undefined && jobLink.status !== "approved" ? [`job:${jobLink.id} (${jobLink.status})`] : []),
    ...(personaLink !== undefined && personaLink.status !== "approved" ? [`persona:${personaLink.id} (${personaLink.status})`] : []),
  ];
  const needsReReview: string[] = [];
  if (j.promoted) {
    if (j.changedSinceApproval) needsReReview.push("the Journey changed since its approval");
    if (jobLink?.status === "stale") needsReReview.push(`its job '${jobLink.id}' changed since that job's approval`);
    if (personaLink?.status === "stale") needsReReview.push(`its persona '${personaLink.id}' changed since that persona's approval`);
  }
  return {
    linked: jobLink !== undefined || personaLink !== undefined,
    ...(jobLink === undefined ? {} : { job: jobLink }),
    ...(personaLink === undefined ? {} : { persona: personaLink }),
    unvetted,
    needsReReview,
  };
}

// ── Writing an approval back ──────────────────────────────────────────────────────────────────

/** #433: records a persona's approval in personas.json, on the same entry (a bare path entry becomes `{storageState, approval}`). */
export async function writePersonaApproval(file: string, id: string, approval: CatalogApproval): Promise<void> {
  const raw = await readJsonFile(file);
  const entry = rawPersonas(raw, file).find((p) => p.id === id);
  if (entry === undefined) throw new UnknownCatalogItemError("persona", `unknown persona '${id}' in ${file}`);
  const record = CatalogApprovalSchema.parse(approval);
  let next: unknown;
  if (entry.slot.form === "list") {
    const list = [...(personaList(raw) ?? [])];
    list[entry.slot.index] = { ...(list[entry.slot.index] as Record<string, unknown>), approval: record };
    next = Array.isArray(raw) ? list : { ...(raw as Record<string, unknown>), personas: list };
  } else {
    const map = raw as Record<string, unknown>;
    const value = map[entry.slot.key];
    next = { ...map, [entry.slot.key]: typeof value === "string" ? { storageState: value, approval: record } : { ...(value as Record<string, unknown>), approval: record } };
  }
  await writeJsonFile(file, next);
}

/** #433: records a job's approval in its jobs file. */
export async function writeJobApproval(file: string, id: string, approval: CatalogApproval): Promise<void> {
  const raw = await readJsonFile(file);
  const list = [...jobList(raw, file)];
  const index = list.findIndex((e) => isRecord(e) && e.id === id);
  if (index === -1) throw new UnknownCatalogItemError("job", `unknown job '${id}' in ${file}`);
  list[index] = { ...(list[index] as Record<string, unknown>), approval: CatalogApprovalSchema.parse(approval) };
  // Re-validated before writing: an approval is never written into a job the schema refuses.
  catalogJob(list[index], index, file);
  await writeJsonFile(file, Array.isArray(raw) ? list : { ...(raw as Record<string, unknown>), jobs: list });
}

/**
 * #469: the content hash of persona/job `id` in one version of its catalog file (`text`, e.g. the
 * file at a commit, read through the forge) — the hash its approval binds to — or null when that
 * version does not hold the entry or is not a valid catalog file.
 */
export function catalogEntryHash(kind: "persona" | "job", text: string | null, id: string): string | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (kind === "persona") {
      const p = rawPersonas(raw, "(forge)").find((x) => x.id === id);
      return p === undefined ? null : personaContentHash(p.id, p.fields);
    }
    const entry = jobList(raw, "(forge)").find((e) => isRecord(e) && e.id === id);
    const parsed = JobSchema.safeParse(entry);
    return parsed.success ? jobContentHash(parsed.data) : null;
  } catch {
    return null; // not JSON / not a catalog file at that version: it does not hold the entry
  }
}
