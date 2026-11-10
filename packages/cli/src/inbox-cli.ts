import { readFileSync } from "node:fs";
import { isRecord } from "@jevitate/domain";
import { Command, Option } from "commander";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { commandPath } from "./cli-refusal.js";
import { FsInboxStore } from "@jevitate/inbox";
import { type BrowserLaunchFlags, type CliDeps, browserRunFromFlags, collectParam, environmentSeams, resolveInboxDir, resolveJourneysDir, withBrowserLaunchFlags } from "./cli-shared.js";
import { currentEngineInfo } from "./engine.js";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags } from "./environments.js";
import { journeyExitCode } from "@jevitate/domain";
import { EXIT_CODES, exitCodeForError } from "./exit-codes.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { approveHoldAtTerminal, holdApprovalInteractive, holdChainOf, HoldError, isHoldId, resumeHold, type ResumeHoldResult } from "./journey-hold.js";
import { chainExitCode, chainSucceeded, JourneyChainError, resumeChainHold, type JourneyChainResult } from "./journey-chain.js";
import { DONE_CHECK_FAILED_MESSAGE, doneCheckExitInput } from "./journey-done-check.js";
import { callMcpTool, mcpErrorOf, mcpToolDeps, refusalFor } from "./mcp-cli-bridge.js";

/**
 * `jevitate inbox …` (#254): the HITL inbox from the CLI — one command per MCP inbox tool, each calling
 * the SAME served handler (mcp-cli-bridge.ts) over the SAME store `jevitate mcp` and `jevitate ui`
 * use (`~/.jevitate/inbox`, or `--inbox-dir`):
 *
 *   list            → list_incoming     show <id>        → get_thread
 *   command <id>    → get_command       health           → get_site_health
 *   queue-retrieval → queue_retrieval   queue-action     → queue_action
 *   approve <id>    → approve_action    cancel <id>      → cancel_command (both refused over MCP)
 *   resume <id>     → (CLI only) continues a held run (#793)
 *
 * SM1: approving or cancelling is human-only. `inbox cancel`, and `inbox approve` of anything but a
 * held run, refuse exactly as MCP does (E_HUMAN_APPROVAL_REQUIRED, exit 64): those are answered in the
 * `jevitate ui` dashboard. #793: `inbox approve <hold id>` answers a held run, only for a person at a
 * terminal (journey-hold.ts): inside an MCP call or without a TTY on stdin and stdout it refuses the
 * same way, before reading anything.
 * `inbox command` keeps get_command's burn-after-read. A human's unread input is consumed only with
 * `--reveal`, which prints it exactly as MCP returns it; without it the command refuses
 * (E_INBOX_INPUT_PENDING) and consumes nothing, so the input is never burned unseen.
 */

const INBOX_DIR_HELP = "inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use)";
const REDACTED = "***REDACTED***";

interface InboxOpts {
  inboxDir?: string;
  json?: boolean;
  reveal?: boolean;
}

function withInboxFlags(cmd: Command): Command {
  return cmd.option("--inbox-dir <path>", INBOX_DIR_HELP).option("--json", "emit a JSON envelope");
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
  if (data.humanInput === REDACTED) lines.push("  human input: provided concurrently — consumed by this poll without --reveal; its value is not printed");
  else if (data.humanInput !== undefined) lines.push(`  human input (consumed now, burn-after-read): ${String(data.humanInput)}`);
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

/** get_command's item with the input's VALUE replaced — only for a poll without --reveal that raced a human's answer. */
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
      .description("poll one inbox item as the agent does (MCP get_command): burn-after-read — unread human input needs --reveal, which consumes and prints it"),
  ).option("--reveal", "consume the human's unread input and print it, exactly as MCP get_command returns it")
    .action(async function (this: Command, id: string) {
    const o = this.opts<InboxOpts>();
    if (o.reveal !== true) {
      // Peek without consuming: a poll that would burn unread input needs --reveal. (A bad id falls
      // through to get_command, which refuses it exactly as MCP does.)
      const store = new FsInboxStore(resolveInboxDir(deps, o.inboxDir), currentEngineInfo());
      const item = await store.get(id).catch(() => null);
      if (item?.humanInput !== undefined && item.secretConsumedAt === undefined) {
        emitJsonOrRefusal(
          program,
          fail("E_INBOX_INPUT_PENDING", `inbox item '${id}' has unread human input; reading it consumes it (burn-after-read). Rerun with --reveal to receive it`),
        );
        return;
      }
    }
    await run(this, "get_command", { id }, formatInboxCommandHuman, `no inbox item '${id}'`, o.reveal === true ? (b) => b : withoutSecretValue);
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
  const refuseAsMcp = async (cmd: Command, tool: "approve_action" | "cancel_command", verb: string, id: string): Promise<void> => {
    const { body } = await callMcpTool(mcpToolDeps(deps), tool, { id });
    const err = mcpErrorOf(body) ?? { error: "human_approval_required" };
    const refusal = refusalFor(cmd, "INBOX", { error: err.error, message: `${err.message ?? `${verb} is human-only`} — run \`jevitate ui\`` }, "");
    emitJsonOrRefusal(program, refusal);
  };
  const holdRefusal = (err: unknown): JsonEnvelope<never> =>
    err instanceof HoldError ? fail(err.code, err.message) : fail("E_INBOX_INTERNAL", err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err));
  // A hold refusal ran nothing (64), except an expired hold, which ends the run inconclusive (2).
  const holdExit = (err: unknown): number | undefined =>
    err instanceof HoldError ? (err.outcome === "inconclusive" ? EXIT_CODES.inconclusive : EXIT_CODES.usage) : undefined;

  withInboxFlags(
    inbox
      .command("approve <id>")
      .description(
        "a person at a terminal approves a held run (#793): shows what is held and asks for its id typed back; anything else is refused as MCP approve_action refuses — other inbox items are answered in `jevitate ui`",
      ),
  )
    .option("--reject", "answer the held run with a rejection instead (it then never resumes)")
    .addOption(new Option("--holds-dir <path>", "the holds directory (default: .jevitate/logs/holds)").hideHelp())
    .action(async function (this: Command, id: string) {
      const o = this.opts<InboxOpts & { reject?: boolean; holdsDir?: string }>();
      // Who may answer is decided before anything is read: an MCP call or a missing TTY learns nothing about the id.
      if (!holdApprovalInteractive(deps.approval) || !isHoldId(id)) {
        await refuseAsMcp(this, "approve_action", "approve", id);
        return;
      }
      try {
        const answered = await approveHoldAtTerminal({
          id,
          inboxDir: resolveInboxDir(deps, o.inboxDir),
          ...(o.holdsDir === undefined ? {} : { holdsDir: o.holdsDir }),
          ...(o.reject === true ? { decision: "rejected" as const } : {}),
          ...(deps.approval === undefined ? {} : { approval: deps.approval }),
        });
        const data = { id, decision: answered.answer?.decision, channel: answered.answer?.provenance.channel, at: answered.answer?.at };
        emitEnvelope(program, ok(data), {
          json: o.json === true,
          command: commandPath(this),
          human: () => `${id}: ${String(data.decision)} at a terminal\n${data.decision === "approved" ? `next: jevitate inbox resume ${id} --param <name=value> (the parameters it was held with)\n` : ""}`,
        });
      } catch (err) {
        emitJsonOrRefusal(program, holdRefusal(err), holdExit(err));
      }
    });

  withInboxFlags(
    inbox.command("cancel <id>").description("always refused (MCP cancel_command): only a human can cancel an inbox item, in `jevitate ui`"),
  ).action(async function (this: Command, id: string) {
    await refuseAsMcp(this, "cancel_command", "cancel", id);
  });

  withEnvironmentFlags(
    withBrowserLaunchFlags(withInboxFlags(
      inbox
        .command("resume <id>")
        .description(
          "continue a held run a person approved (#793), from the step it was held at — the steps before it are not run again; refused unless the Journey, the parameters, the target and the pending action all match the hold (E_HOLD_BINDING)",
        ),
    )),
  )
    .option("--journeys-dir <path>", "where the Journey is (default: the project's journeys)")
    .option("--param <name=value>", "a parameter the run was held with (repeatable): the same set, or the hold refuses", collectParam, {})
    .option("--storage-state <file>", "seed the resumed session from this Playwright storageState file")
    .option("--headed", "show the browser")
    .addOption(new Option("--holds-dir <path>", "the holds directory (default: .jevitate/logs/holds)").hideHelp())
    .action(async function (this: Command, id: string) {
      const o = this.opts<InboxOpts & BrowserLaunchFlags & { journeysDir?: string; param: Record<string, string>; storageState?: string; headed?: boolean; holdsDir?: string; env?: string; baseUrl?: string }>();
      let resumed: ResumeHoldResult;
      let chained: JourneyChainResult | undefined;
      try {
        const browser = browserRunFromFlags(o, deps.explore?.env ?? process.env);
        const environment = environmentFromFlags({ ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) }, environmentSeams(deps));
        const resumeReq: Parameters<typeof resumeHold>[0] = {
          id,
          journeysDir: resolveJourneysDir(deps, o.journeysDir),
          params: o.param,
          inboxDir: resolveInboxDir(deps, o.inboxDir),
          // #795: the job's done check is read before the pending write is repeated.
          catalogDir: resolveCatalogDir(deps.catalogDir),
          ...(environment === undefined ? {} : { environment }),
          ...(o.holdsDir === undefined ? {} : { holdsDir: o.holdsDir }),
          ...(o.storageState === undefined ? {} : { storageState: o.storageState }),
          ...(browser === undefined ? {} : { browser }),
          ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
          // §5.3: a handback or secret hold is completed by the person at this terminal.
          ...(deps.approval === undefined ? {} : { approval: deps.approval }),
        };
        // #827 (§5.3): a hold a chain's producer reached resumes the whole chain, not only the producer.
        const chain = holdChainOf(id, o.holdsDir === undefined ? {} : { holdsDir: o.holdsDir });
        if (chain === undefined) resumed = await resumeHold(resumeReq);
        else ({ resumed, chain: chained } = await resumeChainHold(resumeReq, chain));
      } catch (err) {
        if (err instanceof JourneyChainError) {
          emitJsonOrRefusal(program, fail(err.code, err.message));
          return;
        }
        if (isEnvironmentError(err)) {
          emitJsonOrRefusal(program, fail("E_INBOX_RESUME_ARGS", err.message));
          return;
        }
        emitJsonOrRefusal(program, holdRefusal(err), holdExit(err));
        return;
      }
      if (resumed.outcome === "held") {
        const data = { id, outcome: "held" as const, fromStep: resumed.fromStep, holdId: resumed.held.holdId, step: resumed.held.step, kind: resumed.held.kind, code: resumed.held.code };
        emitEnvelope(program, ok(data), {
          json: o.json === true,
          command: commandPath(this),
          exitCode: exitCodeForError(resumed.held.code),
          human: () => `${id}: resumed from step ${resumed.fromStep}, then held again at step ${data.step} (${data.kind}) as ${data.holdId}\nnext: a person runs \`jevitate inbox approve ${data.holdId}\`\n`,
        });
        return;
      }
      const r = resumed.result;
      // The result's `output` echoes bound values: a resume reports the outcome, never the values.
      const data = {
        id,
        outcome: r.outcome,
        fromStep: resumed.fromStep,
        ...("at" in r && typeof r.at === "number" ? { at: r.at } : {}),
        ...("error" in r && typeof r.error === "string" ? { error: r.error } : {}),
        ...(r.evidenceError === undefined ? {} : { evidenceError: r.evidenceError }),
        // H5: the resumed run's job verdict, as `journey run` reports it (owner decisions 2/3).
        ...(resumed.job === undefined ? {} : { job: resumed.job }),
        ...(resumed.job?.attainment === "not-achieved" && r.outcome === "ok" ? { failure: { kind: "done-check-failed", message: DONE_CHECK_FAILED_MESSAGE } } : {}),
        // #827: the rest of the chain the hold belonged to, as `journey chain` reports it (values redacted there).
        ...(chained === undefined ? {} : { chain: chained }),
      };
      emitEnvelope(program, ok(data), {
        json: o.json === true,
        command: commandPath(this),
        // H5: the job verdict folds into the exit, the resumed run's alone or the whole chain's.
        exitCode: chained === undefined ? journeyExitCode(r.outcome, doneCheckExitInput(resumed.job, resumed.doneCheckPolicy)) : chainExitCode(chained, resumed.doneCheckPolicy),
        human: () => `${id}: resumed from step ${resumed.fromStep}: ${r.outcome}${chained === undefined ? "" : `; the chain ran ${chained.runs.length} consumer run(s), ${chainSucceeded(chained) ? "all ok" : "not all ok"}`}\n`,
      });
    });
}
