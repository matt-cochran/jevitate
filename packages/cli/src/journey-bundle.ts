import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clock } from "@jevitate/domain";
import type { HandoffFields, HandoffInputsDecl, HandoffOutputsDecl, Journey, JourneyReview } from "@jevitate/journey";
import { loadCatalog } from "./catalog-api.js";
import type { Catalog } from "./catalog.js";
import { annotationDraftPath, journeyContentHash } from "./journey-annotate-api.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { runJourneyReadiness, type JourneyReadinessOptions, type ReadinessCheck, type ReadinessReceipt, type ReadinessVerdict } from "./journey-readiness.js";

/**
 * #584 — `jevitate journey bundle <id> [--with <toId>] --out <dir>` and
 * `jevitate journey bundle --check <dir>` (docs/contracts/readiness-and-bundle.md §4). The bundle is
 * local and never uploaded: it writes `<dir>/bundle.md` and `<dir>/manifest.json` from a `report`-mode
 * readiness (a browser never opens). `bundle.md` is what a reviewer reads — the verdict, blockers and
 * any inconclusive/stale proof first, then each Journey's intent, links, contracts, boundary, side
 * effects, hashes, step objectives and readiness checks — and the human-only commands to run next.
 * `manifest.json` records every hash it was built from; `--check` re-derives them and fails closed
 * (`E_BUNDLE_STALE`) when any moved. It only prints commands a person runs: it never approves,
 * promotes or uploads.
 */

/** #584: a local bundle build's request. `out` is created (recursively) if missing; nothing outside it is written. */
export interface JourneyBundleOptions {
  readonly id: string;
  readonly with?: string;
  readonly out: string;
  readonly journeysDir: string;
  readonly catalogDir?: string | null;
  readonly targetsFile?: string;
  /** The project root an upload fixture resolves against, as `journey run` (optional). */
  readonly projectDir?: string;
}

export interface JourneyBundleCheckOptions {
  readonly journeysDir: string;
  readonly catalogDir?: string | null;
  readonly targetsFile?: string;
}

/** #584: test seams. `readiness`/`review`/`loadCatalog` default to the real modules. */
export interface JourneyBundleDeps {
  readonly readiness?: typeof runJourneyReadiness;
  readonly review?: typeof reviewJourneyById;
  readonly loadCatalog?: typeof loadCatalog;
  /** Whether a Journey has a pending annotation draft (default: the sidecar file exists). */
  readonly annotationDraft?: (journeysDir: string, id: string) => boolean;
  readonly cwd?: () => string;
}

export interface JourneyBundleResult {
  readonly out: string;
  readonly files: readonly string[];
  readonly verdict: ReadinessVerdict;
}

export interface JourneyBundleCheckResult {
  readonly stale: false;
}

/** One hash the bundle was built from, so `--check` can re-derive it. */
export interface JourneyBundleManifest {
  readonly bundleVersion: 1;
  readonly journeys: ReadonlyArray<{ readonly id: string; readonly contentHash: string; readonly reviewHash: string }>;
  readonly catalog: ReadonlyArray<{ readonly kind: "persona" | "job"; readonly id: string; readonly hash: string }>;
  readonly verdict: ReadinessVerdict;
  readonly generatedAt: string;
}

/** #584: a stale manifest — `--check` re-derived a different hash (exit 1). */
export class BundleStaleError extends Error {
  readonly code = "E_BUNDLE_STALE";
  constructor(readonly changed: readonly string[]) {
    super(`the bundle is stale: ${changed.join("; ")}`);
    this.name = "BundleStaleError";
  }
}

interface JourneyEntry {
  readonly id: string;
  readonly journey: Journey;
  readonly review: JourneyReview;
}

/** The label every approval state carries (§4): technical readiness, draft, prior approval, stale approval, current authorization. */
function catalogApprovalLabel(status: "draft" | "approved" | "stale" | "unknown"): string {
  switch (status) {
    case "approved":
      return "current authorization";
    case "stale":
      return "stale approval";
    case "draft":
      return "draft";
    default:
      return "unknown";
  }
}

/** How a Journey's own promotion reads: not promoted is `draft`, an approval that no longer binds is `stale approval`. */
function journeyApprovalLabel(entry: JourneyEntry): string {
  const approval = entry.journey.metadata.approval;
  const change = entry.review.changeSinceApproval;
  const stale = (change.kind === "diff" || change.kind === "snapshot-missing") && change.changed;
  if (entry.journey.metadata.promoted && approval !== undefined && !stale) return "current authorization";
  if (stale) return "stale approval";
  if (approval !== undefined) return "prior approval";
  return "draft";
}

function handoffFieldLines(fields: HandoffFields, indent: string): string[] {
  return Object.entries(fields).map(([name, decl]) => `${indent}${name}: ${decl.type}${decl.required === false ? " (optional)" : ""}`);
}

/** §4: the #582 contracts, by field name and type only (never a value). */
function contractLines(entry: JourneyEntry): string[] {
  const outputs = entry.journey.metadata.outputs;
  const inputs = entry.journey.metadata.inputs;
  if (outputs === undefined && inputs === undefined) return ["contracts: none declared"];
  const lines = ["contracts:"];
  if (outputs !== undefined) lines.push(...outputsLines(outputs));
  if (inputs !== undefined) lines.push(...inputsLines(inputs));
  return lines;
}

function outputsLines(outputs: HandoffOutputsDecl): string[] {
  const lines = [`  outputs: ${outputs.contract}`];
  lines.push(...handoffFieldLines(outputs.fields, "    "));
  if (outputs.collection !== undefined) lines.push(`    collection: ${outputs.collection}`);
  return lines;
}

function inputsLines(inputs: HandoffInputsDecl): string[] {
  const lines = [`  inputs: accepts ${inputs.accepts}`, ...handoffFieldLines(inputs.request.fields, "    request ")];
  for (const [param, binding] of Object.entries(inputs.bindings)) {
    const source = "record" in binding ? `record.${binding.record}` : "request" in binding ? `request.${binding.request}` : "const" in binding ? `const.${binding.const}` : `secret.${binding.secret}`;
    lines.push(`    binding ${param} <- ${source}`);
  }
  return lines;
}

/** §4: a person runs these, in order (persona approve, job approve, annotations approve, journey promote). */
function humanCommands(entry: JourneyEntry, catalog: Catalog, draft: boolean, ready: boolean): string[] {
  const commands: string[] = [];
  const personaId = entry.review.catalog?.persona?.id;
  const jobId = entry.review.catalog?.job?.id;
  if (personaId !== undefined) {
    const hash = catalog.personas.find((p) => p.id === personaId)?.contentHash;
    commands.push(`jevitate persona approve ${personaId}${hash === undefined ? "" : ` --reviewed-hash ${hash}`}`);
  }
  if (jobId !== undefined) {
    const hash = catalog.jobs.find((j) => j.id === jobId)?.contentHash;
    commands.push(`jevitate job approve ${jobId}${hash === undefined ? "" : ` --reviewed-hash ${hash}`}`);
  }
  if (draft) commands.push(`jevitate journey annotate ${entry.id} --approve`);
  // §4: while any technical blocker remains, promote moves under "After the blockers are fixed" without a hash.
  if (ready) commands.push(`jevitate journey promote ${entry.id} --reviewed-hash ${entry.review.contentHash}`);
  return commands;
}

function journeySection(entry: JourneyEntry, receipt: ReadinessReceipt): string[] {
  const m = entry.journey.metadata;
  const lines: string[] = [`## Journey: ${entry.id}`, ""];
  lines.push(`goal: ${m.goal ?? "(none)"}`);
  const links = entry.review.catalog;
  if (links?.persona !== undefined) lines.push(`persona: ${links.persona.id} (${catalogApprovalLabel(links.persona.status)})`);
  if (links?.job !== undefined) lines.push(`job: ${links.job.id} (${catalogApprovalLabel(links.job.status)})`);
  lines.push(...contractLines(entry));
  const boundary = m.boundary;
  lines.push(boundary === undefined ? "boundary: none declared" : `boundary: ${boundary.kind}; stop before "${boundary.stopBefore.label}"; next step: ${boundary.nextStep}`);
  lines.push("side effects:");
  if (entry.review.sideEffects.writeRequests.length === 0) lines.push("  none");
  for (const w of entry.review.sideEffects.writeRequests) lines.push(`  ${w.method} ${w.endpoint} (${w.source}${w.step === undefined ? "" : `, step ${w.step}`})`);
  lines.push(`content hash: ${journeyContentHash(entry.journey)}`);
  lines.push(`review hash: ${entry.review.contentHash}`);
  lines.push(`approval: ${journeyApprovalLabel(entry)}`);
  lines.push("steps:");
  for (const step of entry.review.steps) lines.push(`  ${step.number}. ${step.action} — objective: ${step.objective ?? "(pending)"}`);
  if (entry.review.summary.missingIntent.length > 0) {
    lines.push("pending annotations:");
    for (const item of entry.review.summary.missingIntent) lines.push(`  - ${item}`);
  }
  lines.push("readiness:");
  for (const check of receipt.checks.filter((c) => c.journey === entry.id)) lines.push(checkLine(check));
  return lines;
}

function checkLine(check: ReadinessCheck): string {
  return `  ${check.check}: ${check.state} — ${check.detail}${check.evidence === undefined ? "" : ` (evidence: ${check.evidence})`}`;
}

/** §4: the bundle's Markdown. The verdict, blockers and any inconclusive/stale proof come first. */
export function renderJourneyBundle(receipt: ReadinessReceipt, entries: readonly JourneyEntry[], catalog: Catalog, drafts: ReadonlySet<string>): string {
  const lines: string[] = [`# Journey readiness bundle`, "", `verdict: ${receipt.verdict}`, ""];
  const blockers = receipt.blockers;
  if (blockers.length > 0) {
    lines.push("## Blockers", "");
    for (const b of blockers) lines.push(`- ${b.journey} ${b.check}: ${b.why} — next: ${b.next}`);
    lines.push("");
  }
  const flagged = receipt.checks.filter((c) => c.state === "inconclusive" || c.state === "stale");
  if (flagged.length > 0) {
    lines.push("## Inconclusive or stale evidence", "");
    for (const c of flagged) lines.push(`- ${c.journey} ${c.check}: ${c.state} — ${c.detail}`);
    lines.push("");
  }
  for (const entry of entries) {
    lines.push(...journeySection(entry, receipt), "");
  }
  const ready = receipt.verdict === "technically-ready";
  lines.push("## Human-only commands", "");
  for (const entry of entries) {
    for (const command of humanCommands(entry, catalog, drafts.has(entry.id), ready)) lines.push(`- ${command}`);
  }
  if (!ready) {
    lines.push("");
    lines.push("## After the blockers are fixed", "");
    for (const entry of entries) lines.push(`- jevitate journey promote ${entry.id}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function catalogEntries(entries: readonly JourneyEntry[], catalog: Catalog): JourneyBundleManifest["catalog"] {
  const wanted = new Map<string, { kind: "persona" | "job"; id: string; hash: string }>();
  const add = (kind: "persona" | "job", id: string | undefined, hash: string | undefined): void => {
    if (id === undefined || hash === undefined) return;
    wanted.set(`${kind}\u0000${id}`, { kind, id, hash });
  };
  for (const entry of entries) {
    const links = entry.review.catalog;
    add("persona", links?.persona?.id, catalog.personas.find((p) => p.id === links?.persona?.id)?.contentHash);
    add("job", links?.job?.id, catalog.jobs.find((j) => j.id === links?.job?.id)?.contentHash);
  }
  return [...wanted.values()].sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
}

function defaultAnnotationDraft(journeysDir: string, id: string): boolean {
  return existsSync(annotationDraftPath(journeysDir, id));
}

/** #584: build the local bundle from a `report`-mode readiness and the review sheet of each Journey. */
export async function buildJourneyBundle(opts: JourneyBundleOptions, deps: JourneyBundleDeps = {}): Promise<JourneyBundleResult> {
  const readiness = deps.readiness ?? runJourneyReadiness;
  const review = deps.review ?? reviewJourneyById;
  const catalogOf = deps.loadCatalog ?? loadCatalog;
  const draftExists = deps.annotationDraft ?? defaultAnnotationDraft;

  const readinessOpts: JourneyReadinessOptions = {
    id: opts.id,
    ...(opts.with === undefined ? {} : { with: opts.with }),
    mode: "report",
    journeysDir: opts.journeysDir,
    ...(opts.catalogDir === undefined ? {} : { catalogDir: opts.catalogDir }),
    ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }),
    ...(opts.projectDir === undefined ? {} : { projectDir: opts.projectDir }),
  };
  const receiptDeps = deps.cwd === undefined ? {} : { cwd: deps.cwd };
  const receipt = await readiness(readinessOpts, receiptDeps);

  const ids = [opts.id, ...(opts.with === undefined ? [] : [opts.with])];
  const reviewOpts = { strict: true, ...(opts.catalogDir === undefined ? {} : { catalogDir: opts.catalogDir }), ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }) } as const;
  const entries: JourneyEntry[] = [];
  for (const id of ids) {
    const loaded = await review(opts.journeysDir, id, reviewOpts);
    entries.push({ id, journey: loaded.journey, review: loaded.review });
  }
  const catalog = await catalogOf(opts.catalogDir === undefined ? null : opts.catalogDir, opts.journeysDir);
  const drafts = new Set(ids.filter((id) => draftExists(opts.journeysDir, id)));

  const out = resolve(opts.out);
  const bundlePath = join(out, "bundle.md");
  const manifestPath = join(out, "manifest.json");
  const manifest: JourneyBundleManifest = {
    bundleVersion: 1,
    journeys: entries.map((e) => ({ id: e.id, contentHash: journeyContentHash(e.journey), reviewHash: e.review.contentHash })),
    catalog: catalogEntries(entries, catalog),
    verdict: receipt.verdict,
    generatedAt: clock.nowIso(),
  };
  await mkdir(out, { recursive: true });
  await writeFile(bundlePath, renderJourneyBundle(receipt, entries, catalog, drafts), "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { out, files: [bundlePath, manifestPath], verdict: receipt.verdict };
}

/** #584: re-derive every hash the bundle recorded; a moved hash throws `BundleStaleError` (exit 1). */
export async function checkJourneyBundle(dir: string, opts: JourneyBundleCheckOptions, deps: JourneyBundleDeps = {}): Promise<JourneyBundleCheckResult> {
  const review = deps.review ?? reviewJourneyById;
  const catalogOf = deps.loadCatalog ?? loadCatalog;
  const manifestPath = join(resolve(dir), "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JourneyBundleManifest;
  const reviewOpts = { strict: true, ...(opts.catalogDir === undefined ? {} : { catalogDir: opts.catalogDir }), ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }) } as const;
  const changed: string[] = [];
  for (const recorded of manifest.journeys) {
    const loaded = await review(opts.journeysDir, recorded.id, reviewOpts);
    if (journeyContentHash(loaded.journey) !== recorded.contentHash) changed.push(`journey ${recorded.id} contentHash`);
    if (loaded.review.contentHash !== recorded.reviewHash) changed.push(`journey ${recorded.id} reviewHash`);
  }
  if (manifest.catalog.length > 0) {
    const catalog = await catalogOf(opts.catalogDir === undefined ? null : opts.catalogDir, opts.journeysDir);
    for (const recorded of manifest.catalog) {
      const current = recorded.kind === "persona" ? catalog.personas.find((p) => p.id === recorded.id)?.contentHash : catalog.jobs.find((j) => j.id === recorded.id)?.contentHash;
      if (current !== recorded.hash) changed.push(`${recorded.kind} ${recorded.id} hash`);
    }
  }
  if (changed.length > 0) throw new BundleStaleError(changed);
  return { stale: false };
}
