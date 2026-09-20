import type { MissionTarget } from "./schema.js";
import type { MissionTargetStore } from "./target-store.js";
import { UnknownOrUnpromotedMissionTargetError } from "./errors.js";

/**
 * The single message used for BOTH "id doesn't exist" and "id exists but
 * unpromoted" — deliberately non-distinguishing so an untrusted caller can't
 * enumerate which target ids exist by observing a different failure mode for
 * each case (mirrors `runJourney`'s "unknown or unpublished journey" refusal
 * in `packages/mcp-facade/src/journey-tools.ts`).
 */
const REFUSAL_MESSAGE = "unknown or unpromoted mission target";

/**
 * Promoted-only target registry — the MCP-facing analogue of
 * `JourneyRegistry`. `resolve(id)` is the ONLY way `queue_exploration`
 * (via `enqueueMission`) is allowed to turn a `target` string into a real
 * `{ authorizedOrigin, baseUrl }` — it never accepts a raw URL.
 */
export class MissionTargetRegistry {
  constructor(private readonly store: MissionTargetStore) {}

  put(t: MissionTarget): Promise<void> {
    return this.store.put(t);
  }

  async promote(id: string): Promise<void> {
    const t = await this.store.get(id);
    if (!t) throw new Error(`cannot promote unknown mission target '${id}'`);
    await this.store.put({ ...t, promoted: true });
  }

  /**
   * Resolves a mission target by id, refusing (fail-closed) unless the
   * target exists AND is promoted. Never falls back to treating `id` as a
   * raw URL/origin.
   */
  async resolve(id: string): Promise<MissionTarget> {
    const t = await this.store.get(id);
    if (!t || !t.promoted) {
      throw new UnknownOrUnpromotedMissionTargetError(REFUSAL_MESSAGE);
    }
    return t;
  }
}
