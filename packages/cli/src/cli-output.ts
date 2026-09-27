import type { Command } from "commander";
import type { JsonEnvelope } from "./envelope.js";
import { EXIT_CODES, exitCodeForEnvelope, isUsageErrorCode } from "./exit-codes.js";

/**
 * Human vs machine output for the CLI (#210). One rule for every command that has both:
 *
 *  - `--json`: exactly one line, the `{v, ok, data | error}` envelope, on stdout — the machine
 *    contract, byte-for-byte what it always was.
 *  - otherwise: a short human summary on stdout (a success) or an `error <CODE>: <message>` line on
 *    stderr (a refusal) — never raw JSON.
 *
 * The human style follows `jevitate check`'s: an upper-case tag padded to a column, then the detail;
 * the last lines say where the full result is and what to run next (`next: …`).
 *
 * The exit code always comes from exit-codes.ts: the caller's verdict code when it has one,
 * otherwise the envelope's class (0 ok · 64 usage error · 2 the command failed).
 */

export interface EmitOptions<T> {
  /** `--json` was passed: print the envelope. */
  readonly json: boolean;
  /** The verdict's exit code (a mission's `exitCode`, a check's, a verify-fix's); default: the envelope's class. */
  readonly exitCode?: number;
  /** The human rendering of a successful envelope's `data`; default: nothing but the exit code. */
  readonly human?: (data: T) => string;
  /** The command, named in a usage error's `--help` hint (e.g. `explore`, `ledger add`). */
  readonly command?: string;
}

export function emitEnvelope<T>(program: Command, envelope: JsonEnvelope<T>, opts: EmitOptions<T>): void {
  const out = program.configureOutput();
  if (opts.json) {
    out.writeOut?.(`${JSON.stringify(envelope)}\n`);
  } else if (envelope.ok) {
    const text = opts.human === undefined ? "" : opts.human(envelope.data as T);
    if (text !== "") out.writeOut?.(text.endsWith("\n") ? text : `${text}\n`);
  } else {
    out.writeErr?.(formatErrorHuman(envelope.error ?? { code: "E_UNKNOWN", message: "unknown error" }, opts.command));
  }
  process.exitCode = opts.exitCode ?? exitCodeForEnvelope(envelope);
}

/** `error E_EXPLORE_ARGS: --url is required` (+ a `--help` hint for a usage error). */
export function formatErrorHuman(error: { readonly code: string; readonly message: string }, command?: string): string {
  const hint = isUsageErrorCode(error.code) ? `next: jevitate ${command ?? "<command>"} --help\n` : "";
  return `error ${error.code}: ${error.message}\n${hint}`;
}

const TAG = 8;
const tag = (t: string): string => t.padEnd(TAG);

interface DefectLike {
  readonly fingerprint?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly advisory?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function defectLine(label: string, d: DefectLike): string {
  const parts = [d.fingerprint ?? "(no fingerprint)", d.kind ?? "", d.title ?? ""].filter((p) => p !== "");
  return `${tag(label)}${parts.join("  ")}${d.advisory === true ? "  (advisory)" : ""}`;
}

/**
 * A mission result (any strategy) as a human summary: the verdict, the defects and hangs by
 * fingerprint, why a broken run proved nothing, where the result file is, and what to run next.
 */
export function formatMissionHuman(result: unknown): string {
  if (!isRecord(result)) return "";
  const lines: string[] = [];
  const outcome = str(result.missionOutcome) ?? str(result.outcome) ?? "unknown";
  const strategy = str(result.strategy) ?? "explore";
  const target = isRecord(result.target) ? str(result.target.seedUrl) : undefined;
  const defects = arr(result.defects).filter(isRecord) as DefectLike[];
  const hangs = arr(result.hangs).filter(isRecord) as DefectLike[];
  const gating = defects.filter((d) => d.advisory !== true);
  const counts = [`${gating.length} defect(s)`, `${hangs.length} hang(s)`];
  const advisory = defects.length - gating.length;
  if (advisory > 0) counts.push(`${advisory} advisory`);
  lines.push(`${outcome.toUpperCase()}: ${strategy}${target === undefined ? "" : ` ${target}`} · ${counts.join(" · ")}`);
  const own = str(result.outcome);
  if (own !== undefined && own !== outcome) lines.push(`${tag("OUTCOME")}${own}`);
  for (const d of defects) lines.push(defectLine("DEFECT", d));
  for (const h of hangs) lines.push(defectLine("HANG", { ...h, kind: "hang" }));
  if (isRecord(result.failure)) {
    lines.push(`${tag("REASON")}${str(result.failure.kind) ?? "failure"}: ${str(result.failure.message) ?? ""}`);
  } else if (str(result.reason) !== undefined) {
    lines.push(`${tag("REASON")}${str(result.reason)}`);
  }
  const answer = str(result.answer);
  if (answer !== undefined) lines.push(`${tag("ANSWER")}${answer}`);
  const resultPath = str(result.resultPath);
  if (resultPath !== undefined) lines.push(`${tag("RESULT")}${resultPath}`);
  const firstFp = [...gating, ...hangs].find((d) => d.fingerprint !== undefined)?.fingerprint;
  lines.push(nextHint(firstFp, resultPath));
  return `${lines.join("\n")}\n`;
}

function nextHint(fingerprint: string | undefined, resultPath: string | undefined): string {
  if (fingerprint !== undefined && resultPath !== undefined) {
    return `next: jevitate verify-fix ${fingerprint} --result ${resultPath} (after a fix) · jevitate ledger add ${resultPath} ${fingerprint} · jevitate report`;
  }
  return "next: jevitate report";
}

/** `explore --repeat/--persona`'s aggregate (multi-run) result. */
export function formatMultiRunHuman(result: unknown): string {
  if (!isRecord(result)) return "";
  const findings = arr(result.findings).filter(isRecord);
  const flaky = arr(result.flaky).filter(isRecord);
  const lines = [
    `${(str(result.outcome) ?? "unknown").toUpperCase()}: ${str(result.strategy) ?? "explore"} ×${String(result.repeat ?? "?")} · ${findings.length} agreed finding(s) · ${flaky.length} flaky`,
  ];
  // #220: why the multi-run is inconclusive (interrupted, runs pending, or a run broke).
  const reason = str(result.reason);
  if (reason !== undefined) lines.push(`${tag("REASON")}${reason}`);
  for (const f of findings) {
    lines.push(`${tag("FINDING")}${[str(f.fingerprint) ?? "(no fingerprint)", str(f.kind) ?? "", str(f.stability) ?? "", str(f.title) ?? ""].filter((p) => p !== "").join("  ")}`);
  }
  for (const f of flaky) {
    lines.push(`${tag("FLAKY")}${[str(f.fingerprint) ?? "(no fingerprint)", str(f.kind) ?? "", str(f.stability) ?? "", str(f.title) ?? ""].filter((p) => p !== "").join("  ")}`);
  }
  const resultPath = str(result.resultPath);
  if (resultPath !== undefined) lines.push(`${tag("RESULT")}${resultPath}`);
  lines.push("next: jevitate report");
  return `${lines.join("\n")}\n`;
}

/** `verify-fix`: the verdict, why, and what to do about it. */
export function formatVerifyFixHuman(report: unknown): string {
  if (!isRecord(report)) return "";
  const verdict = str(report.verdict) ?? "unknown";
  const fp = str(report.fingerprint) ?? "";
  const lines = [`${verdict.toUpperCase()}: ${fp}${str(report.title) === undefined ? "" : `  ${str(report.title)}`}`];
  const reason = str(report.reason);
  if (reason !== undefined) lines.push(`${tag("REASON")}${reason}`);
  const attempts = arr(report.attempts).filter(isRecord);
  if (attempts.length > 0) {
    const fired = attempts.filter((a) => a.fired === true).length;
    lines.push(`${tag("REPLAYS")}${attempts.length} fresh replay(s), signal fired in ${fired}`);
  }
  lines.push(
    verdict === "fixed"
      ? "next: jevitate report"
      : verdict === "still-reproduces"
        ? `next: fix it, then jevitate verify-fix ${fp}`
        : `next: jevitate verify-fix ${fp} --replays 5 (re-check)`,
  );
  return `${lines.join("\n")}\n`;
}

/** `ledger list`. */
export function formatLedgerListHuman(listed: { readonly entries: readonly object[] }): string {
  const data = { entries: listed.entries as readonly Record<string, unknown>[] };
  if (data.entries.length === 0) return "0 ledger entries\nnext: jevitate ledger add <result.json> <fingerprint>\n";
  const lines = [`${data.entries.length} ledger entr${data.entries.length === 1 ? "y" : "ies"}`];
  for (const e of data.entries) {
    const parts = [str(e.fingerprint) ?? "", str(e.kind) ?? "", str(e.ticket) === undefined ? "" : `[${str(e.ticket)}]`, str(e.title) ?? ""];
    lines.push(`${tag("ENTRY")}${parts.filter((p) => p !== "").join("  ")}`);
  }
  lines.push("next: jevitate ledger verify");
  return `${lines.join("\n")}\n`;
}

/** `ledger add`. */
export function formatLedgerAddHuman(added: object): string {
  const data = added as Record<string, unknown>;
  const fp = str(data.fingerprint) ?? "";
  const parts = [fp, str(data.kind) ?? "", str(data.ticket) === undefined ? "" : `[${str(data.ticket)}]`, str(data.title) ?? ""];
  return [
    `${data.updated === true ? "UPDATED" : "ADDED"}: ${parts.filter((p) => p !== "").join("  ")}`,
    `${tag("ENTRY")}${str(data.entryPath) ?? ""}`,
    `next: jevitate verify-fix ${fp} (re-check from the ledger) · jevitate ledger verify`,
    "",
  ].join("\n");
}

/** `ledger verify`. */
export function formatLedgerVerifyHuman(verified: object): string {
  const data = verified as Record<string, unknown>;
  const entries = arr(data.entries).filter(isRecord);
  const summary = isRecord(data.summary) ? data.summary : {};
  const counts = Object.entries(summary)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([k, n]) => `${String(n)} ${k}`);
  const code = typeof data.exitCode === "number" ? data.exitCode : EXIT_CODES.inconclusive;
  const lines = [`${code === EXIT_CODES.ok ? "FIXED" : "NOT FIXED"}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${counts.join(" · ") || "nothing to verify"}`];
  for (const e of entries) {
    const parts = [str(e.fingerprint) ?? "", str(e.ticket) === undefined ? "" : `[${str(e.ticket)}]`, str(e.title) ?? "", str(e.reason) ?? ""];
    lines.push(`${tag((str(e.verdict) ?? "unknown").toUpperCase())}${parts.filter((p) => p !== "").join("  ")}`);
  }
  const open = entries.find((e) => e.verdict === "still-reproduces")?.fingerprint;
  lines.push(typeof open === "string" ? `next: fix it, then jevitate verify-fix ${open}` : "next: jevitate report");
  return `${lines.join("\n")}\n`;
}

/**
 * `init`'s key report: per feature, which keys are configured — never "collected: []", which read
 * as "keys missing" when every key was already set (#210). Collection either stores every missing
 * key or fails closed, so after it every required key is configured. Names only, never a value.
 */
export function formatInitKeysHuman(keys: Readonly<Record<string, { readonly required: readonly string[]; readonly collected: readonly string[] }>>): string {
  return Object.entries(keys)
    .map(([feature, { required, collected }]) => {
      const detail = collected.length > 0 ? `collected ${collected.join(", ")} now` : "already configured";
      return `keys: ${feature} ready — ${required.length}/${required.length} configured (${detail})`;
    })
    .join("\n");
}
