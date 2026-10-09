import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CatalogInputError, CatalogLoader, PERSONAS_FILE } from "./catalog.js";
import { buildCatalogBundle, BUNDLE_KIND, looksPersonal, type CatalogBundleFinding, type CheckRecordInput } from "./catalog-bundle.js";
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
 * It only writes `bundle.json` under `outDir` (atomically: a temp file renamed into place; over MCP
 * `outDir` is a confined path inside the project), refuses an `outDir` holding anything but a
 * previous bundle, never uploads (that is `publish journeeze`) and never approves anything.
 * 0.10 exports no media files (no demos: see catalog-bundle.ts).
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
    /** Always 0 in 0.10 (no media exported). */
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
  const other = entries.filter((e) => e !== BUNDLE_FILE);
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
  const { bundle, warnings: buildWarnings } = buildCatalogBundle({
    producer: { version: (deps.version ?? readCliVersion)(), ...(head === null || head === "" ? {} : { commit: head }) },
    productName: await productNameOf(req, root),
    catalog,
    personaFields,
    checks,
    findings: found.findings,
  });

  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BUNDLE_BYTES) throw new CatalogInputError(`the bundle is ${bytes} bytes; the contract's limit is ${MAX_BUNDLE_BYTES} (16 MiB)`);
  await mkdir(outDir, { recursive: true });
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
      media: 0,
    },
    warnings: [...warnings, ...found.warnings, ...buildWarnings],
  };
}

/** The human rendering (no `--json`). */
export function renderCatalogExport(r: ExportCatalogBundleResult): string {
  const c = r.counts;
  return `wrote ${r.bundlePath} (${r.digest}): ${c.personas} persona(s), ${c.jobs} job(s), ${c.journeys} Journey(s), ${c.checks} check(s), ${c.findings} finding(s)\n${r.warnings.map((w) => `warning: ${w}\n`).join("")}`;
}
