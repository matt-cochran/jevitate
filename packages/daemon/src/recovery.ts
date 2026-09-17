import type { CommandRepository, EventLog } from "@doit/application";

export async function recoverOnStartup(
  repo: CommandRepository,
  log: EventLog,
  correlationId: string,
): Promise<number> {
  const count = await repo.recoverExpiredLeases();
  await log.append({
    aggregate: "daemon",
    type: "lease.recovered",
    payload: { count },
    occurredAt: new Date().toISOString(),
    correlationId,
  });
  return count;
}
