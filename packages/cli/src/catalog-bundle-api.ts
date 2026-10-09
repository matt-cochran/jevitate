import { NotImplementedError } from "./not-implemented.js";

/**
 * #464 — `jevitate catalog export --format journeeze-bundle --out <dir>` / MCP
 * `export_catalog_bundle`: write the project's catalog (personas, jobs, Journeys verbatim with their
 * approvals, links, checks, findings) as a Journeeze catalog bundle (journeeze-saas
 * `docs/contract/catalog-bundle-v1.md`, schema `docs/schemas/catalog-bundle.v1.json`). 0.10 exports
 * no media files. Session keys and typed values never leave; approvals are exported, never made.
 *
 * It only writes `bundle.json` under `outDir` (over MCP, `outDir` is a confined path inside the
 * project); it never uploads (that is `publish journeeze`) and never approves anything.
 *
 * STUB (d-surface-0): the feature deliverable replaces the body of `exportCatalogBundle` and owns this file.
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
  /** Items left out or degraded, each with why (e.g. an unapproved Journey, a session key dropped). */
  readonly warnings: readonly string[];
}

export async function exportCatalogBundle(_req: ExportCatalogBundleRequest): Promise<ExportCatalogBundleResult> {
  throw new NotImplementedError("jevitate catalog export --format journeeze-bundle", "#464");
}

/** The human rendering (no `--json`). */
export function renderCatalogExport(r: ExportCatalogBundleResult): string {
  const c = r.counts;
  return `wrote ${r.bundlePath} (${r.digest}): ${c.personas} persona(s), ${c.jobs} job(s), ${c.journeys} Journey(s), ${c.checks} check(s), ${c.findings} finding(s)\n${r.warnings.map((w) => `warning: ${w}\n`).join("")}`;
}
