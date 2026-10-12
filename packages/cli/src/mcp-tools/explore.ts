import { queueExploration as facadeQueueExploration, aiGenerateText as facadeAiGenerateText, type AiGenerateTextArgs } from "@jevitate/mcp-facade";
import { FsMissionTargetStore, MissionTargetRegistry, FsMissionQueueStore, MISSION_STRATEGIES, QUEUED_SCREENSHOT_MODES } from "@jevitate/missions";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { jsonResult, errorResult, redactCredentials } from "./shared.js";

/** `queue_exploration` and `ai_generate_text`. */
export function exploreTools(ctx: McpToolCtx): McpToolGroup {
  const { deps, credentialStore } = ctx;
  // queue_exploration: enqueue over the SAME promoted fs store `jevitate
  // mission target` writes. The store is built lazily inside the closure so
  // constructing the tool set never touches disk; a missing dir is a config
  // error (a refusal), never a silent success.
  const queueExploration =
    deps.queueExploration ??
    (async (args: unknown) => {
      if (!deps.missionTargetsDir || !deps.missionQueueDir) {
        throw new Error("queue_exploration requires missionTargetsDir and missionQueueDir to be configured");
      }
      const targets = new MissionTargetRegistry(new FsMissionTargetStore(deps.missionTargetsDir));
      const queue = new FsMissionQueueStore(deps.missionQueueDir);
      return facadeQueueExploration(targets, queue, args);
    });

  // ai_generate_text: preflight-gated generation. Wired only when a gateway (or
  // an explicit seam) is available — otherwise it stays not_implemented rather
  // than fabricate an answer. The credential store is read ONLY inside the
  // gateway/preflight; never here.
  const aiGenerateText =
    deps.aiGenerateText ??
    (deps.generationGateway
      ? (args: AiGenerateTextArgs) => facadeAiGenerateText(credentialStore, deps.generationGateway!, args)
      : undefined);

  return {
    queue_exploration: {
      description:
        "Enqueue an exploration mission against a PROMOTED target. Never runs anything — only queues; `jevitate mission run` drains the queue, and get_mission_result {id: missionId} reports its status/result. strategy: goal-based (goal|feature|route + successAssertion) | coverage | exploratory (novelty-first coverage) | adversarial (optional in-scope route glob) | feature (feature name, optional route glob); a usability review is not queueable — use run_exploration {strategy: usability}. The target's authorized origin plus its declared apiOrigins are the only reachable origins. Refuses unknown/unpromoted targets, over-ceiling budgets and invalid declared `invariants` (an optional closed spec checked around every action; probes GET/HEAD on the target origin only). Optional 'viewport' ({width,height}) or 'device' (a Playwright devices registry name, e.g. \"iPhone 13\") — mutually exclusive (#149); default: Playwright's own default viewport. An unknown device is refused before any browser opens. #255: 'recordVideo' / 'evidenceVideo' (booleans) and 'screenshots' (screens | steps) write media next to the result (listed in it) — a queued request never names a path; 'persona' names a persona in the operator's ~/.jevitate/targets.json for the target's origin (its session, never the caller's). #424: 'minEffort' {minActions, minDistinctStates} (goal-based only) — the minimum exploration before the model may conclude, capped by the budget. Same as `jevitate mission queue`.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          goal: { type: "string" },
          feature: { type: "string" },
          route: { type: "string" },
          successAssertion: { type: "object" },
          strategy: { type: "string", enum: [...MISSION_STRATEGIES] },
          budget: {
            type: "object",
            properties: {
              maxActions: { type: "number" },
              maxDecisions: { type: "number" },
              maxCandidates: { type: "number" },
            },
          },
          // App-declared invariants (#86), inline only: a closed schema (observe: dom|network|probe,
          // invariants: require|never|always). Probes are GET/HEAD on the target's own origin; a spec
          // that does not validate refuses the enqueue.
          invariants: { type: "object" },
          // Per-mission viewport/device emulation (#149) — mutually exclusive.
          viewport: {
            type: "object",
            properties: { width: { type: "number" }, height: { type: "number" } },
            required: ["width", "height"],
          },
          device: { type: "string" },
          // #255: media next to the result (a mode or a boolean — never a path) and a persona NAME.
          recordVideo: { type: "boolean" },
          screenshots: { type: "string", enum: [...QUEUED_SCREENSHOT_MODES] },
          evidenceVideo: { type: "boolean" },
          persona: { type: "string" },
          // #424 (goal-based only): the minimum exploration effort before the model may conclude.
          minEffort: {
            type: "object",
            properties: { minActions: { type: "number" }, minDistinctStates: { type: "number" } },
          },
        },
        required: ["target"],
      },
      handler: async (args) => {
        try {
          // All shape/budget/promoted-target validation is delegated to
          // `enqueueMission` (fail-closed). A refusal surfaces as a structured
          // error — NEVER a fabricated "queued" success.
          return jsonResult(await queueExploration(args));
        } catch (err) {
          return errorResult({
            error: "queue_exploration_refused",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    ...(aiGenerateText
      ? {
          ai_generate_text: {
            description:
              "Generate a single text value for a form field via the model gateway. Credential-gated: a missing key returns a typed setup_required result; the key is NEVER sent to the model or returned.",
            inputSchema: {
              type: "object",
              properties: {
                fieldLabel: { type: "string" },
                goal: { type: "string" },
                visibleContext: { type: "string" },
                history: { type: "array", items: { type: "string" } },
              },
              required: ["fieldLabel", "goal", "visibleContext"],
            },
            handler: async (args) => {
              if (
                typeof args.fieldLabel !== "string" ||
                typeof args.goal !== "string" ||
                typeof args.visibleContext !== "string"
              ) {
                return errorResult({
                  error: "invalid_args",
                  message: "ai_generate_text requires string 'fieldLabel', 'goal' and 'visibleContext'",
                });
              }
              const history =
                Array.isArray(args.history) && args.history.every((h) => typeof h === "string")
                  ? (args.history as string[])
                  : undefined;
              try {
                // The facade applies `withPreflight` — a missing credential
                // returns a typed `setup_required` precondition (the model is
                // never called), which is a legitimate result surface, not an
                // error, so the host can collect the key and retry.
                return jsonResult(
                  await aiGenerateText({
                    fieldLabel: args.fieldLabel,
                    goal: args.goal,
                    visibleContext: args.visibleContext,
                    ...(history !== undefined ? { history } : {}),
                  }),
                );
              } catch (err) {
                // A provider/SDK error can echo request internals verbatim —
                // redact any credential value and return a generic, key-free
                // message. Never surface raw provider error text.
                const raw = err instanceof Error ? err.message : String(err);
                return errorResult({
                  error: "ai_generate_failed",
                  message: redactCredentials(raw, credentialStore),
                });
              }
            },
          },
        }
      : {}),
  };
}
