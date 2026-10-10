import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CatalogInputError, CatalogLoader, PERSONAS_FILE } from "./catalog.js";
import { buildCatalogBundle, BUNDLE_KIND, looksPersonal, subtitlesTextProblem, type CatalogBundleDemoInput, type CatalogBundleFinding, type CheckRecordInput } from "./catalog-bundle.js";
import { currentDigest, readApprovedDemo } from "./approved-demo.js";
import { collectBundleFindings } from "./catalog-bundle-findings.js";
import { execGitReadOnly, type GitExec } from "./change-context.js";
import { readCliVersion } from "./version.js";

/**
 * #464 — `jevitate catalog export --format journeeze-bundle --out <dir>` / MCP
 * `export_catalog_bundle`: write the project's catalog (personas, jobs, promoted Journeys with their
 * approvals and links, check results with machine baselines) as a Journeeze catalog bundle v1.0
 * (journeeze-saas `docs/contract/catalog-bundle-v1.md` @ 61f8c92). The bundle itself is built by the
 * pure `buildCatalogBundle` (catalog-bundle.ts — what goes out and what never does is documented
 * there); this module does the I/O around it.
 *
 * It writes `bundle.json` under `outDir` (atomically: a temp file renamed into place; over MCP
 * `outDir` is a confined path inside the project) and, #471, the approved demos' media under
 * `outDir/media/<journey id>/` (contract §2), refuses an `outDir` holding anything but a previous
 * bundle, never uploads (that is `publish journeeze`) and never approves anything.
 *
 * #471 media: a Journey's approved-demo record (approved-demo.ts, `<journeys>/.demos/<id>/`) is
 * read only for a promoted Journey; every file it lists is re-verified here — present, the sha256
 * and size recorded when it was proven masked, and the right kind of file (PNG / WebM signature,
 * WebVTT whose every cue is §7 machine text) — or it is left out with a warning. The pure builder
 * then applies the contract's text rules and limits.
 *
 * Inputs it reads: `<catalogDir>/personas.json` + `jobs.json`, the Journeys dir, and the
 * `jevitate check` records — `req.checkFiles`, else `<project>/jevitate-check/check.json` (the
 * `check --out` default) when it exists. The product repo's HEAD (`git rev-parse HEAD`) is
 * `producer.commit`; a check's commit is its `--target-build`.
 */

export const CATALOG_EXPORT_FORMATS = ["journeeze-bundle"] as const;
export type CatalogExportFormat = (typeof CATALOG_EXPORT_FORMATS)[number];

export interface ExportCatalogBundleRequest {
  readonly format: CatalogExportFormat;
  /** The project data dir (`--dir`, else the repo's `.jevitate/`); null outside a project. */
  readonly catalogDir: string | null;
  readonly journeysDir: string;
  /** Where `bundle.json` is written (created if missing). */
  readonly outDir: string;
  /** `jevitate check` records (`check.json`) to export; default `<project>/jevitate-check/check.json` when it exists. */
  readonly checkFiles?: readonly string[];
  /** `product.name` (e.g. the connected Journeeze product's); default the project's package.json name, else its folder name. */
  readonly productName?: string;
}

/** Seams (tests; d464c's findings source). */
export interface ExportCatalogBundleDeps {
  readonly git?: GitExec;
  readonly version?: () => string;
  /** d464c: the machine findings to export (default: the project's runs, UX reports and ledger — `collectBundleFindings`). */
  readonly findings?: () => Promise<readonly CatalogBundleFinding[]>;
}

export interface ExportCatalogBundleResult {
  readonly format: CatalogExportFormat;
  /** The written bundle file (`<outDir>/bundle.json`). */
  readonly bundlePath: string;
  /** `sha256-<hex of bundle.json>` — the upload's Idempotency-Key (upload contract §4). */
  readonly digest: string;
  readonly counts: {
    readonly personas: number;
    readonly jobs: number;
    readonly journeys: number;
    readonly checks: number;
    readonly findings: number;
    /** #471: approved demos exported (with their verified media). */
    readonly demos: number;
    /** #471: media files written beside bundle.json (listed in `files[]`). */
    readonly media: number;
  };
  /** Items left out or degraded, each with why (e.g. an unpromoted Journey, a check without a commit). */
  readonly warnings: readonly string[];
}

/** `--out` would overwrite something that is not a bundle (or is not a directory) — exit 64. */
export class CatalogExportOutError extends CatalogInputError {
  override readonly code: string = "E_CATALOG_EXPORT_ARGS";
}

/** The contract's `bundle.json` cap (§10). */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const BUNDLE_FILE = "bundle.json";
/** #471: the bundle's media folder (contract §2). */
export const MEDIA_DIR = "media";
export const DEFAULT_CHECK_FILE = join("jevitate-check", "check.json");

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readJson(path: string, what: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CatalogInputError(`${what} ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Each persona's raw keys (all but `name`/`id`), in both personas.json forms — the persona hash input. */
async function rawPersonaFields(catalogDir: string | null): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (catalogDir === null) return out;
  const path = join(catalogDir, PERSONAS_FILE);
  if (!existsSync(path)) return out;
  const raw = await readJson(path, "personas file");
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.personas) ? raw.personas : null;
  if (list !== null) {
    for (const e of list) {
      if (!isRecord(e)) continue;
      const { name, id, ...fields } = e;
      const key = name ?? id;
      if (typeof key === "string") out.set(key, fields);
    }
  } else if (isRecord(raw)) {
    for (const [id, v] of Object.entries(raw)) out.set(id, typeof v === "string" ? { storageState: v } : isRecord(v) ? { ...v } : {});
  }
  return out;
}

async function gitOut(git: GitExec, cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(args, { cwd, env: process.env })).stdout.trim();
  } catch {
    return null;
  }
}

/** `product.name`: the request's, else the project's package.json name, else its folder name — whichever is one plain line. */
export function isPlainProductName(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "" && s.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(s) && !looksPersonal(s);
}

async function productNameOf(req: ExportCatalogBundleRequest, root: string): Promise<string> {
  const ok = isPlainProductName;
  if (req.productName !== undefined) {
    if (!ok(req.productName)) throw new CatalogExportOutError("productName must be one plain line of 1-200 characters (no control characters or personal data)");
    return req.productName;
  }
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const name = (JSON.parse(await readFile(pkg, "utf8")) as { name?: unknown }).name;
      if (ok(name)) return name;
    } catch {
      // not a readable package.json: fall back to the folder name
    }
  }
  const folder = basename(root);
  return ok(folder) ? folder : "jevitate-project";
}

/** Refuses an `outDir` that is not a directory, or that holds anything but a previous `bundle.json`. */
async function assertBundleDir(outDir: string): Promise<void> {
  let st;
  try {
    st = await lstat(outDir);
  } catch {
    return; // missing: created
  }
  if (!st.isDirectory()) throw new CatalogExportOutError(`--out ${outDir} exists and is not a directory`);
  const entries = await readdir(outDir);
  // A previous bundle's media folder is replaced with the bundle (never without its bundle.json).
  const other = entries.filter((e) => e !== BUNDLE_FILE && !(e === MEDIA_DIR && entries.includes(BUNDLE_FILE)));
  if (other.length > 0) {
    throw new CatalogExportOutError(`--out ${outDir} holds other content (${other.slice(0, 5).join(", ")}${other.length > 5 ? ", …" : ""}) — export into an empty directory or a previous bundle's`);
  }
  if (entries.includes(BUNDLE_FILE)) {
    const file = join(outDir, BUNDLE_FILE);
    const fst = await lstat(file);
    let kind: unknown;
    try {
      kind = fst.isFile() ? (JSON.parse(await readFile(file, "utf8")) as { kind?: unknown }).kind : undefined;
    } catch {
      kind = undefined;
    }
    if (kind !== BUNDLE_KIND) throw new CatalogExportOutError(`--out ${outDir}: ${BUNDLE_FILE} there is not a Journeeze catalog bundle — not overwritten`);
  }
  if (entries.includes(MEDIA_DIR) && !(await lstat(join(outDir, MEDIA_DIR))).isDirectory()) throw new CatalogExportOutError(`--out ${outDir}: ${MEDIA_DIR} there is not a directory — not overwritten`);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

async function head(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * #471: the approved demos of the catalog's promoted Journeys, with each media file re-verified on
 * disk (else left out with a warning). A Journey without a record has no exportable demo (a draft,
 * or one approved on an environment that does not declare synthetic data): nothing is said.
 */
async function approvedDemos(journeysDir: string, ids: readonly string[], warnings: string[]): Promise<CatalogBundleDemoInput[]> {
  const out: CatalogBundleDemoInput[] = [];
  for (const id of ids) {
    let found: Awaited<ReturnType<typeof readApprovedDemo>>;
    try {
      found = await readApprovedDemo(journeysDir, id);
    } catch (err) {
      warnings.push(`demo ${id}: its approved-demo record is unreadable (${err instanceof Error ? err.message : String(err)}) — the demo is left out`);
      continue;
    }
    if (found === null) continue;
    const { record, dir } = found;
    const media: Record<string, { source: string; sha256: string; bytes: number }> = {};
    for (const [name, want] of Object.entries(record.files)) {
      const source = join(dir, name);
      const got = await currentDigest(source);
      if (got === null) {
        warnings.push(`demo ${id}: ${name} is missing — left out`);
        continue;
      }
      if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) {
        warnings.push(`demo ${id}: ${name} changed since it was proven masked — left out`);
        continue;
      }
      let kindProblem: string | null = null;
      if (name.endsWith(".png")) kindProblem = (await head(source, 8)).equals(PNG_MAGIC) ? null : "is not a PNG";
      else if (name.endsWith(".webm")) kindProblem = (await head(source, 4)).equals(WEBM_MAGIC) ? null : "is not a WebM";
      else if (name.endsWith(".vtt")) {
        const p = subtitlesTextProblem(await readFile(source, "utf8"));
        kindProblem = p === null ? null : `breaks the text rules (${p})`;
      } else kindProblem = "is not a demo media file";
      if (kindProblem !== null) {
        warnings.push(`demo ${id}: ${name} ${kindProblem} — left out`);
        continue;
      }
      media[name] = { source, ...got };
    }
    out.push({
      journey: record.journey,
      renderedFrom: record.renderedFrom,
      ...(record.title === undefined ? {} : { title: record.title }),
      steps: record.steps,
      ...(record.video === undefined ? {} : { video: record.video }),
      ...(record.subtitles === undefined ? {} : { subtitles: record.subtitles }),
      privacy: record.privacy,
      media,
    });
  }
  return out;
}

export async function exportCatalogBundle(req: ExportCatalogBundleRequest, deps: ExportCatalogBundleDeps = {}): Promise<ExportCatalogBundleResult> {
  const git = deps.git ?? execGitReadOnly;
  const outDir = resolve(req.outDir);
  await assertBundleDir(outDir);

  const root = req.catalogDir === null ? process.cwd() : dirname(resolve(req.catalogDir));
  const catalog = await new CatalogLoader({ catalogDir: req.catalogDir, journeysDir: req.journeysDir }).load();
  const personaFields = await rawPersonaFields(req.catalogDir);

  const checkFiles = req.checkFiles ?? [join(root, DEFAULT_CHECK_FILE)].filter((p) => existsSync(p));
  const checks: CheckRecordInput[] = [];
  for (const f of checkFiles) checks.push({ source: f, record: await readJson(f, "check record") });

  const warnings: string[] = [];
  const head = await gitOut(git, root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head === null || head === "") warnings.push(`${root} is not a git checkout with a commit — the bundle names no producer commit`);
  else {
    for (const dir of [req.catalogDir, req.journeysDir]) {
      if (dir === null || !existsSync(dir)) continue;
      const dirty = await gitOut(git, root, ["status", "--porcelain", "--", resolve(dir)]);
      if (dirty !== null && dirty !== "") warnings.push(`${dir} has uncommitted changes — the bundle is the working tree, but its producer commit is HEAD (${head.slice(0, 12)})`);
    }
  }

  const found = deps.findings === undefined ? await collectBundleFindings({ root, dataDir: req.catalogDir }) : { findings: await deps.findings(), warnings: [] };
  const demoWarnings: string[] = [];
  const demos = await approvedDemos(req.journeysDir, catalog.journeys.filter((j) => j.promoted).map((j) => j.id), demoWarnings);
  const { bundle, media, warnings: buildWarnings } = buildCatalogBundle({
    producer: { version: (deps.version ?? readCliVersion)(), ...(head === null || head === "" ? {} : { commit: head }) },
    productName: await productNameOf(req, root),
    catalog,
    personaFields,
    checks,
    findings: found.findings,
    demos,
  });

  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BUNDLE_BYTES) throw new CatalogInputError(`the bundle is ${bytes} bytes; the contract's limit is ${MAX_BUNDLE_BYTES} (16 MiB)`);
  await mkdir(outDir, { recursive: true });
  // #471: the media first (a fresh folder), then bundle.json — a bundle never names a file it lacks.
  const mediaDir = join(outDir, MEDIA_DIR);
  await rm(mediaDir, { recursive: true, force: true });
  for (const m of media) {
    const to = join(outDir, ...m.path.split("/"));
    if (!resolve(to).startsWith(`${mediaDir}${sep}`)) throw new CatalogInputError(`media path ${m.path} leaves the bundle's media folder`);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(m.source, to);
  }
  const bundlePath = join(outDir, BUNDLE_FILE);
  const tmp = join(outDir, `.${BUNDLE_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: "utf8", flag: "wx" });
    await rename(tmp, bundlePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  return {
    format: req.format,
    bundlePath,
    digest: `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`,
    counts: {
      personas: bundle.catalog.personas.length,
      jobs: bundle.catalog.jobs.length,
      journeys: bundle.catalog.journeys.length,
      checks: bundle.checks.length,
      findings: bundle.findings.length,
      demos: bundle.demos?.length ?? 0,
      media: bundle.files?.length ?? 0,
    },
    warnings: [...warnings, ...found.warnings, ...demoWarnings, ...buildWarnings],
  };
}

/** The human rendering (no `--json`). */
export function renderCatalogExport(r: ExportCatalogBundleResult): string {
  const c = r.counts;
  return `wrote ${r.bundlePath} (${r.digest}): ${c.personas} persona(s), ${c.jobs} job(s), ${c.journeys} Journey(s), ${c.demos} demo(s) with ${c.media} media file(s), ${c.checks} check(s), ${c.findings} finding(s)\n${r.warnings.map((w) => `warning: ${w}\n`).join("")}`;
}
