import { clock } from "@jevitate/domain";
import { JourneyRunRefusedError, queueJourney, QueueJourneyRefusedError, QUEUE_JOURNEY_SECRET_CODE } from "@jevitate/mcp-facade";
import { FsJourneyCallQueueStore } from "@jevitate/missions";
import { runAsMcpInvocation } from "../approval-provenance.js";
import { environmentFromFlags, isEnvironmentError } from "../environments.js";
import { journeyReviewHash } from "../journey-review.js";
import { runGuardedJourney, RunModeRefusedError, runModeRefusalBody } from "../journey-run-mode-gate.js";
import { RunGuardRefusedError, runGuardRefusalBody } from "../mcp-run-guard.js";
import { secretParamRefusalBody, secretParamsCarried } from "../secret-params.js";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { errorResult, jsonResult } from "./shared.js";

/** The error a gate's refusal answers with: the same bodies `run_journey` returns, never a value. */
function refusalBody(err: unknown, id: string): Record<string, unknown> | undefined {
  if (err instanceof JourneyRunRefusedError) return { error: "refused", outcome: "refused", code: err.code, id, message: err.message, fix: err.fix, tryDraft: err.tryDraft, retryable: false };
  if (err instanceof RunModeRefusedError) return runModeRefusalBody(err);
  if (err instanceof RunGuardRefusedError) return runGuardRefusalBody(err);
  if (isEnvironmentError(err)) return { error: "invalid_args", code: err.code, message: err.message };
  return undefined;
}

/**
 * 0.30.0 #797 `queue_journey` (`jevitate journey queue`): enqueues one call of a PROMOTED Journey for
 * `jevitate mission run` to drain. Never runs anything. In order, before anything is written:
 *
 *  1. a secret param is refused by name (`E_SECRET_PARAM_OVER_MCP`): a credential-like name, or one the
 *     Journey declares secret. A queued call never stores a secret value;
 *  2. the env / baseUrl resolve as `run_journey`'s do;
 *  3. the same gate as `run_journey` (`runGuardedJourney`, as an MCP invocation): promoted with a current
 *     approval, the run mode allows it, the #789 guard. Its hash is what the call binds to: a Journey
 *     changed before the drain is refused `E_JOURNEY_APPROVAL_STALE` then.
 *
 * The drain re-runs the gate from the files as they are then (mission-queue-runner.ts).
 */
export function queueJourneyTools(ctx: McpToolCtx): McpToolGroup {
  const { deps } = ctx;
  const seams = {
    ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
    ...(deps.targetsConfigPath === undefined ? {} : { targetsFile: deps.targetsConfigPath }),
  };
  return {
    queue_journey: {
      description:
        "Enqueue a call of a PROMOTED Journey by id (the same promotion and run-mode rules as run_journey) — `jevitate journey queue`. Never runs anything: `jevitate mission run` (run_queued_missions) drains it through the same gate as run_journey, and the run's evidence says channel `queue`. " +
        "The call holds only the Journey's id, the content hash it was queued against (a Journey changed before the drain is refused E_JOURNEY_APPROVAL_STALE then), non-secret string 'params', and 'env' (a named environment in .jevitate/environments.json) or 'baseUrl'. " +
        "A secret parameter's value is never queued: a credential-like name, or one the Journey declares secret, is refused by name before anything is written ({error: invalid_args, code: E_SECRET_PARAM_OVER_MCP, params}); the run meets a secret the Journey needs with its secret mode (the target's targets.json secretFields, or a hold a person completes). " +
        "Refusals are run_journey's, before anything is queued: E_JOURNEY_NOT_PROMOTED | E_JOURNEY_APPROVAL_STALE | E_JOURNEY_APPROVAL_UNKNOWN, E_APPROVAL_CHANNEL_FOR_MODE, E_HUMAN_STEP_IN_TEST_MODE, E_RUN_REFUSED_PRODUCTION. Returns {ok, callId, status: queued, journey: {id, hash}}.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          params: { type: "object", additionalProperties: { type: "string" } },
          env: { type: "string" },
          baseUrl: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (args) => {
        if (!deps.missionQueueDir) return errorResult({ error: "invalid_args", message: "queue_journey requires missionQueueDir to be configured" });
        // 1. Before anything is read or written: a secret param, by name (the Journey's declared secrets too).
        const carried = await secretParamsCarried(deps.journeysDir, [args.id], args.params);
        if (carried.length > 0) return errorResult(secretParamRefusalBody(carried));
        const id = typeof args.id === "string" ? args.id : "";
        try {
          const queued = await queueJourney(new FsJourneyCallQueueStore(deps.missionQueueDir), args, {
            nowIso: () => clock.nowIso(),
            resolveHash: async (req) => {
              // 2. Where it will run, resolved as run_journey resolves it.
              const environment = environmentFromFlags({ ...(req.env === undefined ? {} : { env: req.env }), ...(req.baseUrl === undefined ? {} : { baseUrl: req.baseUrl }) }, seams);
              // 3. run_journey's gate, as an MCP invocation; the "run" only reads the hash it binds to.
              return runAsMcpInvocation(() =>
                runGuardedJourney({
                  journeysDir: deps.journeysDir,
                  id: req.id,
                  environment,
                  ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
                  targetsFile: deps.targetsConfigPath,
                  run: async (decision) => {
                    if (decision === undefined) throw new JourneyRunRefusedError("E_JOURNEY_APPROVAL_UNKNOWN", `journey '${req.id}' is not in the store; nothing was queued.`, "jevitate journey list", `jevitate journey run ${req.id}`);
                    return journeyReviewHash(decision.journey);
                  },
                }),
              );
            },
          });
          return jsonResult(queued);
        } catch (err) {
          if (err instanceof QueueJourneyRefusedError) {
            return errorResult(err.code === QUEUE_JOURNEY_SECRET_CODE ? secretParamRefusalBody(err.params) : { error: "invalid_args", code: err.code, message: err.message });
          }
          const body = refusalBody(err, id);
          if (body !== undefined) return errorResult(body);
          throw err;
        }
      },
    },
  };
}
