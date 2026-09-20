import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Journey } from "@doit/journey";
import type { GitSourceManager } from "./git.js";
import { SharedJourneyFileSchema, type SharedJourneyFile } from "./manifest.js";
import { collectNavigateOrigins } from "./risk.js";
import { hasEmbeddedSecretValue } from "./secrets.js";
import { EmbeddedSecretError, UndeclaredOriginError } from "./errors.js";

export interface PublishRequest {
  journey: Journey;
  declaredOrigins: string[];
  toSource: string;
  asId?: string;
}

export interface PublishResult {
  branch: string;
  pushed: boolean;
  prUrl?: string;
  instructions?: string;
}

/** Injectable `gh` CLI port (§14.3 — graceful degrade when `gh` isn't
 * installed/authenticated: the branch+push still happens; the caller gets
 * explicit instructions instead of a failure). */
export type GhPort = {
  available(): Promise<boolean>;
  createPr(cwd: string, branch: string, title: string): Promise<string>;
};

/** Rejects an `id` containing a path separator or `..` segment before it is
 * ever used to build a filesystem path — mirrors `@doit/journey`'s
 * `assertSafeId` and this package's own `FsTrustStore`/`GitSourceManager`/
 * `FsAckStore` guards. Applied to the RESOLVED id (covers both an explicit
 * `asId` and the `metadata.id` fallback), so a hostile
 * `asId: "../../evil"` (or a `..`-containing `metadata.id`) can never write
 * a file outside the source clone's `journeys/` directory. */
function assertSafeId(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..") || id.length === 0) {
    throw new Error(`Invalid journey id (path traversal risk): ${id}`);
  }
}

/**
 * Validates a `PublishRequest` into a ready-to-write `SharedJourneyFile`.
 * Throws unless:
 *  - it parses as a closed-schema `SharedJourneyFile` (declaredOrigins
 *    present, non-empty, valid URLs — Zod throws on violation);
 *  - it carries secret REFERENCES only (§9.7 publish side, FMECA #3) — any
 *    `fill`/`select` value of shape `{ redacted: false, value }` is a real,
 *    materialized secret and hard-blocks;
 *  - `declaredOrigins` COVERS every origin the steps actually touch (reuses
 *    the risk classifier's origin walk) — an author cannot under-declare
 *    where their own Journey goes.
 */
export function validateForPublish(req: PublishRequest): SharedJourneyFile {
  const id = req.asId ?? req.journey.metadata.id;
  // Fail-closed BEFORE any schema parse or path construction — a
  // path-traversal id must never reach `publishJourney`'s file write.
  assertSafeId(id);
  const candidate = {
    ...req.journey,
    metadata: { ...req.journey.metadata, id },
    declaredOrigins: req.declaredOrigins,
  };
  const file = SharedJourneyFileSchema.parse(candidate);

  if (hasEmbeddedSecretValue(file.recording)) {
    throw new EmbeddedSecretError(
      `journey '${id}' carries a materialized (non-redacted) secret value — publish requires secret REFERENCES only`,
    );
  }

  const touchedOrigins = collectNavigateOrigins(file.recording);
  const declaredSet = new Set(file.declaredOrigins.map((o) => new URL(o).origin));
  for (const origin of touchedOrigins) {
    if (!declaredSet.has(origin)) {
      throw new UndeclaredOriginError(
        `journey '${id}' navigates to origin '${origin}' which is not covered by its declaredOrigins`,
      );
    }
  }

  return file;
}

/**
 * Validates, then writes `journeys/<id>.journey.json` into the source's
 * clone on a NEW branch `publish/<id>` — NEVER the default branch — commits,
 * and pushes. Opens a PR via `gh` if available; otherwise returns explicit
 * branch+push+PR instructions rather than failing (§14.3 graceful degrade).
 * Never auto-publishes: this function is called once per explicit publish
 * request, for exactly the one id it validated (FMECA #7).
 */
export async function publishJourney(
  mgr: GitSourceManager,
  gh: GhPort,
  req: PublishRequest,
): Promise<PublishResult> {
  const file = validateForPublish(req);
  const id = file.metadata.id;
  const branch = `publish/${id}`;
  const dir = mgr.resolveDir(req.toSource);

  await mgr.run(req.toSource, ["checkout", "-b", branch]);
  await mkdir(join(dir, "journeys"), { recursive: true });
  await writeFile(join(dir, "journeys", `${id}.journey.json`), JSON.stringify(file, null, 2) + "\n", "utf8");
  await mgr.run(req.toSource, ["add", join("journeys", `${id}.journey.json`)]);
  await mgr.run(req.toSource, ["commit", "-m", `Add ${id} journey`]);
  await mgr.run(req.toSource, ["push", "-u", "origin", branch]);

  if (await gh.available()) {
    const prUrl = await gh.createPr(dir, branch, `Add ${id} journey`);
    return { branch, pushed: true, prUrl };
  }

  return {
    branch,
    pushed: true,
    instructions: `Branch '${branch}' was pushed to origin. Open a pull request comparing '${branch}' against the source's default branch to contribute it.`,
  };
}
