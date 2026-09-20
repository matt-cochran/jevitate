import type { JourneyMetadata } from "@jevitate/journey";
import type { SharedJourneyFile } from "./manifest.js";
import type { RiskClass } from "./risk.js";

export interface SourcedJourneyMetadata extends JourneyMetadata {
  source: string; // source name
  pin?: string; // pinned commit (remote sources)
  riskClass: RiskClass; // engine-derived
  contentHash: string; // canonicalJourneyHash
  trusted: boolean; // per-Journey review present & hash matches
}

export interface SourcedJourney {
  meta: SourcedJourneyMetadata;
  file: SharedJourneyFile;
}

export interface JourneySource {
  readonly name: string;
  readonly pin?: string; // undefined for LocalSource
  list(): Promise<SourcedJourneyMetadata[]>; // promoted-only, source-tagged
  get(id: string): Promise<SourcedJourney | null>;
}
