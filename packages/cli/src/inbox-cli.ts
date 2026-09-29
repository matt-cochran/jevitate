import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { commandPath } from "./cli-refusal.js";
import { type CliDeps, resolveInboxDir } from "./cli-shared.js";
import { callMcpTool, mcpErrorOf, mcpToolDeps, refusalFor } from "./mcp-cli-bridge.js";

/**
 * `jevitate inbox …` (#254): the HITL inbox from the CLI — one command per MCP inbox tool, each calling
 * the SAME served handler (mcp-cli-bridge.ts) over the SAME store `jevitate mcp` and `jevitate ui`
 * use (`~/.jevitate/inbox`, or `--inbox-dir`):
 *
 *   list            → list_incoming     show <id>        → get_thread
 *   command <id>    → get_command       health           → get_site_health
 *   queue-retrieval → queue_retrieval   queue-action     → queue_action
 *   approve <id>    → approve_action    cancel <id>      → cancel_command (both always refused)
 *
 * SM1: approving or cancelling is human-only, in the `jevitate ui` dashboard — `inbox approve` /
 * `inbox cancel` refuse exactly as MCP does (E_HUMAN_APPROVAL_REQUIRED, exit 64).
 * `inbox command` keeps get_command's burn-after-read: it consumes any human-provided input, whose
 * VALUE is never printed (a secret never reaches a terminal, a log or a model through the CLI).
 */

const INBOX_DIR_HELP = "inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use)";
const REDACTED = "***REDACTED***";

interface InboxOpts {
  inboxDir?: string;
  json?: boolean;
}

function withInboxFlags(cmd: Command): Command {
  return cmd.option("--inbox-dir <path>", INBOX_DIR_HELP).option("--json", "emit a JSON envelope");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ageText(sec: unknown): string {
  const s = typeof sec === "number" && Number.isFinite(sec) ? sec : 0;
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function formatInboxListHuman(data: unknown): string {
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  if (items.length === 0) return "no pending inbox items\n";
  const lines = items.map(
    (i) => `${String(i.id)}  ${String(i.kind)}  ${String(i.status)}  ${ageText(i.ageSec)}  ${String(i.run)} / ${String(i.journey)} / ${String(i.step)}  (${String(i.agent)})`,
  );
  return `${lines.join("\n")}\nnext: jevitate inbox show <id> · approve or cancel in \`jevitate ui\`\n`;
}

export function formatInboxThreadHuman(id: string): (data: unknown) => string {
  return (data) => {
    const thread = isRecord(data) && Array.isArray(data.thread) ? data.thread.filter(isRecord) : [];
    if (thread.length === 0) return `${id}: no messages yet\n`;
    return `${thread.map((e) => `${String(e.at)}  ${String(e.author)}: ${String(e.text)}`).join("\n")}\n`;
  };
}

export function formatInboxCommandHuman(data: unknown): string {
  if (!isRecord(data)) return "";
  const lines = [`${String(data.id)}  ${String(data.kind)}  ${String(data.status)}`, `  ${String(data.run)} / ${String(data.journey)} / ${String(data.step)}: ${String(data.reason)}`];
  if (isRecord(data.resolution)) lines.push(`  resolution: ${String(data.resolution.decision)} by ${String(data.resolution.by)} at ${String(data.resolution.at)}`);
  if (data.humanInput !== undefined) lines.push("  human input: provided — consumed now (burn-after-read); its value is never printed");
  else if (data.secretConsumedAt !== undefined) lines.push(`  human input: already consumed at ${String(data.secretConsumedAt)}`);
  return `${lines.join("\n")}\n`;
}

export function formatInboxHealthHuman(data: unknown): string {
  if (!isRecord(data)) return "";
  const build = [data.version, data.commit].filter((v) => typeof v === "string").join(" ");
  return `inbox ${data.ok === true ? "ok" : "NOT ok"}: ${String(data.pending)} pending, oldest ${ageText(data.oldestPendingAgeSec)} · build ${build}\n`;
}

function formatQueuedHuman(data: unknown): string {
  if (!isRecord(data)) return "";
  return `queued inbox item ${String(data.id)} (${String(data.status)})\nnext: a human answers it in \`jevitate ui\`; poll with \`jevitate inbox command ${String(data.id)}\`\n`;
}

/** get_command's item with any human-provided input's VALUE replaced — the CLI never prints a secret. */
function withoutSecretValue(body: unknown): unknown {
  if (!isRecord(body) || body.humanInput === undefined) return body;
  return { ...body, humanInput: REDACTED };
}

export function registerInboxCommands(program: Command, deps: CliDeps): void {
  const inbox = program.command("inbox").description("the HITL inbox from the CLI — the same tools `jevitate mcp` serves (approve/cancel stay human-only in `jevitate ui`)");

  /** Calls MCP `tool` and prints its result (or its typed error as the matching CLI refusal). */
  const run = async (
    cmd: Command,
    tool: string,
    args: Record<string, unknown>,
    human: (data: unknown) => string,
    fallback: string,
    project: (body: unknown) => unknown = (b) => b,
  ): Promise<void> => {
    const o = cmd.opts<InboxOpts>();
    const json = o.json === true;
    let envelope: JsonEnvelope<unknown>;
    try {
      const { body } = await callMcpTool(mcpToolDeps(deps, { inboxDir: resolveInboxDir(deps, o.inboxDir) }), tool, args);
      const err = mcpErrorOf(body);
      envelope = err === undefined ? ok(project(body)) : refusalFor(cmd, "INBOX", err, fallback);
    } catch (e) {
      envelope = fail("E_INBOX_INTERNAL", e instanceof Error ? e.message : String(e));
    }
    if (envelope.ok) emitEnvelope(program, envelope, { json, human, command: commandPath(cmd) });
    else emitJsonOrRefusal(program, envelope);
  };

  withInboxFlags(inbox.command("list").description("list pending inbox items (MCP list_incoming)")).action(async function (this: Command) {
    await run(this, "list_incoming", {}, formatInboxListHuman, "cannot list the inbox");
  });

  withInboxFlags(inbox.command("show <id>").description("an inbox item's conversation thread — never its secret input (MCP get_thread)")).action(async function (
    this: Command,
    id: string,
  ) {
    await run(this, "get_thread", { id }, formatInboxThreadHuman(id), `no inbox item '${id}'`);
  });

  withInboxFlags(
    inbox
      .command("command <id>")
      .description("poll one inbox item as the agent does (MCP get_command): burn-after-read — consumes any human-provided input once; its value is never printed"),
  ).action(async function (this: Command, id: string) {
    await run(this, "get_command", { id }, formatInboxCommandHuman, `no inbox item '${id}'`, withoutSecretValue);
  });

  withInboxFlags(inbox.command("health").description("inbox store health: pending count, oldest pending age, build (MCP get_site_health)")).action(async function (
    this: Command,
  ) {
    await run(this, "get_site_health", {}, formatInboxHealthHuman, "cannot read inbox health");
  });

  const queueFlags = (cmd: Command): Command =>
    withInboxFlags(
      cmd
        .option("--run <id>", "the run this item belongs to (required)")
        .option("--journey <id>", "the Journey (required)")
        .option("--step <step>", "the step it stopped at (required)")
        .option("--reason <text>", "what the human is asked for (required)")
        .option("--agent <name>", "who is asking (required)")
        .option("--target-url <url>", "the page it concerns")
        .option("--has-screenshot", "a screenshot accompanies the item")
        .option("--findings <file>", "a JSON file holding an array of {id, title, severity: low|med|high, evidence?}"),
    );

  const queueArgs = (cmd: Command): Record<string, unknown> | undefined => {
    const o = cmd.opts<{ run?: string; journey?: string; step?: string; reason?: string; agent?: string; targetUrl?: string; hasScreenshot?: boolean; findings?: string; kind?: string }>();
    let findings: unknown;
    if (o.findings !== undefined) {
      try {
        findings = JSON.parse(readFileSync(o.findings, "utf8"));
      } catch (e) {
        const code = `E_${commandPath(cmd).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_INPUT`;
        emitJsonOrRefusal(program, fail(code, `cannot read --findings ${o.findings}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
        return undefined;
      }
    }
    // Only what was given: the facade validates (required fields, finding shape) — never re-decided here.
    return {
      ...(o.run === undefined ? {} : { run: o.run }),
      ...(o.journey === undefined ? {} : { journey: o.journey }),
      ...(o.step === undefined ? {} : { step: o.step }),
      ...(o.reason === undefined ? {} : { reason: o.reason }),
      ...(o.agent === undefined ? {} : { agent: o.agent }),
      ...(o.targetUrl === undefined ? {} : { targetUrl: o.targetUrl }),
      ...(o.hasScreenshot === true ? { hasScreenshot: true } : {}),
      ...(findings === undefined ? {} : { findings }),
      ...(o.kind === undefined ? {} : { kind: o.kind }),
    };
  };

  queueFlags(
    inbox.command("queue-retrieval").description("ask a human to provide something back to the agent — a 'handback' item; only queues (MCP queue_retrieval)"),
  ).action(async function (this: Command) {
    const args = queueArgs(this);
    if (args !== undefined) await run(this, "queue_retrieval", args, formatQueuedHuman, "cannot queue the item");
  });

  queueFlags(
    inbox
      .command("queue-action")
      .description("ask a human for a decision — an 'approval' item by default; only queues (MCP queue_action)")
      .addOption(new Option("--kind <kind>", "approval (default) | handback | review").choices(["approval", "handback", "review"])),
  ).action(async function (this: Command) {
    const args = queueArgs(this);
    if (args !== undefined) await run(this, "queue_action", args, formatQueuedHuman, "cannot queue the item");
  });

  // SM1: human-only. Registered so the CLI names the refusal (and where to go instead) rather than
  // pretending the capability does not exist — they call the same always-refusing MCP handlers.
  for (const [name, tool, verb] of [
    ["approve", "approve_action", "approve"],
    ["cancel", "cancel_command", "cancel"],
  ] as const) {
    withInboxFlags(
      inbox.command(`${name} <id>`).description(`always refused (MCP ${tool}): only a human can ${verb} an inbox item, in \`jevitate ui\``),
    ).action(async function (this: Command, id: string) {
      const { body } = await callMcpTool(mcpToolDeps(deps), tool, { id });
      const err = mcpErrorOf(body) ?? { error: "human_approval_required" };
      const refusal = refusalFor(this, "INBOX", { error: err.error, message: `${err.message ?? `${verb} is human-only`} — run \`jevitate ui\`` }, "");
      emitJsonOrRefusal(program, refusal);
    });
  }
}
