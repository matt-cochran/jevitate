import { AsyncLocalStorage } from "node:async_hooks";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  APPROVAL_CHANNELS,
  type ApprovalChannel,
  type ApprovalProvenance,
  type ApprovalViolation,
  type ApprovalsReport,
} from "@jevitate/journey";
import type { Catalog } from "./catalog.js";

/**
 * #437 — approval provenance and the human confirmation on every approval path (`journey promote`,
 * `demo approve`, `persona approve`, `job approve`, and the `--accept-*` waivers given with them).
 *
 * Three layers, each guaranteeing exactly what it says (docs/catalog.md "What 'human approval'
 * guarantees"):
 * 1. provenance (DETECTION): every approval records how it was made — `tty` | `non-interactive` |
 *    `mcp` | `ci`, the NAMES of agent/CI markers found in the environment, the OS user. A determined
 *    process can fake all of it.
 * 2. the typed confirmation (FRICTION): a CLI approval needs a real TTY and the item's id (or the
 *    first 8 characters of its content hash) typed back; without one it is refused
 *    (`E_APPROVAL_NEEDS_HUMAN`, exit 64). `--non-interactive-approval "<reason>"` is the scripted
 *    escape hatch: allowed, and recorded as `non-interactive` (or `ci`) — never as a person's.
 * 3. git review (ENFORCEMENT): CODEOWNERS on `.jevitate/` + branch protection, and
 *    `jevitate check --require-approvals` in CI (`approvalsReport` below).
 */

/**
 * Agent-harness markers: environment variables a coding agent's shell sets. Only the NAME of a
 * marker is ever recorded (never its value). Kept conservative and documented in docs/catalog.md:
 * - `CLAUDECODE`, `CLAUDE_CODE_*` — Claude Code (`CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, …)
 * - `CODEX_*` — OpenAI Codex CLI (`CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, …)
 * - `CURSOR_*` — Cursor (`CURSOR_AGENT` in its agent's terminal; `CURSOR_TRACE_ID` in its editor)
 * - `AIDER_*` — aider
 * - `GEMINI_CLI` — Gemini CLI
 * A marker is a hint, not a verdict: a person may run a terminal inside an editor that sets one.
 */
export const AGENT_ENV_MARKERS: readonly { readonly name: string; readonly prefix: boolean }[] = [
  { name: "CLAUDECODE", prefix: false },
  { name: "CLAUDE_CODE_", prefix: true },
  { name: "CODEX_", prefix: true },
  { name: "CURSOR_", prefix: true },
  { name: "AIDER_", prefix: true },
  { name: "GEMINI_CLI", prefix: false },
];

/** CI markers: an escape-hatch approval under one of these is recorded as channel `ci`. */
export const CI_ENV_MARKERS: readonly string[] = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "JENKINS_URL", "TF_BUILD"];

const STDIN_NOT_TTY = "stdin-not-tty";
const STDOUT_NOT_TTY = "stdout-not-tty";
const MAX_SIGNALS = 20;

function isSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/** The agent/CI marker NAMES set in `env`, then `stdin-not-tty` / `stdout-not-tty`. Never a value. */
export function detectAgentSignals(env: Readonly<Record<string, string | undefined>>, tty: { readonly stdin: boolean; readonly stdout: boolean }): string[] {
  const names = Object.keys(env)
    .filter((k) => isSet(env[k]) && /^[A-Za-z0-9_-]{1,64}$/.test(k))
    .filter((k) => CI_ENV_MARKERS.includes(k) || AGENT_ENV_MARKERS.some((m) => (m.prefix ? k.startsWith(m.name) : k === m.name)))
    .sort();
  return [...names.slice(0, MAX_SIGNALS), ...(tty.stdin ? [] : [STDIN_NOT_TTY]), ...(tty.stdout ? [] : [STDOUT_NOT_TTY])];
}

/** The OS user name — never an email (a `user@domain` login keeps only its user part). */
export function osUserName(): string | undefined {
  try {
    const name = userInfo().username.split("@")[0]?.trim() ?? "";
    return name === "" ? undefined : name.slice(0, 256);
  } catch {
    return undefined; // no passwd entry (a container's arbitrary uid): the provenance names no user
  }
}

// ── The MCP channel ──────────────────────────────────────────────────────────────────────────
const mcpScope = new AsyncLocalStorage<true>();

/** Runs `fn` as an MCP tool call: every approval it makes is recorded as channel `mcp` (mcp-cli-runner.ts). */
export function runAsMcpInvocation<T>(fn: () => Promise<T>): Promise<T> {
  return mcpScope.run(true, fn);
}

/** True inside `runAsMcpInvocation`. */
export function inMcpInvocation(): boolean {
  return mcpScope.getStore() === true;
}

// ── Confirmation ─────────────────────────────────────────────────────────────────────────────

/** The seam a test injects (`CliDeps.approval`); production reads the real process. */
export interface ApprovalDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY?: () => boolean;
  readonly stdoutIsTTY?: () => boolean;
  /** Asks one question on the terminal and returns the typed line. */
  readonly prompt?: (question: string) => Promise<string>;
  readonly user?: () => string | undefined;
}

/** What a person confirms: the item, the content hash its sheet shows, and the waivers given with it. */
export interface ApprovalRequest {
  readonly kind: "journey" | "demo" | "persona" | "job";
  readonly id: string;
  readonly contentHash: string;
  readonly waivers: readonly { readonly flag: string; readonly reason: string; readonly detail?: string }[];
  /** #453: a self-heal proposal being accepted — shown to the person before they confirm. */
  readonly proposal?: { readonly id: string; readonly baseHash: string; readonly steps: readonly { readonly number: number; readonly before: string; readonly after: string }[] };
}

/** Confirms an approval (or refuses it) and returns how it was made. */
export type ApprovalConfirm = (request: ApprovalRequest) => Promise<ApprovalProvenance>;

/** A CLI approval with no TTY to confirm on, and no `--non-interactive-approval`. Exit 64. */
export class ApprovalNeedsHumanError extends Error {
  readonly code = "E_APPROVAL_NEEDS_HUMAN";
}

/** The typed confirmation did not match: nothing was approved. Exit 64. */
export class ApprovalNotConfirmedError extends Error {
  readonly code = "E_APPROVAL_NOT_CONFIRMED";
}

/** A bad `--non-interactive-approval` / `--allow-channels` argument. Exit 64. */
export class ApprovalArgsError extends Error {
  readonly code = "E_APPROVAL_ARGS";
}

/** The refusal (code, message) of an approval error, or null for any other error. */
export function approvalRefusal(err: unknown): { code: string; message: string } | null {
  if (err instanceof ApprovalNeedsHumanError || err instanceof ApprovalNotConfirmedError || err instanceof ApprovalArgsError) return { code: err.code, message: err.message };
  return null;
}

function approveCommand(r: ApprovalRequest): string {
  return r.kind === "journey" ? `jevitate journey promote ${r.id}` : r.kind === "demo" ? `jevitate demo approve ${r.id}` : `jevitate ${r.kind} approve ${r.id}`;
}

/** The refusal text: why, and how a person approves. */
export function needsHumanMessage(r: ApprovalRequest): string {
  return (
    `approving ${r.kind === "demo" ? "demo" : r.kind} '${r.id}' needs a person: there is no interactive terminal to confirm it on (stdin/stdout is not a TTY), so nothing was approved. ` +
    `A person approves by running \`${approveCommand(r)}\` in their own terminal and typing the ${r.kind === "demo" ? "Journey" : r.kind} id (or the first 8 characters of the content hash its review sheet shows) when asked. ` +
    `A coding agent hands this approval to a person — it never approves its own work. ` +
    `A scripted setup may pass --non-interactive-approval "<reason>": it is recorded as a non-interactive approval, never as a person's, and \`jevitate check --require-approvals\` fails it.`
  );
}

function confirmed(answer: string, r: ApprovalRequest): boolean {
  const a = answer.trim();
  if (a === "") return false;
  if (a === r.id) return true;
  const lower = a.toLowerCase();
  return lower.length >= 8 && /^[0-9a-f]+$/.test(lower) && r.contentHash.toLowerCase().startsWith(lower);
}

/** The real terminal prompt: the question on stderr (stdout may carry --json), the answer from stdin. */
async function terminalPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolveAnswer) => {
      rl.once("close", () => resolveAnswer("")); // Ctrl-D / a closed stdin: an empty answer, so not confirmed
      rl.question(question).then(resolveAnswer, () => resolveAnswer(""));
    });
  } finally {
    rl.close();
  }
}

function provenanceOf(channel: ApprovalChannel, deps: ApprovalDeps | undefined, reason?: string): ApprovalProvenance {
  const env = deps?.env ?? process.env;
  const signals = detectAgentSignals(env, {
    stdin: deps?.stdinIsTTY?.() ?? process.stdin.isTTY === true,
    stdout: deps?.stdoutIsTTY?.() ?? process.stdout.isTTY === true,
  });
  const user = deps?.user === undefined ? osUserName() : deps.user();
  return { channel, agentSignals: signals, ...(user === undefined ? {} : { user }), ...(reason === undefined ? {} : { reason }) };
}

/** True when a CI marker is among the detected signals. */
function underCi(signals: readonly string[]): boolean {
  return signals.some((s) => CI_ENV_MARKERS.includes(s));
}

export interface ApprovalConfirmOptions {
  /** `--non-interactive-approval "<reason>"`: approve without a TTY, recorded as `non-interactive` (or `ci`). */
  readonly nonInteractiveReason?: string;
}

/** Validates `--non-interactive-approval`: a reason is required (it is recorded). */
export function checkNonInteractiveReason(reason: string | undefined): void {
  if (reason !== undefined && reason.trim() === "") throw new ApprovalArgsError('--non-interactive-approval needs a reason (it is recorded with the approval): --non-interactive-approval "<why no person confirms this>"');
}

/**
 * The confirmation every CLI approval path runs just before it writes:
 * - inside an MCP tool call: no prompt, recorded as `mcp` (an agent's approval);
 * - `--non-interactive-approval "<reason>"`: no prompt, recorded as `non-interactive` (or `ci` under a CI marker) with the reason;
 * - otherwise a real TTY is required (else `E_APPROVAL_NEEDS_HUMAN`), and the person types the id or
 *   the first 8 characters of the content hash — once for the approval, once per waiver
 *   (else `E_APPROVAL_NOT_CONFIRMED`); recorded as `tty`.
 */
export function makeApprovalConfirm(deps: ApprovalDeps | undefined, opts: ApprovalConfirmOptions = {}): ApprovalConfirm {
  return async (r) => {
    if (inMcpInvocation()) return provenanceOf("mcp", deps);
    const reason = opts.nonInteractiveReason?.trim();
    if (reason !== undefined) {
      checkNonInteractiveReason(reason);
      const p = provenanceOf("non-interactive", deps, reason);
      return underCi(p.agentSignals) ? { ...p, channel: "ci" } : p;
    }
    const interactive = (deps?.stdinIsTTY?.() ?? process.stdin.isTTY === true) && (deps?.stdoutIsTTY?.() ?? process.stdout.isTTY === true);
    if (!interactive) throw new ApprovalNeedsHumanError(needsHumanMessage(r));
    const ask = deps?.prompt ?? terminalPrompt;
    const what = r.kind === "demo" ? `demo '${r.id}' (promotes Journey '${r.id}')` : `${r.kind} '${r.id}'`;
    const proposalText =
      r.proposal === undefined
        ? ""
        : `\nProposed revision ${r.proposal.id} (self-heal, against ${r.proposal.baseHash.slice(0, 8)}…):\n${r.proposal.steps.map((st) => `  step ${st.number}: ${st.before}\n       -> ${st.after}`).join("\n")}`;
    const first = await ask(
      `${proposalText}\nApprove ${what}, content hash ${r.contentHash.slice(0, 8)}…?\nType its id (${r.id}) or the first 8 characters of its content hash to approve — anything else cancels: `,
    );
    if (!confirmed(first, r)) throw new ApprovalNotConfirmedError(`the typed confirmation did not match ${r.kind} '${r.id}' or its content hash — nothing was approved`);
    for (const w of r.waivers) {
      const answer = await ask(`Waiver ${w.flag} "${w.reason}"${w.detail === undefined || w.detail === "" ? "" : ` (${w.detail})`}: type the id or the hash prefix again to confirm this waiver: `);
      if (!confirmed(answer, r)) throw new ApprovalNotConfirmedError(`the waiver ${w.flag} was not confirmed — nothing was approved`);
    }
    return provenanceOf("tty", deps);
  };
}

/**
 * #453: how a REJECTION was made (`journey promote --reject-proposal`). Rejecting is fail-closed, so
 * it needs no typed confirmation: inside an MCP call it is `mcp`, at a terminal `tty`, otherwise
 * `non-interactive` (or `ci`) with the reason recorded.
 */
export function rejectionProvenance(deps: ApprovalDeps | undefined, rejectionReason: string): ApprovalProvenance {
  if (inMcpInvocation()) return provenanceOf("mcp", deps);
  const interactive = (deps?.stdinIsTTY?.() ?? process.stdin.isTTY === true) && (deps?.stdoutIsTTY?.() ?? process.stdout.isTTY === true);
  if (interactive) return provenanceOf("tty", deps);
  const p = provenanceOf("non-interactive", deps, `rejected without a terminal: ${rejectionReason}`.slice(0, 2000));
  return underCi(p.agentSignals) ? { ...p, channel: "ci" } : p;
}

/**
 * The provenance of an approval made through the programmatic API with no confirmation step
 * (a caller of `promoteJourney` / `approveCatalogItem` that passes no `confirm`): recorded as
 * `non-interactive`, so it never passes for a person's approval.
 */
export function programmaticProvenance(): ApprovalProvenance {
  return provenanceOf("non-interactive", undefined, "approved through the programmatic API (no confirmation step)");
}

// ── Describing ───────────────────────────────────────────────────────────────────────────────

/** One phrase: "approved at a terminal by mc (typed confirmation)", "approved non-interactively (likely an agent: CLAUDECODE)", … */
export function describeProvenance(p: ApprovalProvenance | undefined): string {
  if (p === undefined) return "approved before provenance was recorded (channel unknown)";
  const markers = p.agentSignals.filter((s) => s !== STDIN_NOT_TTY && s !== STDOUT_NOT_TTY);
  const by = p.user === undefined ? "" : ` by ${p.user}`;
  const reason = p.reason === undefined ? "" : ` — reason: "${p.reason}"`;
  switch (p.channel) {
    case "tty":
      return `approved at a terminal${by} (typed confirmation)${markers.length === 0 ? "" : ` — agent markers present: ${markers.join(", ")}`}`;
    case "mcp":
      return `approved over MCP — an agent's approval${markers.length === 0 ? "" : ` (${markers.join(", ")})`}`;
    case "ci":
      return `approved non-interactively in CI${markers.length === 0 ? "" : ` (${markers.join(", ")})`}${reason}`;
    case "non-interactive":
      return `approved non-interactively${markers.length === 0 ? "" : ` (likely an agent: ${markers.join(", ")})`}${by}${reason}`;
  }
}

// ── Enforcement: --require-approvals ─────────────────────────────────────────────────────────

/** `--allow-channels tty,ci` → the channels; default `tty`. An unknown channel is refused. */
export function parseAllowedChannels(list: string | undefined): ApprovalChannel[] {
  if (list === undefined) return ["tty"];
  const parts = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) throw new ApprovalArgsError(`--allow-channels needs at least one of ${APPROVAL_CHANNELS.join(", ")}`);
  for (const p of parts) {
    if (!(APPROVAL_CHANNELS as readonly string[]).includes(p)) throw new ApprovalArgsError(`--allow-channels: unknown channel '${p}' (one of ${APPROVAL_CHANNELS.join(", ")})`);
  }
  return [...new Set(parts)] as ApprovalChannel[];
}

/**
 * #437: every recorded approval in the catalogs (promoted Journeys, approved personas and jobs) and
 * how it was made; with `allowed`, the violations — a promoted Journey with no approval, an approval
 * that is stale (the item changed since), one recorded before provenance existed, or one made over
 * a channel not allowed.
 */
export function approvalsReport(catalogs: readonly Catalog[], allowed?: readonly ApprovalChannel[]): ApprovalsReport {
  const records: ApprovalsReport["records"] = [];
  const violations: ApprovalViolation[] = [];
  const seen = new Set<string>();
  const judge = (kind: ApprovalViolation["kind"], id: string, at: string | undefined, stale: boolean, provenance: ApprovalProvenance | undefined, missing: boolean): void => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      kind,
      id,
      ...(at === undefined ? {} : { at }),
      stale,
      ...(provenance === undefined ? {} : { provenance }),
      how: missing ? "promoted with no recorded approval" : describeProvenance(provenance),
    });
    if (allowed === undefined) return;
    if (missing) {
      violations.push({ kind, id, problem: "missing", message: `${kind} '${id}' is promoted with no recorded approval — a person approves it: ${kind === "journey" ? `jevitate journey promote ${id}` : `jevitate ${kind} approve ${id}`}` });
      return;
    }
    if (stale) violations.push({ kind, id, problem: "stale", message: `${kind} '${id}' changed since its approval (content hash mismatch) — it needs re-review and a new approval` });
    if (provenance === undefined) {
      violations.push({ kind, id, problem: "no-provenance", message: `${kind} '${id}' was approved before provenance was recorded — a person re-approves it at a terminal` });
    } else if (!allowed.includes(provenance.channel)) {
      violations.push({
        kind,
        id,
        problem: "channel",
        message: `${kind} '${id}': ${describeProvenance(provenance)} — channel '${provenance.channel}' is not allowed (allowed: ${allowed.join(", ")}); a person re-approves it at a terminal`,
      });
    }
  };
  for (const c of catalogs) {
    for (const p of c.personas) if (p.approval !== undefined) judge("persona", p.id, p.approval.at, p.status === "stale", p.approval.provenance, false);
    for (const j of c.jobs) if (j.approval !== undefined) judge("job", j.id, j.approval.at, j.status === "stale", j.approval.provenance, false);
    for (const j of c.journeys) {
      if (!j.promoted) continue;
      if (j.approval === undefined) judge("journey", j.id, undefined, false, undefined, true);
      else judge("journey", j.id, j.approval.at, j.approval.contentHash !== j.contentHash, j.approval.provenance, false);
    }
  }
  return { records, ...(allowed === undefined ? {} : { requirement: { allowedChannels: [...allowed], violations } }) };
}

/** The approvals section of `catalog status` (text). */
export function renderApprovals(report: ApprovalsReport): string {
  const lines = ["", "APPROVALS"];
  if (report.records.length === 0) lines.push("  - none recorded");
  for (const r of report.records) lines.push(`  - ${r.kind} ${r.id}: ${r.how}${r.at === undefined ? "" : ` (${r.at})`}${r.stale ? " — STALE" : ""}`);
  if (report.requirement !== undefined) {
    const v = report.requirement.violations;
    lines.push("", `REQUIRE APPROVALS (allowed: ${report.requirement.allowedChannels.join(", ")}): ${v.length === 0 ? "PASS" : `FAIL — ${v.length} violation(s)`}`);
    for (const x of v) lines.push(`  - ${x.message}`);
  }
  return `${lines.join("\n")}\n`;
}
