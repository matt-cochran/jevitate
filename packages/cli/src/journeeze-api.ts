import { NotImplementedError } from "./not-implemented.js";

/**
 * #464 — the Journeeze upload (journeeze-saas `docs/contract/catalog-bundle-upload-v1.md` §9).
 *
 * - `jevitate connect journeeze [--url <base>]` — CLI ONLY, never an MCP tool: reads the per-product
 *   upload key (`jzu_…`) from stdin WITHOUT echo (never from a flag or an argument), calls
 *   `GET /api/upload/v1/whoami`, shows the product and asks the person to confirm, then stores the
 *   key and base URL in jevitate's secret store under the project (never in plain text, never in the repo).
 * - `jevitate publish journeeze [--dry-run]` / MCP `publish_to_journeeze`: exports the bundle
 *   (catalog-bundle-api.ts), `POST /api/upload/v1/bundles` with `Idempotency-Key = sha256-<hex of
 *   bundle.json>`, polls `statusUrl` to `imported`/`refused`, and reports summary, warnings and errors.
 *   The key is resolved by jevitate itself (the secret store, or `JOURNEEZE_UPLOAD_KEY` in CI); it is
 *   never an argument, never in a result, never logged — the model never sees it. Publishing never approves.
 *
 * STUB (d-surface-0): the feature deliverable replaces the bodies of `connectJourneeze` and
 * `publishToJourneeze` and owns this file.
 */

export const JOURNEEZE_DEFAULT_URL = "https://app.journeeze.dev";

export interface ConnectJourneezeRequest {
  /** `--url` (http(s), validated by the command), default JOURNEEZE_DEFAULT_URL. */
  readonly baseUrl: string;
  /** The project data dir the key is stored under; null outside a project. */
  readonly projectDir: string | null;
}

export interface ConnectJourneezeResult {
  readonly baseUrl: string;
  readonly product: { readonly id: string; readonly name: string };
  /** The key's public prefix (`whoami.keyPrefix`) — the only form of the key ever shown. */
  readonly keyPrefix: string;
  readonly stored: boolean;
}

/** Interactive: needs a person at a terminal (refuses without a TTY). The key is read here, never passed in. */
export async function connectJourneeze(_req: ConnectJourneezeRequest): Promise<ConnectJourneezeResult> {
  throw new NotImplementedError("jevitate connect journeeze", "#464");
}

export interface PublishJourneezeRequest {
  /** The project data dir (`--dir`, else the repo's `.jevitate/`); null outside a project. */
  readonly catalogDir: string | null;
  readonly journeysDir: string;
  /** `--dry-run`: export and validate the bundle, resolve the connection, send nothing. */
  readonly dryRun: boolean;
}

export interface PublishJourneezeResult {
  readonly dryRun: boolean;
  readonly baseUrl: string;
  /** `sha256-<hex of bundle.json>`. */
  readonly idempotencyKey: string;
  readonly uploadId?: string;
  /** The final upload status (`dry-run` when nothing was sent). */
  readonly status: "dry-run" | "imported" | "refused";
  readonly summary?: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export async function publishToJourneeze(_req: PublishJourneezeRequest): Promise<PublishJourneezeResult> {
  throw new NotImplementedError("jevitate publish journeeze", "#464");
}

/** The human rendering (no `--json`). */
export function renderPublishJourneeze(r: PublishJourneezeResult): string {
  return `${r.dryRun ? "dry run: nothing sent" : `upload ${r.uploadId ?? "?"}: ${r.status}`} (${r.idempotencyKey}) → ${r.baseUrl}\n${r.warnings.map((w) => `warning: ${w}\n`).join("")}${r.errors.map((e) => `error: ${e}\n`).join("")}`;
}
