import { facadeListIncoming, facadeGetCommand, facadeGetThread, facadeQueueAction, facadeQueueRetrieval, facadeApproveAction, facadeCancelCommand, facadeGetSiteHealth } from "@jevitate/mcp-facade";
import { FsInboxStore } from "@jevitate/inbox";
import { currentEngineInfo } from "../engine.js";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { jsonResult, errorResult } from "./shared.js";
import type { McpTool } from "../mcp-api.js";

/** The 8 inbox / command-queue tools. */
export function inboxTools(ctx: McpToolCtx): McpToolGroup {
  const { deps } = ctx;
  // The 8 inbox tools: the store is built lazily inside this closure (mirrors
  // `queueExploration` above) so constructing the tool set never touches
  // disk. A missing `inboxDir` is a config error (a refusal), never a silent
  // success — `inboxHandler` below catches it (and any store-layer throw,
  // e.g. `getForAgent`/`get`'s fail-closed throw on corrupt/tampered data)
  // and converts it to a typed `internal` error, never lets it fabricate a
  // success or leak an unhandled rejection out of the handler.
  const inboxStore = () => {
    if (!deps.inboxDir) {
      throw new Error("inbox tools require inboxDir to be configured");
    }
    return new FsInboxStore(deps.inboxDir, deps.engine ?? currentEngineInfo());
  };

  function inboxHandler(fn: (store: ReturnType<typeof inboxStore>, args: Record<string, unknown>) => Promise<unknown> | unknown): McpTool["handler"] {
    return async (args) => {
      try {
        return jsonResult(await fn(inboxStore(), args));
      } catch (err) {
        return errorResult({ error: "internal", message: err instanceof Error ? err.message : String(err) });
      }
    };
  }

  const idInputSchema = {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"],
  };

  const queueCommonProperties = {
    run: { type: "string" },
    journey: { type: "string" },
    step: { type: "string" },
    reason: { type: "string" },
    agent: { type: "string" },
    targetUrl: { type: "string" },
    hasScreenshot: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          severity: { type: "string", enum: ["low", "med", "high"] },
          evidence: { type: "string" },
        },
        required: ["id", "title", "severity"],
      },
    },
  };
  const queueCommonRequired = ["run", "journey", "step", "reason", "agent"];

  return {
    list_incoming: {
      description: "List pending inbox items (HITL commands awaiting a human) as InboxSummary projections.",
      inputSchema: { type: "object", properties: {} },
      handler: inboxHandler((store) => facadeListIncoming(store)),
    },
    get_command: {
      description:
        "Agent poll for one inbox item by id (burn-after-read: consumes any human-provided secret input exactly once). Returns not_found for an unknown id.",
      inputSchema: idInputSchema,
      handler: inboxHandler((store, args) => facadeGetCommand(store, args)),
    },
    get_thread: {
      description: "Get the conversation thread (agent/human messages) for one inbox item by id. Never returns secret input.",
      inputSchema: idInputSchema,
      handler: inboxHandler((store, args) => facadeGetThread(store, args)),
    },
    queue_action: {
      description:
        "Enqueue a HITL inbox item requiring a human decision — kind defaults to 'approval' ('handback'/'review' also accepted). Never resolves anything; only queues.",
      inputSchema: {
        type: "object",
        properties: { ...queueCommonProperties, kind: { type: "string", enum: ["approval", "handback", "review"] } },
        required: queueCommonRequired,
      },
      handler: inboxHandler((store, args) => facadeQueueAction(store, args)),
    },
    queue_retrieval: {
      description:
        "Enqueue a HITL 'handback' inbox item requesting the human retrieve/provide something back to the agent. Never resolves anything; only queues.",
      inputSchema: { type: "object", properties: queueCommonProperties, required: queueCommonRequired },
      handler: inboxHandler((store, args) => facadeQueueRetrieval(store, args)),
    },
    approve_action: {
      description:
        "SM1: an agent can NEVER approve an inbox item over MCP — always refuses with human_approval_required. Approval is only permitted from the local jevitate UI.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async () => errorResult(facadeApproveAction()),
    },
    cancel_command: {
      description:
        "SM1: an agent can NEVER cancel an inbox item over MCP — always refuses with human_approval_required. Cancellation is only permitted from the local jevitate UI.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async () => errorResult(facadeCancelCommand()),
    },
    get_site_health: {
      description: "Report inbox store health: ok, pending count, age of the oldest pending item, and store version.",
      inputSchema: { type: "object", properties: {} },
      handler: inboxHandler((store) => facadeGetSiteHealth(store)),
    },
  };
}
