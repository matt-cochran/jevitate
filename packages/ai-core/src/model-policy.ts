import { z } from "zod";

export const CatalogModelSchema = z.object({
  id: z.string(),
  promptUsdPer1k: z.number().nonnegative(),
  completionUsdPer1k: z.number().nonnegative(),
  regions: z.array(z.string()).default([]),       // e.g. ["US"]
  latencyClass: z.enum(["fast", "standard", "slow"]).default("standard"),
  capabilities: z.array(z.string()).default([]),
}).strict();
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const ModelConstraintsSchema = z.object({
  maxPromptUsdPer1k: z.number().nonnegative().optional(),
  maxCompletionUsdPer1k: z.number().nonnegative().optional(),
  requireRegion: z.string().optional(),            // e.g. "US"
  maxLatencyClass: z.enum(["fast", "standard", "slow"]).optional(),
  requiredCapabilities: z.array(z.string()).default([]),
  pinnedModelId: z.string().optional(),            // preferred iff it still passes the filter
}).strict();
export type ModelConstraints = z.infer<typeof ModelConstraintsSchema>;

export class NoEligibleModelError extends Error {
  readonly code = "E_NO_ELIGIBLE_MODEL" as const;
  constructor(readonly reason: string) { super(`no model passes constraints: ${reason}`); this.name = "NoEligibleModelError"; }
}

const LATENCY_RANK = { fast: 0, standard: 1, slow: 2 } as const;

/** HARD filter: drops every model that fails ANY constraint. Never relaxes. */
export function filterCatalog(catalog: CatalogModel[], c: ModelConstraints): CatalogModel[] {
  const maxLat = c.maxLatencyClass ? LATENCY_RANK[c.maxLatencyClass] : Infinity;
  return catalog.filter((m) =>
    (c.maxPromptUsdPer1k === undefined || m.promptUsdPer1k <= c.maxPromptUsdPer1k) &&
    (c.maxCompletionUsdPer1k === undefined || m.completionUsdPer1k <= c.maxCompletionUsdPer1k) &&
    (c.requireRegion === undefined || m.regions.includes(c.requireRegion)) &&
    (LATENCY_RANK[m.latencyClass] <= maxLat) &&
    c.requiredCapabilities.every((cap) => m.capabilities.includes(cap)));
}

/** Deterministic + prompt-cache-stable: same catalog+constraints → same id.
 *  Honors a still-eligible pin; else the cheapest, tie-broken by id (stable).
 *  Fail-closed: empty eligible set → NoEligibleModelError (never an unfiltered pick). */
export function selectModel(catalog: CatalogModel[], c: ModelConstraints): string {
  const eligible = filterCatalog(catalog, c);
  if (eligible.length === 0) throw new NoEligibleModelError("all filtered out by cost/region/latency/capability");
  if (c.pinnedModelId && eligible.some((m) => m.id === c.pinnedModelId)) return c.pinnedModelId;
  return [...eligible].sort((a, b) =>
    (a.promptUsdPer1k + a.completionUsdPer1k) - (b.promptUsdPer1k + b.completionUsdPer1k)
    || a.id.localeCompare(b.id))[0].id;
}
