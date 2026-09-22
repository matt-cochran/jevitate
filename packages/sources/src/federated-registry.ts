import type { JourneySource, SourcedJourney, SourcedJourneyMetadata } from "./source.js";
import type { TrustStore } from "./trust.js";
import { isTrusted } from "./trust.js";
import { UnknownSourceError } from "./errors.js";

/**
 * Composes N `JourneySource`s (a `LocalSource` plus zero or more
 * `RemoteSource`s) into one federated discovery/addressing surface (spec
 * §4). Addresses are `<source>/<id>` — flat, two-segment, no nesting
 * (§9.9). Two sources may legally list the same bare `id`; they never
 * collide because each stays tagged with its own `source` in the merged
 * list (the caller composes the `source/id` address itself).
 */
export class FederatedJourneyRegistry {
  constructor(
    private readonly sources: JourneySource[],
    private readonly trust: TrustStore,
  ) {}

  async find(query: string): Promise<SourcedJourneyMetadata[]> {
    const q = query.trim().toLowerCase();
    const merged: SourcedJourneyMetadata[] = [];
    for (const source of this.sources) {
      const metas = await source.list();
      for (const m of metas) {
        if (q !== "" && !m.name.toLowerCase().includes(q) && !(m.description ?? "").toLowerCase().includes(q)) {
          continue;
        }
        // A source may already self-certify trust (LocalSource: the local
        // author IS the trust boundary); otherwise fall back to a recorded,
        // hash-bound TrustRecord (RemoteSource always starts `trusted:
        // false` and relies entirely on this).
        const trusted = m.trusted || (await isTrusted(this.trust, m.source, m.id, m.contentHash));
        merged.push({ ...m, trusted });
      }
    }
    merged.sort((a, b) => {
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return merged;
  }

  /** `address` is `<source>/<id>`. An unknown source name ⇒
   * `UnknownSourceError` (FMECA #5 / §9.8) — never a silent `null`, since a
   * typo'd/typosquat source name is a security-relevant miss, not an
   * ordinary "not found". An unknown id WITHIN a known source returns
   * `null` (ordinary not-found), matching `JourneySource.get`. */
  async get(address: string): Promise<SourcedJourney | null> {
    const slashIndex = address.indexOf("/");
    if (slashIndex === -1) {
      throw new UnknownSourceError(`invalid journey address (expected '<source>/<id>'): ${address}`);
    }
    const sourceName = address.slice(0, slashIndex);
    const id = address.slice(slashIndex + 1);
    const source = this.sources.find((s) => s.name === sourceName);
    if (!source) {
      throw new UnknownSourceError(`unknown source '${sourceName}'`);
    }
    return source.get(id);
  }
}
