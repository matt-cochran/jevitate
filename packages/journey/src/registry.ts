import type { Journey, JourneyMetadata } from "./journey.js";
import type { FsJourneyStore } from "./store.js";

export class JourneyRegistry {
  constructor(private readonly store: FsJourneyStore) {}
  get(id: string) { return this.store.get(id); }
  put(j: Journey) { return this.store.put(j); }
  async promote(id: string): Promise<void> {
    const j = await this.store.get(id);
    if (!j) throw new Error(`cannot promote unknown journey '${id}'`);
    await this.store.put({ ...j, metadata: { ...j.metadata, promoted: true } });
  }
  async find(query: string): Promise<JourneyMetadata[]> {
    const q = query.trim().toLowerCase();
    const all = await this.store.list();
    return all.filter((m) => m.promoted)
      .filter((m) => q === "" || m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q));
  }
}
