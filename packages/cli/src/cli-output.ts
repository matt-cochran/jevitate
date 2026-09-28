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
  const goal = str(result.goalOutcome);
  // #227: `failed`/`exhausted`/`blocked` fold onto the canonical `defects-found`, but the mission's
  // own defects/hangs arrays are typically empty for these (the goal's own check failed, not a
  // discovered defect) — a "DEFECTS-FOUND … 0 defect(s)" headline self-contradicts. Lead with the
  // goal's own verdict and why instead; missionOutcome/goalOutcome stay canonical in --json (#217).
  const selfContradicting = goal === "failed" || goal === "exhausted" || goal === "blocked";
  if (selfContradicting) {
    const detail = goalFailureDetail(result);
    lines.push(`${goal.toUpperCase()}: ${strategy}${target === undefined ? "" : ` ${target}`}${detail === undefined ? "" : ` (${detail})`}`);
  } else {
    lines.push(`${outcome.toUpperCase()}: ${strategy}${target === undefined ? "" : ` ${target}`} · ${counts.join(" · ")}`);
  }
  // #217: the headline is always the canonical verdict; a goal run's own ending (and the stop that
  // ended its loop) follows it — never in its place.
  const own = str(result.outcome);
  if (goal !== undefined) {
    const stop = str(result.stop);
    lines.push(`${tag("GOAL")}${goal}${stop === undefined ? "" : ` (stop: ${stop})`}`);
  } else if (own !== undefined && own !== outcome) lines.push(`${tag("OUTCOME")}${own}`);
  const scope = scopeLine(result.scope);
  if (scope !== undefined) lines.push(`${tag("SCOPE")}${scope}`);
  for (const d of defects) lines.push(defectLine("DEFECT", d));
  for (const h of hangs) lines.push(defectLine("HANG", { ...h, kind: "hang" }));
  if (isRecord(result.failure)) {
    lines.push(`${tag("REASON")}${str(result.failure.kind) ?? "failure"}: ${str(result.failure.message) ?? ""}`);
  } else if (str(result.reason) !== undefined) {
    lines.push(`${tag("REASON")}${str(result.reason)}`);
  }
  const answer = answerLine(result.answer);
  if (answer !== undefined) lines.push(`${tag("ANSWER")}${answer}`);
  const resultPath = str(result.resultPath);
  if (resultPath !== undefined) lines.push(`${tag("RESULT")}${resultPath}`);
  const firstFp = [...gating, ...hangs].find((d) => d.fingerprint !== undefined)?.fingerprint;
  lines.push(nextHint(firstFp, resultPath));
  return `${lines.join("\n")}\n`;
}

/**
 * #224: the route scope a run used — its globs, and where they came from when the result says
 * (`--route`, or derived from the start URL).
 */
function scopeLine(scope: unknown): string | undefined {
  if (!isRecord(scope)) return undefined;
  const globs = arr(scope.routeGlobs).filter((g): g is string => typeof g === "string");
  if (globs.length === 0) return undefined;
  const source = scope.source === "route" ? " (--route)" : scope.source === "start-url" ? " (derived from the start URL; pass --route to change it)" : "";
  return `${globs.join(", ")}${source}`;
}

/**
 * #216: a find-out's answer is `{ text, evidence }` — its text plus where it came from (the page's
 * text or a form field's value, and the page), from the grounded evidence.
 */
function answerLine(answer: unknown): string | undefined {
  if (!isRecord(answer)) return str(answer);
  const text = str(answer.text);
  if (text === undefined) return undefined;
  const sources: string[] = [];
  for (const e of arr(answer.evidence).filter(isRecord)) {
    const control = str(e.control);
    const where = e.source === "control-value" ? (control === undefined ? "a form field" : `form field "${control}"`) : "page text";
    const path = str(e.url)?.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    const source = path === undefined ? where : `${where} on ${path === "" ? "/" : path}`;
    if (!sources.includes(source)) sources.push(source);
  }
  return sources.length === 0 ? text : `${text}  (from ${sources.join("; ")})`;
}

/** Why a goal's own check failed/gave up/ran out of budget: its `failure` detail, else `reason`. */
function goalFailureDetail(result: Record<string, unknown>): string | undefined {
  if (isRecord(result.failure)) {
    return str(result.failure.message) ?? str(result.failure.kind);
  }
  return str(result.reason);
}

function nextHint(fingerprint: string | undefined, resultPath: string | undefined): string {
  if (fingerprint !== undefined && resultPath !== undefined) {
    return `next: jevitate verify-fix ${fingerprint} --result ${resultPath} (after a fix) · jevitate ledger add ${resultPath} ${fingerprint} · jevitate report`;
  }
  return "next: jevitate report";
}

/** A verdict with a goal run's own ending beside it: `clean (goal: succeeded)`. */
function verdictText(v: Record<string, unknown>): string {
  const outcome = str(v.missionOutcome) ?? str(v.outcome) ?? "unknown";
  const goal = str(v.goalOutcome);
  return goal === undefined || goal === outcome ? outcome : `${outcome} (goal: ${goal})`;
}

/**
 * `explore --repeat/--persona`'s aggregate (multi-run) result (#226: the #217 contract): the canonical
 * verdict as the headline (a goal's own ending beside it, never in its place), why it is what it is,
 * each persona's verdict and each run's with its reason, the persona diff's status differences, the
 * agreed and flaky findings, and the find-out answer(s).
 */
export function formatMultiRunHuman(result: unknown): string {
  if (!isRecord(result)) return "";
  const findings = arr(result.findings).filter(isRecord);
  const flaky = arr(result.flaky).filter(isRecord);
  const cells = arr(result.cells).filter(isRecord);
  const personas = cells.filter((c) => str(c.persona) !== undefined);
  const outcome = str(result.missionOutcome) ?? str(result.outcome) ?? "unknown";
  const lines = [
    `${outcome.toUpperCase()}: ${str(result.strategy) ?? "explore"} ×${String(result.repeat ?? "?")}${personas.length > 0 ? ` · ${personas.length} personas` : ""} · ${findings.length} agreed finding(s) · ${flaky.length} flaky`,
  ];
  const goal = str(result.goalOutcome);
  if (goal !== undefined) lines.push(`${tag("GOAL")}${goal}`);
  // #220: why the multi-run is inconclusive (interrupted, runs pending, or a run broke).
  const reason = str(result.reason);
  if (reason !== undefined) lines.push(`${tag("REASON")}${reason}`);
  for (const c of personas) lines.push(`${tag("PERSONA")}${str(c.persona)}  ${verdictText(c)}`);
  const answers: Array<{ label: string; text: string }> = [];
  for (const c of cells) {
    const persona = str(c.persona);
    for (const r of arr(c.runs).filter(isRecord)) {
      const label = `${persona === undefined ? "" : `${persona} `}run ${String(r.index ?? "?")}`;
      const why = str(r.reason);
      lines.push(`${tag("RUN")}${label}  ${verdictText(r)}${why === undefined ? "" : `  ${why}`}`);
      const answer = answerLine(r.answer);
      if (answer !== undefined) answers.push({ label, text: answer });
    }
  }
  const diff = isRecord(result.diff) ? result.diff : undefined;
  const rbac = new Set(arr(diff?.rbacCandidates).filter(isRecord).map((c) => str(c.request)));
  for (const d of arr(diff?.statusDiffs).filter(isRecord)) {
    const request = str(d.request) ?? "";
    const statuses = isRecord(d.statuses) ? Object.entries(d.statuses) : [];
    const text = statuses.map(([p, ss]) => `${arr(ss).map(String).join("/")} for ${p}`).join("; ");
    lines.push(`${tag("DIFF")}${request}: ${text}  (advisory${rbac.has(request) ? ": RBAC candidate" : ""})`);
  }
  // #213: a persona whose runs never observed the app is not compared — never read as an access difference.
  for (const n of arr(diff?.notCompared).filter(isRecord)) {
    lines.push(`${tag("DIFF")}${str(n.persona) ?? "?"}: not compared — its runs never observed the app (${str(n.reason) ?? "environment"})`);
  }
  for (const f of findings) {
    lines.push(`${tag("FINDING")}${[str(f.fingerprint) ?? "(no fingerprint)", str(f.kind) ?? "", str(f.stability) ?? "", str(f.title) ?? ""].filter((p) => p !== "").join("  ")}`);
  }
  for (const f of flaky) {
    lines.push(`${tag("FLAKY")}${[str(f.fingerprint) ?? "(no fingerprint)", str(f.kind) ?? "", str(f.stability) ?? "", str(f.title) ?? ""].filter((p) => p !== "").join("  ")}`);
  }
  // #216/#226: the find-out answer — once when every run found the same one, else per run.
  const distinct = new Set(answers.map((a) => a.text));
  if (personas.length === 0 && distinct.size === 1) lines.push(`${tag("ANSWER")}${answers[0]!.text}`);
  else for (const a of answers) lines.push(`${tag("ANSWER")}${a.label}: ${a.text}`);
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
  // #227: nothing chosen (an empty ledger, or fingerprints/ticket matching nothing) verified
  // nothing — never "FIXED: 0 entries" (a false pass at a glance).
  if (entries.length === 0) return "NOTHING VERIFIED: the ledger has no matching entries\nnext: jevitate ledger add <result.json> <fingerprint>\n";
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

/** The regression id a committed `<id>.recording.json` path names. */
function idFromRecordingPath(p: string): string | undefined {
  const base = p.split(/[\\/]/).pop();
  return base?.endsWith(".recording.json") ? base.slice(0, -".recording.json".length) : undefined;
}

/** `regression capture` (#227): a committed regression, or a failure too flaky to commit — never the raw envelope. */
export function formatRegressionCaptureHuman(result: unknown): string {
  if (!isRecord(result)) return "";
  if (result.skipped === "flaky") {
    const rate = typeof result.rate === "number" ? result.rate : undefined;
    const lines = [
      `FLAKY: the failure did not reproduce reliably enough to commit${rate === undefined ? "" : ` (reproduced ${Math.round(rate * 100)}% of attempts)`}`,
      "next: capture again, or pin a more reliable step with --fingerprint",
    ];
    return `${lines.join("\n")}\n`;
  }
  const recordingPath = str(result.recordingPath);
  const metaPath = str(result.metaPath);
  const id = recordingPath === undefined ? undefined : idFromRecordingPath(recordingPath);
  const lines = [`CAPTURED: ${recordingPath ?? "(no recording path)"}`];
  if (metaPath !== undefined) lines.push(`${tag("META")}${metaPath}`);
  lines.push(id === undefined ? "next: jevitate regression run <id>" : `next: jevitate regression run ${id}`);
  return `${lines.join("\n")}\n`;
}

/** `regression run` (#227): the verdict, why, and what to do about it — matches `verify-fix`'s shape. */
export function formatRegressionRunHuman(report: unknown): string {
  if (!isRecord(report)) return "";
  const id = str(report.id) ?? "";
  const verdict = str(report.verdict) ?? "unknown";
  const reason = str(report.reason);
  const lines = [`${verdict.toUpperCase()}: ${id}`];
  if (reason !== undefined) lines.push(`${tag("REASON")}${reason}`);
  lines.push(
    verdict === "fixed"
      ? "next: jevitate report"
      : verdict === "reproduces"
        ? `next: fix it, then jevitate regression run ${id}`
        : `next: jevitate regression run ${id} (re-check)`,
  );
  return `${lines.join("\n")}\n`;
}

/** `baseline tag` (#227). */
export function formatBaselineTagHuman(data: unknown): string {
  if (!isRecord(data)) return "";
  const name = str(data.name) ?? "";
  const path = str(data.path);
  const runs = arr(data.runs).filter(isRecord);
  const lines = [`TAGGED: ${name} · ${runs.length} run(s)`];
  if (path !== undefined) lines.push(`${tag("PATH")}${path}`);
  for (const r of runs) {
    lines.push(`${tag("RUN")}${[str(r.runId) ?? "", str(r.mode) ?? "", str(r.target) ?? "", str(r.missionOutcome) ?? ""].filter((p) => p !== "").join("  ")}`);
  }
  lines.push(`next: jevitate report --baseline ${name} · jevitate check --baseline ${name}`);
  return `${lines.join("\n")}\n`;
}

/** `baseline list` (#227): every tag, or a next step when there are none yet. */
export function formatBaselineListHuman(data: unknown): string {
  const list = arr(data).filter(isRecord);
  if (list.length === 0) return "no baselines yet — tag one with `jevitate baseline tag <name> <runs...>`\n";
  const lines = [`${list.length} baseline(s)`];
  for (const b of list) {
    lines.push(`${tag("BASELINE")}${[str(b.name) ?? "", str(b.createdAt) ?? "", `${String(b.runs ?? 0)} run(s)`].filter((p) => p !== "").join("  ")}`);
  }
  lines.push("next: jevitate baseline show <name>");
  return `${lines.join("\n")}\n`;
}

/** `baseline show` (#227). */
export function formatBaselineShowHuman(data: unknown): string {
  if (!isRecord(data)) return "";
  const name = str(data.name) ?? "";
  const createdAt = str(data.createdAt);
  const runs = arr(data.runs).filter(isRecord);
  const lines = [`${name}${createdAt === undefined ? "" : `  (tagged ${createdAt})`} · ${runs.length} run(s)`];
  for (const r of runs) {
    lines.push(`${tag("RUN")}${[str(r.runId) ?? "", str(r.mode) ?? "", str(r.target) ?? "", str(r.missionOutcome) ?? ""].filter((p) => p !== "").join("  ")}`);
  }
  lines.push(`next: jevitate report --baseline ${name}`);
  return `${lines.join("\n")}\n`;
}
