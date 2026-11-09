import { randomUUID } from "node:crypto";
import { isSecretName } from "@jevitate/journey";
import { enqueueMission, type JourneyCallQueueStore, type MissionTargetRegistry, type MissionQueueStore } from "@jevitate/missions";

export interface QueueExplorationResult {
  ok: true;
  missionId: string;
  status: "queued";
}

/**
 * Invariant #5/#6 analogue for missions: resolves a PROMOTED target by id
 * only, refuses out-of-schema params and over-ceiling budgets, and never
 * runs anything — it only enqueues. All validation is delegated to
 * `enqueueMission` (never duplicated here), matching `runJourney`'s shape.
 */
export async function queueExploration(
  targets: MissionTargetRegistry,
  queue: MissionQueueStore,
  args: unknown,
): Promise<QueueExplorationResult> {
  const mission = await enqueueMission(targets, queue, args);
  return { ok: true, missionId: mission.id, status: "queued" };
}

/** The code a secret-named param in a `queue_journey` request is refused with: the MCP code, by name (never the value). */
export const QUEUE_JOURNEY_SECRET_CODE = "E_SECRET_PARAM_OVER_MCP";

/** A `queue_journey` request refused before anything was resolved or written. Names params, never values. */
export class QueueJourneyRefusedError extends Error {
  constructor(
    readonly code: typeof QUEUE_JOURNEY_SECRET_CODE | "E_QUEUE_JOURNEY_ARGS",
    message: string,
    readonly params: readonly string[] = [],
  ) {
    super(message);
    this.name = "QueueJourneyRefusedError";
  }
}

export interface QueueJourneyArgs {
  readonly id: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly env?: string;
  readonly baseUrl?: string;
}

export interface QueueJourneyResult {
  ok: true;
  callId: string;
  status: "queued";
  journey: { id: string; hash: string };
}

/**
 * #797: the shape of a `queue_journey` request. A secret-named param is refused FIRST, by name, before
 * the id or anything else is looked at: a queued call never carries a secret value (the run meets a
 * secret the Journey needs with its own secret mode, vault or hold).
 */
export function parseQueueJourneyArgs(args: unknown): QueueJourneyArgs {
  const a = (args !== null && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const raw = a.params;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new QueueJourneyRefusedError("E_QUEUE_JOURNEY_ARGS", "queue_journey 'params' must be an object of string values");
  }
  const params = (raw ?? {}) as Record<string, unknown>;
  const secret = Object.keys(params).filter((name) => isSecretName(name));
  if (secret.length > 0) {
    throw new QueueJourneyRefusedError(
      QUEUE_JOURNEY_SECRET_CODE,
      `secret parameter${secret.length === 1 ? "" : "s"} ${secret.join(", ")}: a queued Journey call never stores a secret value; nothing was queued. Queue the call without it: the run meets a secret the Journey needs with its secret mode (the target's targets.json secretFields, or a hold a person completes)`,
      secret,
    );
  }
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") throw new QueueJourneyRefusedError("E_QUEUE_JOURNEY_ARGS", `queue_journey param '${k}' must be a string`);
  }
  if (typeof a.id !== "string" || a.id.length === 0) throw new QueueJourneyRefusedError("E_QUEUE_JOURNEY_ARGS", "queue_journey requires a non-empty string 'id'");
  for (const k of ["env", "baseUrl"] as const) {
    if (a[k] !== undefined && (typeof a[k] !== "string" || a[k] === "")) throw new QueueJourneyRefusedError("E_QUEUE_JOURNEY_ARGS", `queue_journey '${k}' must be a non-empty string`);
  }
  if (a.env !== undefined && a.baseUrl !== undefined) throw new QueueJourneyRefusedError("E_QUEUE_JOURNEY_ARGS", "queue_journey takes env or baseUrl, not both");
  return {
    id: a.id,
    ...(Object.keys(params).length === 0 ? {} : { params: params as Record<string, string> }),
    ...(a.env === undefined ? {} : { env: a.env as string }),
    ...(a.baseUrl === undefined ? {} : { baseUrl: a.baseUrl as string }),
  };
}

/**
 * #797: enqueues one call of a promoted Journey. Never runs anything. `resolveHash` is the caller's gate
 * (the Journey is promoted with a current approval, and the run mode allows it): it returns the content
 * hash the call binds to, and its refusal is the caller's to report. Nothing is written before it passed.
 */
export async function queueJourney(
  queue: JourneyCallQueueStore,
  args: unknown,
  opts: { readonly resolveHash: (req: QueueJourneyArgs) => Promise<string>; readonly nowIso: () => string; readonly newId?: () => string },
): Promise<QueueJourneyResult> {
  const req = parseQueueJourneyArgs(args);
  const hash = await opts.resolveHash(req);
  const now = opts.nowIso();
  const id = (opts.newId ?? (() => `journey-${randomUUID()}`))();
  await queue.enqueue({
    id,
    status: "queued",
    enqueuedAtIso: now,
    call: {
      kind: "journey",
      journey: { id: req.id, hash },
      ...(req.params === undefined ? {} : { params: { ...req.params } }),
      ...(req.env === undefined ? {} : { env: req.env }),
      ...(req.baseUrl === undefined ? {} : { baseUrl: req.baseUrl }),
      requestedAt: now,
    },
  });
  return { ok: true, callId: id, status: "queued", journey: { id: req.id, hash } };
}
