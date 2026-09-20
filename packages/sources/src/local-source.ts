import type { Journey } from "@doit/journey";
import { JourneyRegistry } from "@doit/journey";
import type { JourneySource, SourcedJourney, SourcedJourneyMetadata } from "./source.js";
import { classifyRisk, collectNavigateOrigins } from "./risk.js";
import { canonicalJourneyHash } from "./hash.js";
import type { SharedJourneyFile } from "./manifest.js";

/**
 * Placeholder origin for a locally-authored Journey whose recording has no
 * absolute-origin `navigate` step (e.g. relative-only or empty). Required
 * because `SharedJourneyFileSchema.declaredOrigins` is non-empty — this
 * value carries no policy weight for `LocalSource` since it always marks
 * its own Journeys `trusted: true` (source trust = the local author).
 */
const LOCAL_FALLBACK_ORIGIN = "https://local.journey";

function toSharedJourneyFile(journey: Journey): SharedJourneyFile {
  const origins = collectNavigateOrigins(journey.recording);
  return {
    ...journey,
    declaredOrigins: origins.length > 0 ? origins : [LOCAL_FALLBACK_ORIGIN],
  };
}

/**
 * Wraps a `JourneyRegistry` (backed by the Slice-1 `FsJourneyStore`) as a
 * `JourneySource` — reusing its promoted-only `find`/`get` rather than
 * re-implementing filtering. Local Journeys are always `trusted: true`:
 * the local author IS the trust boundary for their own authored content
 * (spec §5 — trust is per-Journey review; the author reviewing their own
 * work locally is that review).
 */
export class LocalSource implements JourneySource {
  readonly pin?: string = undefined;

  constructor(
    readonly name: string,
    private readonly registry: JourneyRegistry,
  ) {}

  async list(): Promise<SourcedJourneyMetadata[]> {
    const metas = await this.registry.find("");
    const out: SourcedJourneyMetadata[] = [];
    for (const m of metas) {
      const sourced = await this.get(m.id);
      if (sourced) out.push(sourced.meta);
    }
    return out;
  }

  async get(id: string): Promise<SourcedJourney | null> {
    const journey = await this.registry.get(id);
    if (!journey) return null;
    const file = toSharedJourneyFile(journey);
    const meta: SourcedJourneyMetadata = {
      ...journey.metadata,
      source: this.name,
      riskClass: classifyRisk(file),
      contentHash: canonicalJourneyHash(file),
      trusted: true,
    };
    return { meta, file };
  }
}
