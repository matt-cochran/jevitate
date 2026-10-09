import type { Feature } from "@jevitate/ai-core";
import { featureKeysBody, type KeySourceReport, type KeyVerificationReport } from "./key-report.js";
import type { Command } from "commander";
import type { JsonEnvelope } from "./envelope.js";
import { currentRunMetadata, stampRunMetadata } from "./run-metadata.js";
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
  // #426: a tagged run's envelope carries its tags and structured target, like its persisted result.
  if (envelope.ok && currentRunMetadata() !== undefined) envelope = { ...envelope, data: stampRunMetadata(envelope.data) as T };
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
// #213: a label at or past the column width (e.g. STILL-REPRODUCES, BASELINE) must still get a
// separator — padEnd alone is a no-op once the label reaches TAG, which glues it to the next value.
const tag = (t: string): string => (t.length >= TAG ? `${t} ` : t.padEnd(TAG));

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

/** #250: a defect's evidence (clip, key screenshots, or why none) as indented lines. */
function evidenceLines(d: unknown): string[] {
  if (!isRecord(d) || !isRecord(d.evidence)) return [];
  const e = d.evidence;
  const out: string[] = [];
  const mark = str(e.signal) === undefined ? "" : ` — step ${typeof e.failingStep === "number" ? e.failingStep : "?"} marked: ${str(e.signal)}`;
  if (str(e.videoPath) !== undefined) out.push(`${tag("  CLIP")}${str(e.videoPath)}${mark}${e.reproduced === false ? " (did not fire on this replay)" : ""}`);
  for (const sh of arr(e.screenshots)) if (str(sh) !== undefined) out.push(`${tag("  SHOT")}${str(sh)}`);
  if (str(e.skipped) !== undefined) out.push(`${tag("  NO CLIP")}${str(e.skipped)}`);
  for (const c of arr(e.captureSkips)) if (str(c) !== undefined) out.push(`${tag("  SKIPPED")}${str(c)}`);
  return out;
}

/** #251: the run's `--screenshots` (count, index, refused captures). */
function screenshotLines(r: Record<string, unknown>): string[] {
  const index = str(r.screenshotIndex);
  if (index === undefined) return [];
  const skipped = arr(r.screenshotsSkipped).filter(isRecord);
  return [
    `${tag("SHOTS")}${arr(r.screenshotPaths).length} screenshot(s) — ${index}`,
    ...skipped.map((k) => `${tag("  SKIPPED")}step ${typeof k.step === "number" ? k.step : "?"}: ${str(k.reason) ?? ""}`),
  ];
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
  // #423: only when the run found no gating defect — with defects, the canonical headline counts them.
  const selfContradicting = (goal === "failed" || goal === "exhausted" || goal === "blocked") && gating.length === 0;
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
    // #423: the goal's structured miss reason beside its ending.
    const why = [str(result.goalReason), stop === undefined ? undefined : `stop: ${stop}`].filter((s): s is string => s !== undefined);
    lines.push(`${tag("GOAL")}${goal}${why.length === 0 ? "" : ` (${why.join(", ")})`}`);
  } else if (own !== undefined && own !== outcome) lines.push(`${tag("OUTCOME")}${own}`);
  // #421/#423: the defect verdict by kind, orthogonal to the goal's (none when the run found none).
  if (isRecord(result.defectOutcome) && isRecord(result.defectOutcome.byKind)) {
    const kinds = Object.entries(result.defectOutcome.byKind).flatMap(([k, n]) => (typeof n === "number" && n > 0 ? [`${k} ${n}`] : []));
    lines.push(`${tag("DEFECTS")}${kinds.length === 0 ? "none" : kinds.join(" · ")}`);
  }
  const scope = scopeLine(result.scope);
  if (scope !== undefined) lines.push(`${tag("SCOPE")}${scope}`);
  // #293: where a journey-anchored run branched off its Journey.
  if (isRecord(result.branch) && str(result.branch.journeyId) !== undefined) {
    const b = result.branch;
    lines.push(`${tag("BRANCH")}journey ${str(b.journeyId)} after step ${String(b.step)}${str(b.anchor) === undefined ? "" : ` (anchor ${str(b.anchor)})`}`);
  }
  // #213: the --storage-state session was not honoured (the run started on a sign-in page).
  if (isRecord(result.sessionLost) && str(result.sessionLost.reason) !== undefined) lines.push(`${tag("WARNING")}${str(result.sessionLost.reason)}`);
  for (const d of defects) lines.push(defectLine("DEFECT", d), ...evidenceLines(d));
  for (const h of hangs) lines.push(defectLine("HANG", { ...h, kind: "hang" }));
  // #422: environment/config faults and expected validation errors — named, never counted as defects.
  const envCauses = isRecord(result.environmentFaults) ? arr(result.environmentFaults.causes).filter(isRecord) : [];
  for (const c of envCauses) lines.push(`${tag("ENV-FAULT")}${causeText(c)} (fix in setup; not a defect)`);
  for (const c of arr(result.expectedValidation).filter(isRecord)) lines.push(`${tag("EXPECTED")}${causeText(c)} (expected validation; not a defect)`);
  if (isRecord(result.failure)) {
    lines.push(`${tag("REASON")}${str(result.failure.kind) ?? "failure"}: ${str(result.failure.message) ?? ""}`);
    // #398: a stale journey prefix shows what the page showed, so "unavailable" reads differently from "clicked too early".
    if (isRecord(result.failure.page) && typeof result.failure.page.text === "string") {
      lines.push(`${tag("PAGE")}the page showed: "${result.failure.page.text}" (${str(result.failure.page.url) ?? ""})`);
    }
  } else if (str(result.reason) !== undefined) {
    lines.push(`${tag("REASON")}${str(result.reason)}`);
  }
  for (const l of uxLines(result)) lines.push(l);
  lines.push(...locatorHealthLines(result.locatorHealth));
  lines.push(...deltaLines(result));
  const answer = answerLine(result.answer);
  if (answer !== undefined) lines.push(`${tag("ANSWER")}${answer}`);
  lines.push(...partialReportLines(result.partialReport));
  const depth = depthLine(result.depth);
  if (depth !== undefined) lines.push(`${tag("DEPTH")}${depth}`);
  // #424: the warnings about the verdict (a minimum effort capped by the budget, a vacuous check).
  for (const w of arr(result.checkWarnings)) if (str(w) !== undefined) lines.push(`${tag("WARNING")}${str(w)}`);
  // #245: the run's --record-video files.
  for (const v of arr(result.videoPaths)) if (str(v) !== undefined) lines.push(`${tag("VIDEO")}${str(v)}`);
  lines.push(...screenshotLines(result));
  const resultPath = str(result.resultPath);
  if (resultPath !== undefined) lines.push(`${tag("RESULT")}${resultPath}`);
  const firstFp = [...gating, ...hangs].find((d) => d.fingerprint !== undefined)?.fingerprint;
  lines.push(nextHint(firstFp, resultPath));
  return `${lines.join("\n")}\n`;
}

/**
 * #470: a run's / report's locator health (`result.locatorHealth`, the compact form) as human lines —
 * the one-line summary, then the top fixes for the app. Advisory: nothing here gates. Empty when the
 * result carries none, or when every step is on a stable locator (only the summary then).
 */
export function locatorHealthLines(health: unknown, top = 3): string[] {
  if (!isRecord(health) || typeof health.stable !== "number" || typeof health.brittle !== "number") return [];
  const line = str(health.line) ?? `${health.stable}/${health.stable + health.brittle} steps on stable locators; ${health.brittle} brittle`;
  const lines = [`${tag("LOCATORS")}${line}`];
  const fixes = arr(health.suggestions).filter(isRecord);
  for (const f of fixes.slice(0, top)) {
    const fix = str(f.fix);
    if (fix === undefined) continue;
    const steps = typeof f.steps === "number" ? f.steps : arr(f.occurrences).length;
    lines.push(`${tag("FIX")}${fix}${steps > 1 ? ` (${steps} steps)` : ""}`);
  }
  if (fixes.length > top) lines.push(`${tag("FIX")}… ${fixes.length - top} more: jevitate locator-health`);
  return lines;
}

/** `<rule>: <source> "<message>" ×N` — one classified backend-log cause (#422). */
function causeText(c: Record<string, unknown>): string {
  const count = typeof c.count === "number" && c.count > 1 ? ` ×${c.count}` : "";
  return `${str(c.ruleId) ?? "?"}: ${str(c.source) ?? "?"} "${str(c.message) ?? ""}"${count}`;
}

/** Most per-step delta lines the human output shows (the latest ones; `--json` has every step). */
const HUMAN_DELTA_STEPS = 8;

/**
 * #303 (`--action-deltas`): what each action changed — one short line per step that carries a delta
 * (the latest few), after a verdict count. Nothing at all when the run recorded none.
 */
function deltaLines(result: Record<string, unknown>): string[] {
  const steps = arr(result.transcript)
    .filter(isRecord)
    .filter((e) => isRecord(e.delta));
  if (steps.length === 0) return [];
  const verdicts = new Map<string, number>();
  for (const e of steps) {
    const v = str((e.delta as Record<string, unknown>).verdict) ?? "?";
    verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
  }
  const out = [`${tag("DELTAS")}${steps.length} action(s): ${[...verdicts].map(([v, n]) => `${n} ${v}`).join(", ")}`];
  for (const e of steps.slice(-HUMAN_DELTA_STEPS)) {
    const d = e.delta as Record<string, unknown>;
    const first = arr(d.changes).filter(isRecord).map((c) => str(c.text)).find((t) => t !== undefined);
    const what = first ?? arr(d.announcements).map(str).find((t) => t !== undefined) ?? str(d.why) ?? "";
    const line = `step ${typeof e.step === "number" ? e.step : "?"} ${str(d.action) ?? ""}: ${str(d.verdict) ?? "?"}${what === "" ? "" : ` — ${what}`}`;
    out.push(`${tag("DELTA")}${line.length > 160 ? `${line.slice(0, 159)}…` : line}`);
  }
  return out;
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
 * #213: a usability run's UX findings in its summary — how many, the appendix and suppressed counts,
 * and the top few (severity, rubric item, route, observation) — or why there are none (analysis
 * unavailable). Nothing for other strategies.
 */
function uxLines(result: Record<string, unknown>): string[] {
  if (result.strategy !== "usability") return [];
  const report = result.report;
  if (!isRecord(report)) {
    const why = str(result.analysisUnavailable);
    return [`${tag("UX")}no UX findings: ${why === undefined ? "the review produced no report" : `analysis unavailable (${why})`}`];
  }
  const findings = arr(report.findings).filter(isRecord);
  const appendix = arr(report.heuristicAppendix).length;
  const suppressed = isRecord(report.suppressed) && typeof report.suppressed.total === "number" ? report.suppressed.total : 0;
  const extra = [appendix > 0 ? `${appendix} heuristic-only in the appendix` : "", suppressed > 0 ? `${suppressed} suppressed` : ""].filter((x) => x !== "");
  const lines = [`${tag("UX")}${findings.length} UX finding(s)${extra.length === 0 ? "" : ` (${extra.join(", ")})`}${str(result.reportPath) === undefined ? "" : ` — report: ${str(result.reportPath)}`}`];
  const TOP = 3;
  for (const f of findings.slice(0, TOP)) {
    const obs = str(f.observation) ?? "";
    // #198: a verified claim names its claim type (and its boxed screenshot) instead of the rubric id.
    const claim = isRecord(f.claim) ? str(f.claim.type) : undefined;
    const shot = isRecord(f.screenshot) ? str(f.screenshot.path) : undefined;
    lines.push(`${tag("")}- [${str(f.severity) ?? "?"}] ${claim ?? str(f.rubricItemId) ?? "?"} ${str(f.route) ?? ""}: ${obs.length > 100 ? `${obs.slice(0, 99)}…` : obs}${shot === undefined ? "" : ` (screenshot: ${shot})`}`);
  }
  if (findings.length > TOP) lines.push(`${tag("")}  … and ${findings.length - TOP} more in the report`);
  return lines;
}

/**
 * #424: how deep a goal run went — "4 distinct state(s) on 4 page(s), 3 action(s), 0 form(s) submitted"
 * plus the minimum effort and whether it was met.
 */
function depthLine(depth: unknown): string | undefined {
  if (!isRecord(depth) || typeof depth.distinctStates !== "number") return undefined;
  const n = (k: string): string => (typeof depth[k] === "number" ? String(depth[k]) : "?");
  const base = `${n("distinctStates")} distinct state(s) on ${n("distinctPages")} page(s), ${n("actions")} action(s), ${n("formsSubmitted")} form(s) submitted`;
  const m = depth.minimum;
  if (!isRecord(m)) return base;
  return `${base} · minimum ${String(m.minActions)} action(s) / ${String(m.minDistinctStates)} state(s) (${str(m.source) ?? "?"}): ${m.met === true ? "met" : "NOT met"}`;
}

/** Pages / lines per page the human summary shows of a partial report (`--json` has all of it). */
const HUMAN_PARTIAL_STATES = 8;
const HUMAN_PARTIAL_LINES = 3;

/**
 * #424: a find-out that could not ground an answer — per page it visited, what it saw (the page's own
 * text) and what it tried, then the grounded claims of its rejected reports.
 */
function partialReportLines(report: unknown): string[] {
  if (!isRecord(report)) return [];
  const states = arr(report.states).filter(isRecord);
  if (states.length === 0) return [];
  const out = [`${tag("PARTIAL")}no grounded answer — what the run saw and tried on ${states.length} page(s) (observed evidence only)`];
  for (const st of states.slice(0, HUMAN_PARTIAL_STATES)) {
    const name = str(st.title) ?? str(st.heading);
    out.push(`${tag("")}${str(st.url) ?? "?"}${name === undefined ? "" : ` — ${name}`}`);
    for (const l of arr(st.seen).map(str).filter((x): x is string => x !== undefined).slice(0, HUMAN_PARTIAL_LINES)) out.push(`${tag("")}  seen: "${l}"`);
    const tried = arr(st.tried).filter(isRecord);
    if (tried.length > 0) {
      const t = tried.map((a) => `${str(a.op) ?? "?"} ${str(a.control) ?? ""} → ${a.ok === true ? "" : "failed: "}${str(a.result) ?? ""}`.replace(/\s+/g, " "));
      out.push(`${tag("")}  tried: ${t.slice(0, 4).join("; ")}${t.length > 4 ? `; +${t.length - 4} more` : ""}`);
    }
  }
  if (states.length > HUMAN_PARTIAL_STATES) out.push(`${tag("")}… and ${states.length - HUMAN_PARTIAL_STATES} more page(s) (--json)`);
  for (const c of arr(report.claims).filter(isRecord).slice(0, 3)) out.push(`${tag("")}grounded claim: ${str(c.claim) ?? ""} ("${str(c.quote) ?? ""}")`);
  return out;
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
    const where =
      e.source === "control-value"
        ? control === undefined ? "a form field" : `form field "${control}"`
        : e.source === "control-inventory" ? "the observed controls" : "page text";
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
  const base = `${str(result.strategy) ?? "explore"} ×${String(result.repeat ?? "?")}${personas.length > 0 ? ` · ${personas.length} personas` : ""}`;
  const goal = str(result.goalOutcome);
  // #230: the same #227 rule, here for the multi-run aggregate — a failed/exhausted/blocked goal
  // every run agreed on folds onto the canonical defects-found, but the agreed findings are
  // typically empty for these (every run's OWN check failed, not a discovered defect); a
  // "DEFECTS-FOUND … 0 agreed finding(s)" headline self-contradicts. Lead with the goal's own
  // verdict instead; missionOutcome/goalOutcome stay canonical in --json.
  const selfContradicting = (goal === "failed" || goal === "exhausted" || goal === "blocked") && findings.length === 0;
  const lines = [selfContradicting ? `${goal.toUpperCase()}: ${base}` : `${outcome.toUpperCase()}: ${base} · ${findings.length} agreed finding(s) · ${flaky.length} flaky`];
  if (goal !== undefined) lines.push(`${tag("GOAL")}${goal}`);
  // #220: why the multi-run is inconclusive (interrupted, runs pending, or a run broke).
  const reason = str(result.reason);
  if (reason !== undefined) lines.push(`${tag("REASON")}${reason}`);
  for (const c of personas) {
    lines.push(`${tag("PERSONA")}${str(c.persona)}  ${verdictText(c)}`);
    // #213: a persona whose session was lost did not test as that persona — said, never silent.
    const lost = str(c.sessionLost);
    if (lost !== undefined) lines.push(`${tag("WARNING")}${str(c.persona)}: session lost — ${lost}`);
  }
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

/**
 * `verify-fix`: the verdict, why, and what to do about it.
 * #230: `opts.result` is the `--result` the user passed (not the ledger fallback's own path) — a
 * re-check hint must carry it too, or (with no ledger entry for this fingerprint at that path) the
 * follow-up `verify-fix` fails to find the repro material.
 */
export function formatVerifyFixHuman(report: unknown, opts: { readonly result?: string } = {}): string {
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
  // #245: the replays' --record-video files.
  for (const v of arr(report.videoPaths)) if (str(v) !== undefined) lines.push(`${tag("VIDEO")}${str(v)}`);
  // #250: the before/after pair for the PR.
  if (isRecord(report.evidence)) {
    const ev = report.evidence;
    const before = isRecord(ev.before) ? str(ev.before.videoPath) : undefined;
    lines.push(`${tag("BEFORE")}${before ?? str(ev.beforeMissing) ?? "no clip"}`);
    const after = isRecord(ev.after) ? ev.after : undefined;
    lines.push(`${tag("AFTER")}${str(after?.videoPath) ?? str(after?.skipped) ?? "no clip"}`);
    for (const sh of arr(after?.screenshots)) if (str(sh) !== undefined) lines.push(`${tag("  SHOT")}${str(sh)}`);
    for (const c of arr(after?.captureSkips)) if (str(c) !== undefined) lines.push(`${tag("  SKIPPED")}${str(c)}`);
  }
  lines.push(...screenshotLines(report));
  const resultFlag = opts.result === undefined ? "" : ` --result ${opts.result}`;
  lines.push(
    verdict === "fixed"
      ? "next: jevitate report"
      : verdict === "still-reproduces"
        ? `next: fix it, then jevitate verify-fix ${fp}${resultFlag}`
        : `next: jevitate verify-fix ${fp}${resultFlag} --replays 5 (re-check)`,
  );
  return `${lines.join("\n")}\n`;
}

/** `ledger list`. #230: `opts.dir` is the `--dir` the user passed — the follow-up hints must carry it too. */
export function formatLedgerListHuman(listed: { readonly entries: readonly object[] }, opts: { readonly dir?: string } = {}): string {
  const data = { entries: listed.entries as readonly Record<string, unknown>[] };
  const dirFlag = opts.dir === undefined ? "" : ` --dir ${opts.dir}`;
  if (data.entries.length === 0) return `0 ledger entries\nnext: jevitate ledger add <result.json> <fingerprint>${dirFlag}\n`;
  const lines = [`${data.entries.length} ledger entr${data.entries.length === 1 ? "y" : "ies"}`];
  for (const e of data.entries) {
    const parts = [str(e.fingerprint) ?? "", str(e.kind) ?? "", str(e.ticket) === undefined ? "" : `[${str(e.ticket)}]`, str(e.title) ?? ""];
    lines.push(`${tag("ENTRY")}${parts.filter((p) => p !== "").join("  ")}`);
  }
  lines.push(`next: jevitate ledger verify${dirFlag}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `ledger add`. #230: `opts.dir` is the `--dir` the user passed. `verify-fix`'s equivalent flag is
 * named `--regressions-dir` (same directory, a ledger's own `--dir`), so the hint uses that name.
 */
export function formatLedgerAddHuman(added: object, opts: { readonly dir?: string } = {}): string {
  const data = added as Record<string, unknown>;
  const fp = str(data.fingerprint) ?? "";
  const parts = [fp, str(data.kind) ?? "", str(data.ticket) === undefined ? "" : `[${str(data.ticket)}]`, str(data.title) ?? ""];
  const regressionsDirFlag = opts.dir === undefined ? "" : ` --regressions-dir ${opts.dir}`;
  const dirFlag = opts.dir === undefined ? "" : ` --dir ${opts.dir}`;
  return [
    `${data.updated === true ? "UPDATED" : "ADDED"}: ${parts.filter((p) => p !== "").join("  ")}`,
    `${tag("ENTRY")}${str(data.entryPath) ?? ""}`,
    `next: jevitate verify-fix ${fp}${regressionsDirFlag} (re-check from the ledger) · jevitate ledger verify${dirFlag}`,
    "",
  ].join("\n");
}

/** `ledger verify`. #230: `opts.dir` is the `--dir` the user passed (see `formatLedgerAddHuman`). */
export function formatLedgerVerifyHuman(verified: object, opts: { readonly dir?: string } = {}): string {
  const data = verified as Record<string, unknown>;
  const entries = arr(data.entries).filter(isRecord);
  const dirFlag = opts.dir === undefined ? "" : ` --dir ${opts.dir}`;
  // #227: nothing chosen (an empty ledger, or fingerprints/ticket matching nothing) verified
  // nothing — never "FIXED: 0 entries" (a false pass at a glance).
  if (entries.length === 0) return `NOTHING VERIFIED: the ledger has no matching entries\nnext: jevitate ledger add <result.json> <fingerprint>${dirFlag}\n`;
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
  const regressionsDirFlag = opts.dir === undefined ? "" : ` --regressions-dir ${opts.dir}`;
  lines.push(typeof open === "string" ? `next: fix it, then jevitate verify-fix ${open}${regressionsDirFlag}` : "next: jevitate report");
  return `${lines.join("\n")}\n`;
}

/**
 * `init`'s key report: per feature, which keys are configured — never "collected: []", which read
 * as "keys missing" when every key was already set (#210). Collection either stores every missing
 * key or fails closed, so after it every required key is configured. Names only, never a value.
 */
export function formatInitKeysHuman(
  keys: Readonly<
    Record<
      string,
      {
        readonly required: readonly string[];
        readonly collected: readonly string[];
        readonly missing?: readonly string[];
        readonly sources?: readonly KeySourceReport[];
        readonly verification?: readonly KeyVerificationReport[];
        readonly warnings?: readonly string[];
      }
    >
  >,
): string {
  return Object.entries(keys)
    .map(([feature, { required, collected, missing, sources, verification, warnings }]) => {
      const named = (k: string): string => {
        const s = sources?.find((x) => x.key === k);
        return s === undefined ? k : `${k} (${s.provider})`;
      };
      // #230: the non-interactive path (no TTY on stdin) never prompts — report what's still
      // missing and how to configure it, the same command name as the E_AI_SETUP_REQUIRED refusals.
      if (missing !== undefined && missing.length > 0) {
        // #429: judgment is satisfied by EITHER of its keys (TypeSafe or OpenRouter).
        const sep = feature === "judgment" ? " or " : ", ";
        return `keys: ${feature} not configured — set ${missing.map(named).join(sep)} or run \`jevitate ai setup ${feature}\``;
      }
      if (sources === undefined) {
        const detail = collected.length > 0 ? `collected ${collected.join(", ")} now` : "already configured";
        return `keys: ${feature} ready — ${required.length}/${required.length} configured (${detail})`;
      }
      // #268: name each key, its provider and where it comes from (never a value); #291: its live check.
      const body = featureKeysBody(feature as Feature, sources, verification);
      const detail = collected.length > 0 ? ` (entered now: ${collected.join(", ")})` : "";
      return [`keys: ${feature} ${body}${detail}`, ...(warnings ?? []).map((w) => `keys: warning: ${w}`)].join("\n");
    })
    .join("\n");
}

/** The regression id a committed `<id>.recording.json` path names. */
function idFromRecordingPath(p: string): string | undefined {
  const base = p.split(/[\\/]/).pop();
  return base?.endsWith(".recording.json") ? base.slice(0, -".recording.json".length) : undefined;
}

/**
 * `regression capture` (#227): a committed regression, or a failure too flaky to commit — never the
 * raw envelope. #230: `opts.dir` is the `--dir` the user passed — the `regression run` hint must
 * carry it too, or (a non-default regressions dir, e.g. the README demo's `--dir demo-regressions`)
 * the follow-up looks in the default dir and refuses E_REGRESSION_NOT_FOUND.
 */
export function formatRegressionCaptureHuman(result: unknown, opts: { readonly dir?: string } = {}): string {
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
  const dirFlag = opts.dir === undefined ? "" : ` --dir ${opts.dir}`;
  lines.push(id === undefined ? "next: jevitate regression run <id>" : `next: jevitate regression run ${id}${dirFlag}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `regression run` (#227): the verdict, why, and what to do about it — matches `verify-fix`'s shape.
 * #230: `opts.dir` is the `--dir` the user passed — the re-check hints must carry it too.
 */
export function formatRegressionRunHuman(report: unknown, opts: { readonly dir?: string } = {}): string {
  if (!isRecord(report)) return "";
  const id = str(report.id) ?? "";
  const verdict = str(report.verdict) ?? "unknown";
  const reason = str(report.reason);
  const lines = [`${verdict.toUpperCase()}: ${id}`];
  if (reason !== undefined) lines.push(`${tag("REASON")}${reason}`);
  const dirFlag = opts.dir === undefined ? "" : ` --dir ${opts.dir}`;
  lines.push(
    verdict === "fixed"
      ? "next: jevitate report"
      : verdict === "reproduces"
        ? `next: fix it, then jevitate regression run ${id}${dirFlag}`
        : `next: jevitate regression run ${id}${dirFlag} (re-check)`,
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
