import type { FederatedJourneyRegistry } from "./federated-registry.js";
import type { TrustStore } from "./trust.js";
import { isTrusted } from "./trust.js";
import type { JevitateManifest, SharedJourneyFile } from "./manifest.js";
import type { TouAck } from "./tou.js";
import { requireDeclaredTou } from "./tou.js";
import { classifyRisk } from "./risk.js";
import { canonicalJourneyHash } from "./hash.js";
import { hasEmbeddedSecretValue } from "./secrets.js";
import {
  UnknownSourceError,
  HashMismatchError,
  UntrustedRiskyJourneyError,
  UndeclaredOriginError,
  UndeclaredTouError,
  EmbeddedSecretError,
} from "./errors.js";

export interface RunGateDeps {
  fed: FederatedJourneyRegistry;
  trust: TrustStore;
  manifestFor(source: string): Promise<JevitateManifest>;
  ackFor(source: string): Promise<TouAck | null>;
}

/**
 * The full §9.8 "reviewed, pinned, in-origin, or refuse" gate. Runs every
 * check below IN ORDER; each failure THROWS its typed error — no branch
 * ever returns a degraded/partial "ok" (fail-closed, enforced by
 * `scripts/check-no-permissive-fallback.mjs`). Returns the validated,
 * ready-to-run `SharedJourneyFile` only if every gate passes.
 */
export async function resolveForRun(deps: RunGateDeps, address: string): Promise<SharedJourneyFile> {
  // 1. Unknown source / unknown id (FMECA #5).
  const sourced = await deps.fed.get(address);
  if (!sourced) {
    throw new UnknownSourceError(`no journey found at address '${address}'`);
  }
  const { meta, file } = sourced;

  // 2. Hash mismatch (FMECA #2, TOCTOU) — recompute; if a TrustRecord exists
  // and its hash differs from the CURRENT content, the bytes changed since
  // review.
  const currentHash = canonicalJourneyHash(file);
  const trustRecord = await deps.trust.get(meta.source, meta.id);
  if (trustRecord && trustRecord.contentHash !== currentHash) {
    throw new HashMismatchError(
      `content hash for '${address}' changed since it was reviewed (recorded ${trustRecord.contentHash}, current ${currentHash})`,
    );
  }

  // 3. Risk gate (FMECA #6 + §5) — engine-derived, never author-declared.
  const riskClass = classifyRisk(file);
  if (riskClass === "risky" && !(await isTrusted(deps.trust, meta.source, meta.id, currentHash))) {
    throw new UntrustedRiskyJourneyError(
      `'${address}' is classified risky and has no matching TrustRecord for its current content`,
    );
  }

  // 4. Declared-origin gate (§9.8) — every declaredOrigin must be declared
  // in the source's manifest.
  const manifest = await deps.manifestFor(meta.source);
  const declaredOriginSet = new Set(manifest.sites.map((s) => new URL(s.origin).origin));
  for (const origin of file.declaredOrigins) {
    if (!declaredOriginSet.has(new URL(origin).origin)) {
      throw new UndeclaredOriginError(
        `'${address}' declares origin '${origin}' which source '${meta.source}' does not declare in its manifest`,
      );
    }
  }

  // 5. ToU gate (§8, FMECA #4) — each declared origin must resolve via
  // requireDeclaredTou, and a recorded ack must cover the source.
  for (const origin of file.declaredOrigins) {
    requireDeclaredTou(manifest, origin);
  }
  const ack = await deps.ackFor(meta.source);
  if (!ack) {
    throw new UndeclaredTouError(`no recorded Terms-of-Use acknowledgment for source '${meta.source}'`);
  }

  // 6. Secret-references-only, import side (§9.7) — a materialized,
  // non-redacted secret value is never acceptable to run.
  if (hasEmbeddedSecretValue(file.recording)) {
    throw new EmbeddedSecretError(`'${address}' carries a materialized (non-redacted) secret value`);
  }

  return file;
}
