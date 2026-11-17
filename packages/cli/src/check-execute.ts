// check-execute.ts — `jevitate check` item execution (#231).
import { type Planned, fixturesFor, targetFixtures } from "./check-plan.js";
import { type ConsolidatedDefect } from "@jevitate/findings";
import { type ExecContext, type Executed, executeGoalItem, executeJourneyItem, executeMissionItem, executeVerifyFixItem } from "./check-execute-items.js";

// ── execution ────────────────────────────────────────────────────────────────

export type { ExecContext, Executed };

/**
 * #293: a journey-anchored mission item runs between the target's fixture setup and restore (as a
 * Journey item does), so one stop point's side effects never leak into the next of a sweep.
 */
export async function execute(item: Planned, ctx: ExecContext, remaining: number | undefined): Promise<Executed> {
  const anchored = item.kind === "mission" && item.mission !== undefined && item.t.prefixes?.has(item.mission) === true;
  if (!anchored || item.t.fixturesFile === undefined) return executeItem(item, ctx, remaining);
  const session = item.setup?.storageState;
  const fx = fixturesFor(targetFixtures(item.t, session), item.t.prefixes!.get(item.mission!)!.startUrl);
  if (fx === undefined) return executeItem(item, ctx, remaining);
  try {
    await fx.setup();
    return await executeItem(item, ctx, remaining);
  } finally {
    await fx.restore();
  }
}

/** Dispatch one planned item to the executor for its kind (see `check-execute-items.ts`). */
async function executeItem(item: Planned, ctx: ExecContext, remaining: number | undefined): Promise<Executed> {
  if (item.kind === "journey" && item.journey !== undefined) return executeJourneyItem(item, ctx, remaining);
  if (item.kind === "goal" && item.goal !== undefined) return executeGoalItem(item, ctx, remaining);
  if (item.kind === "mission" && item.mission !== undefined) return executeMissionItem(item, ctx, remaining);
  if (item.kind === "verify-fix" && item.verify !== undefined) return executeVerifyFixItem(item, ctx, remaining);
  return { status: "error", actions: 0, error: { type: "internal", message: `unplannable item ${item.kind} ${item.name}` } };
}

// ── gate ─────────────────────────────────────────────────────────────────────

export function caseDetail(defects: readonly ConsolidatedDefect[]): string {
  return defects.map((d) => `${d.key} ${d.title}${d.reproduce === undefined ? "" : `\n  reproduce: ${d.reproduce}`}`).join("\n");
}
