import type { JourneySource, SourcedJourney, SourcedJourneyMetadata } from "./source.js";
import { loadManifest, loadJourneyFiles, type JevitateManifest, type SharedJourneyFile } from "./manifest.js";
import { classifyRisk } from "./risk.js";
import { canonicalJourneyHash } from "./hash.js";

/** True iff every origin `file.declaredOrigins` claims has a matching
 * `SiteDeclaration` in the source's `jevitate.json` manifest. A file whose
 * claimed origins outrun what the source has actually declared cannot be
 * vouched for by the source itself (§9.8 undeclared-origin / FMECA #4 basis)
 * — it is excluded from discovery here; the run-gate (Task 12) separately
 * refuses it by exact address with a typed error. */
function originsAreCovered(file: SharedJourneyFile, manifest: JevitateManifest): boolean {
  const declaredSet = new Set(manifest.sites.map((s) => new URL(s.origin).origin));
  return file.declaredOrigins.every((o) => declaredSet.has(new URL(o).origin));
}

function tag(file: SharedJourneyFile, name: string, pin: string): SourcedJourneyMetadata {
  return {
    ...file.metadata,
    source: name,
    pin,
    riskClass: classifyRisk(file),
    contentHash: canonicalJourneyHash(file),
    // Trust is applied by the run-gate/FederatedJourneyRegistry against the
    // TrustStore, not decided here — a RemoteSource never self-certifies.
    trusted: false,
  };
}

/**
 * Read-only `JourneySource` over a pinned git clone following the
 * `jevitate.json` + `journeys/*.journey.json` repo convention (spec §3).
 * Never writes to the clone; never advances the pin (that's
 * `GitSourceManager.update`, always explicit).
 */
export class RemoteSource implements JourneySource {
  constructor(
    readonly name: string,
    private readonly cloneDir: string,
    readonly pin: string,
  ) {}

  async list(): Promise<SourcedJourneyMetadata[]> {
    const manifest = await loadManifest(this.cloneDir);
    const files = await loadJourneyFiles(this.cloneDir);
    return files
      .filter((f) => originsAreCovered(f, manifest))
      .map((f) => tag(f, this.name, this.pin));
  }

  async get(id: string): Promise<SourcedJourney | null> {
    const files = await loadJourneyFiles(this.cloneDir);
    const file = files.find((f) => f.metadata.id === id);
    if (!file) return null;
    return { meta: tag(file, this.name, this.pin), file };
  }
}
