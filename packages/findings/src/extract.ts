import { basename } from "node:path";
import {
  findingKey,
  requestIdentity,
  routeTemplate,
  severityOf,
  type FindingCategory,
  type FindingIdentity,
  type RunMode,
  type Severity,
} from "./identity.js";

/**
 * Normalizes every persisted result shape into one `RunRecord` of `FindingObservation`s.
 *
 * Inputs are what the runners already wrote — `<stem>.result.json` (`{missionOutcome, exitCode,
 * result}`) for goal/coverage/exploratory/adversarial/feature missions and for the Journey and
 * verify-fix records `jevitate check` writes, and `usability-<stamp>.json` UX reports. Everything
 * in them was redacted before it was written; nothing here reads a page, a model or a secret.
 *
 * Parsing is tolerant by design (older results, partial crash-time results) but never invents a
 * finding: a field that is missing or of the wrong shape is skipped, not defaulted.
 */

/** Where a finding was seen: a step, a screenshot, a request, a URL, the transcript/Recording. */
export interface EvidenceRef {
  readonly step?: number;
  readonly screenshot?: string;
  readonly request?: string;
  readonly url?: string;
  readonly transcript?: string;
  readonly recording?: string;
  readonly screen?: string;
}

export interface FindingObservation {
  readonly key: string;
  readonly identity: FindingIdentity;
  readonly title: string;
  readonly severity: Severity;
  /** Every engine fingerprint seen with it (the cascade one broken call fires). */
  readonly related: readonly string[];
  /** How many times THIS run hit it. */
  readonly occurrences: number;
  readonly evidence: readonly EvidenceRef[];
  /** The reproduction command (the `verify-fix` input), when the finding has a replayable repro. */
  readonly reproduce?: string;
  /** The run itself saw it come and go (a hang reproduced k/N, verify-fix `intermittent`). */
  readonly intermittent?: boolean;
}

export interface EngineStamp {
  readonly version?: string;
  readonly commit?: string;
  readonly builtAt?: string;
}

export interface RunRecord {
  /** The result file's stem (e.g. `adversarial-2026-09-24T10-00-00-000Z`) — how a run is named. */
  readonly runId: string;
  readonly mode: RunMode;
  /** The persisted file the run was read from. */
  readonly path: string;
  /** The target's origin, when the result names one. */
  readonly target?: string;
  /** A suite target name stamped by `jevitate check`, when there is one. */
  readonly targetName?: string;
  /** ISO time the run started (from its artifact stamp). */
  readonly startedAt?: string;
  readonly engine?: EngineStamp;
  /** The caller-supplied target build id (`jevitate check --target-build`). */
  readonly targetBuild?: string;
  readonly missionOutcome?: string;
  readonly exitCode?: number;
  readonly observations: readonly FindingObservation[];
  /** The run's persisted model `usage` object (#163), as written — summed by `jevitate report`. */
  readonly usage?: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function strings(v: unknown): string[] {
  return arr(v).filter((s): s is string => typeof s === "string");
}

/** `explore-2026-09-24T10-00-00-000Z` → `2026-09-24T10:00:00.000Z` (the artifact stamp, reversed). */
export function stampToIso(name: string): string | undefined {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  return m === null ? undefined : `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

/** The run id of a persisted file: its basename without `.result.json` / `.json`. */
export function runIdOf(path: string): string {
  const b = basename(path);
  if (b.endsWith(".result.json")) return b.slice(0, -".result.json".length);
  return b.endsWith(".json") ? b.slice(0, -".json".length) : b;
}

const PREFIX_MODES: ReadonlyArray<readonly [string, RunMode]> = [
  ["explore-", "goal"],
  ["coverage-", "coverage"],
  ["adversarial-", "adversarial"],
  ["feature-", "feature"],
  ["usability-", "usability"],
  ["journey-", "journey"],
  ["verify-", "verify-fix"],
];

function modeFromName(runId: string): RunMode | undefined {
  return PREFIX_MODES.find(([p]) => runId.startsWith(p))?.[1];
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function observation(
  identity: FindingIdentity,
  rest: Omit<FindingObservation, "key" | "identity" | "severity" | "related"> & { related?: readonly string[] },
): FindingObservation {
  const related = [...new Set([...(identity.fingerprint === undefined ? [] : [identity.fingerprint]), ...(rest.related ?? [])])];
  return { ...rest, key: findingKey(identity), identity, severity: severityOf(identity.category), related };
}

function verifyCommand(resultPath: string, fingerprint: string): string {
  return `jevitate verify-fix --result ${resultPath} --fingerprint ${fingerprint}`;
}

/** The last acted-on control of a repro's transcript steps (what triggered the finding). */
function lastControl(repro: unknown): string | undefined {
  if (!isRecord(repro)) return undefined;
  const steps = arr(repro.steps).filter(isRecord);
  for (let i = steps.length - 1; i >= 0; i--) {
    const target = str(steps[i]?.target);
    if (target !== undefined) return target;
  }
  return undefined;
}

function requestOfSignals(signals: unknown): { id?: string; url?: string } {
  for (const s of arr(signals).filter(isRecord)) {
    const url = str(s.url);
    if (url === undefined) continue;
    if (s.kind === "http-5xx" && num(s.status) !== undefined) return { id: requestIdentity(num(s.status) ?? 0, url), url };
    if (s.kind === "failed-request") return { id: requestIdentity("failed", url), url };
  }
  return {};
}

function stepEvidence(steps: readonly number[], base: EvidenceRef): EvidenceRef[] {
  if (steps.length === 0) return [base];
  return steps.slice(0, 10).map((step) => ({ ...base, step }));
}

/** A hard-signal or invariant defect (`result.defects[]`: adversarial, or declared invariants anywhere). */
function defectObservation(d: Json, ctx: Ctx): FindingObservation | null {
  const fingerprint = str(d.fingerprint);
  const kind = str(d.kind);
  if (fingerprint === undefined || kind === undefined) return null;
  const inv = isRecord(d.invariant) ? d.invariant : undefined;
  const category: FindingCategory = kind === "invariant" ? "invariant" : "defect";
  const invId = str(inv?.id);
  const action = isRecord(inv?.action) ? inv.action : undefined;
  const control = str(action?.control) ?? lastControl(d.repro);
  const request = requestOfSignals(d.signals);
  const route = str(d.route) ?? routeTemplate(str(d.url));
  const steps = arr(d.occurrenceSteps).filter((n): n is number => typeof n === "number");
  const repro = isRecord(d.repro) ? d.repro : undefined;
  const reproStep = num(repro?.recordingStepIndex);
  const identity: FindingIdentity = {
    category,
    signal: category === "invariant" ? `invariant:${invId ?? "code-level"}` : kind,
    fingerprint,
    ...(route === undefined ? {} : { route }),
    ...(control === undefined ? {} : { control }),
    ...(request.id === undefined ? {} : { request: request.id }),
  };
  const base: EvidenceRef = {
    ...(str(d.url) === undefined ? {} : { url: str(d.url) }),
    ...(request.url === undefined ? {} : { request: request.url }),
    ...(ctx.transcript === undefined ? {} : { transcript: ctx.transcript }),
  };
  const evidence =
    steps.length > 0
      ? stepEvidence(steps, base)
      : [...(inv === undefined ? [] : strings(inv.evidence).slice(0, 5).map((request) => ({ ...base, request }))), ...(reproStep === undefined ? [base] : [{ ...base, step: reproStep }])];
  return observation(identity, {
    title: str(d.title) ?? `${kind} on ${route ?? "(unknown route)"}`,
    related: strings(d.related),
    occurrences: num(d.occurrences) ?? 1,
    evidence,
    ...(reproStep === undefined ? {} : { reproduce: verifyCommand(ctx.path, fingerprint) }),
  });
}

function hangObservation(h: Json, ctx: Ctx): FindingObservation | null {
  const fingerprint = str(h.fingerprint);
  if (fingerprint === undefined) return null;
  const signal = isRecord(h.signal) ? h.signal : undefined;
  const hangKind = str(h.hangKind) ?? str(signal?.kind) ?? "hang";
  const pending = arr(signal?.pending).filter(isRecord)[0];
  const endpoint = str(pending?.endpoint);
  const element = str(signal?.element);
  const route = str(h.route);
  const reproduction = isRecord(h.reproduction) ? h.reproduction : undefined;
  const steps = arr(h.occurrenceSteps).filter((n): n is number => typeof n === "number");
  const identity: FindingIdentity = {
    category: "hang",
    signal: `hang:${hangKind}`,
    fingerprint,
    ...(route === undefined ? {} : { route }),
    ...(element === undefined ? {} : { control: element }),
    ...(endpoint === undefined ? {} : { request: `pending ${endpoint}` }),
  };
  const base: EvidenceRef = {
    ...(str(h.url) === undefined ? {} : { url: str(h.url) }),
    ...(str(pending?.url) === undefined ? {} : { request: str(pending?.url) }),
    ...(ctx.transcript === undefined ? {} : { transcript: ctx.transcript }),
  };
  return observation(identity, {
    title: str(h.title) ?? `Hang (${hangKind}) on ${route ?? "(unknown route)"}`,
    occurrences: num(h.occurrences) ?? 1,
    evidence: stepEvidence(steps, base),
    reproduce: verifyCommand(ctx.path, fingerprint),
    ...(reproduction?.status === "intermittent" ? { intermittent: true } : {}),
  });
}

/** A 4xx-correlated console error (#88): reported, never a defect. */
function advisoryObservation(a: Json, ctx: Ctx): FindingObservation | null {
  const fingerprint = str(a.fingerprint);
  if (fingerprint === undefined) return null;
  const route = str(a.route);
  const status = num(a.status);
  const steps = arr(a.occurrenceSteps).filter((n): n is number => typeof n === "number");
  return observation(
    {
      category: "advisory",
      signal: `console-error${status === undefined ? "" : `@${status}`}`,
      fingerprint,
      ...(route === undefined ? {} : { route }),
    },
    {
      title: str(a.title) ?? `Advisory console error on ${route ?? "(unknown route)"}`,
      occurrences: num(a.occurrences) ?? 1,
      evidence: stepEvidence(steps, {
        ...(str(a.url) === undefined ? {} : { url: str(a.url) }),
        ...(ctx.transcript === undefined ? {} : { transcript: ctx.transcript }),
      }),
    },
  );
}

/** A coverage state Jev flagged as a possible defect: advisory only (guardrail #4). */
function flaggedStateObservation(d: Json): FindingObservation | null {
  const url = str(d.url);
  if (url === undefined) return null;
  const route = routeTemplate(url);
  return observation(
    { category: "advisory", signal: "judgment-flagged-state", ...(route === undefined ? {} : { route }) },
    { title: `Jev flagged a possible defect on ${route ?? url} (advisory)`, occurrences: 1, evidence: [{ url }] },
  );
}

/** A goal run's failed success checks: each is a hard `goal-check` finding. */
function goalCheckObservations(result: Json, ctx: Ctx): FindingObservation[] {
  const outcome = str(result.outcome);
  // A run that broke (crashed/inconclusive) proved nothing about its checks: not a finding.
  if (outcome === "crashed" || outcome === "inconclusive" || outcome === undefined || outcome === "succeeded") return [];
  const target = isRecord(result.target) ? result.target : undefined;
  const route = routeTemplate(str(target?.seedUrl));
  const suite = isRecord(result.suite) ? result.suite : undefined;
  const goalName = str(suite?.item);
  const out: FindingObservation[] = [];
  const failedChecks = arr(result.checks).filter((c) => isRecord(c) && c.passed === false);
  if (failedChecks.length === 0 && (outcome === "exhausted" || outcome === "blocked")) {
    // The goal was not reached but no check names why (none evaluated): still a failed goal.
    out.push(
      observation(
        { category: "goal-check", signal: `goal-check:not-reached`, ...(route === undefined ? {} : { route }), ...(goalName === undefined ? {} : { control: `goal ${goalName}` }) },
        {
          title: `Goal not reached (${outcome})${goalName === undefined ? "" : ` (${goalName})`}${str(result.reason) === undefined ? "" : `: ${str(result.reason)}`}`,
          occurrences: 1,
          evidence: [{ ...(ctx.transcript === undefined ? {} : { transcript: ctx.transcript }) }],
        },
      ),
    );
  }
  for (const c of arr(result.checks).filter(isRecord)) {
    const check = str(c.check);
    if (check === undefined || c.passed !== false) continue;
    out.push(
      observation(
        { category: "goal-check", signal: `goal-check:${check}`, ...(route === undefined ? {} : { route }), ...(goalName === undefined ? {} : { control: `goal ${goalName}` }) },
        {
          title: `Goal success check failed: ${check}${goalName === undefined ? "" : ` (${goalName})`} — ${str(c.detail) ?? ""}`.trim(),
          occurrences: 1,
          evidence: [
            {
              ...(str(result.finalUrl) === undefined ? {} : { url: str(result.finalUrl) }),
              ...(ctx.transcript === undefined ? {} : { transcript: ctx.transcript }),
              ...(ctx.recording === undefined ? {} : { recording: ctx.recording }),
            },
          ],
        },
      ),
    );
  }
  return out;
}

/** A Journey record written by `jevitate check`: a quarantined run is a failed assertion. */
function journeyObservations(result: Json): FindingObservation[] {
  if (str(result.outcome) !== "quarantined") return [];
  const id = str(result.journeyId) ?? "(unknown)";
  const at = num(result.at);
  const route = routeTemplate(str(result.url));
  return [
    observation(
      {
        category: "journey-assertion",
        signal: `journey:${id}`,
        ...(route === undefined ? {} : { route }),
        ...(at === undefined ? {} : { control: `step ${at}` }),
      },
      {
        title: `Journey "${id}" failed${at === undefined ? "" : ` at step ${at}`}: ${str(result.reason) ?? "quarantined"}`,
        occurrences: 1,
        evidence: [{ ...(at === undefined ? {} : { step: at }), ...(str(result.url) === undefined ? {} : { url: str(result.url) }) }],
        reproduce: `jevitate journey run ${id}`,
      },
    ),
  ];
}

/** A verify-fix record written by `jevitate check`: still reproducing re-observes the ORIGINAL finding. */
function verifyObservations(result: Json): FindingObservation[] {
  const verdict = str(result.verdict);
  if (verdict !== "still-reproduces" && verdict !== "intermittent") return [];
  const id = isRecord(result.identity) ? result.identity : undefined;
  const category = str(id?.category) as FindingCategory | undefined;
  const signal = str(id?.signal);
  const fingerprint = str(result.fingerprint);
  if (category === undefined || signal === undefined || fingerprint === undefined) return [];
  const identity: FindingIdentity = {
    category,
    signal,
    fingerprint: str(id?.fingerprint) ?? fingerprint,
    ...(str(id?.route) === undefined ? {} : { route: str(id?.route) }),
    ...(str(id?.control) === undefined ? {} : { control: str(id?.control) }),
    ...(str(id?.request) === undefined ? {} : { request: str(id?.request) }),
  };
  const source = str(result.source);
  return [
    observation(identity, {
      title: `${str(result.title) ?? signal} — verify-fix: ${verdict}`,
      occurrences: 1,
      evidence: [{ ...(source === undefined ? {} : { recording: source }) }],
      ...(source === undefined ? {} : { reproduce: verifyCommand(source, fingerprint) }),
      ...(verdict === "intermittent" ? { intermittent: true } : {}),
    }),
  ];
}

/** A usability report's findings: every one is advisory (`ux`). */
function uxObservations(report: Json, screenshotDir: string | undefined): FindingObservation[] {
  const out: FindingObservation[] = [];
  for (const f of arr(report.findings).filter(isRecord)) {
    const rubric = str(f.rubricItemId);
    if (rubric === undefined) continue;
    const route = str(f.route);
    const control = strings(f.controls)[0];
    const screens = strings(f.screenIds);
    out.push(
      observation(
        { category: "ux", signal: rubric, ...(route === undefined ? {} : { route }), ...(control === undefined ? {} : { control }) },
        {
          title: `${rubric}: ${str(f.observation) ?? ""}`.trim(),
          occurrences: num(f.occurrences) ?? 1,
          evidence: (screens.length > 0 ? screens : [str(f.screenId) ?? ""]).slice(0, 10).map((screen) => ({
            ...(screen === "" ? {} : { screen }),
            ...(screenshotDir === undefined ? {} : { screenshot: screenshotDir }),
          })),
        },
      ),
    );
  }
  return out;
}

interface Ctx {
  readonly path: string;
  readonly transcript?: string;
  readonly recording?: string;
}

function engineOf(v: unknown): EngineStamp | undefined {
  if (!isRecord(v)) return undefined;
  const e = { version: str(v.version), commit: str(v.commit), builtAt: str(v.builtAt) };
  return Object.fromEntries(Object.entries(e).filter(([, x]) => x !== undefined)) as EngineStamp;
}

/**
 * Reads one persisted mission result (`{missionOutcome, exitCode, result}`) into a `RunRecord`.
 * Returns null for anything that is not one (a Recording, a transcript, an issue draft).
 */
export function runFromMissionResult(path: string, raw: unknown): RunRecord | null {
  if (!isRecord(raw) || !isRecord(raw.result) || str(raw.missionOutcome) === undefined) return null;
  const result = raw.result;
  const runId = runIdOf(path);
  const mode = (str(result.mode) as RunMode | undefined) ?? modeFromName(runId);
  if (mode === undefined) return null;
  const target = isRecord(result.target) ? result.target : undefined;
  const ctx: Ctx = {
    path,
    ...(str(result.transcriptPath) === undefined ? {} : { transcript: str(result.transcriptPath) }),
    ...(str(result.recordingPath) === undefined ? {} : { recording: str(result.recordingPath) }),
  };
  const observations: FindingObservation[] = [];
  const push = (o: FindingObservation | null): void => {
    if (o !== null) observations.push(o);
  };
  if (mode === "journey") observations.push(...journeyObservations(result));
  else if (mode === "verify-fix") observations.push(...verifyObservations(result));
  else {
    for (const d of arr(result.defects).filter(isRecord)) push(defectObservation(d, ctx));
    for (const h of arr(result.hangs).filter(isRecord)) push(hangObservation(h, ctx));
    for (const a of arr(result.advisories).filter(isRecord)) push(advisoryObservation(a, ctx));
    if (mode === "coverage" && isRecord(result.coverage)) {
      for (const d of arr(result.coverage.defects).filter(isRecord)) push(flaggedStateObservation(d));
    }
    if (mode === "goal") observations.push(...goalCheckObservations(result, ctx));
  }
  const suite = isRecord(result.suite) ? result.suite : undefined;
  const engine = engineOf(result.engine);
  const startedAt = str(result.startedAt) ?? stampToIso(runId);
  const origin = originOf(str(target?.seedUrl)) ?? originOf(str(result.site));
  return {
    runId,
    mode,
    path,
    observations,
    missionOutcome: str(raw.missionOutcome),
    ...(num(raw.exitCode) === undefined ? {} : { exitCode: num(raw.exitCode) }),
    ...(origin === undefined ? {} : { target: origin }),
    ...(str(suite?.target) === undefined ? {} : { targetName: str(suite?.target) }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(engine === undefined ? {} : { engine }),
    ...(str(result.targetBuild) === undefined ? {} : { targetBuild: str(result.targetBuild) }),
    ...(isRecord(result.usage) ? { usage: result.usage } : {}),
  };
}

/**
 * Reads a usability report (`usability-<stamp>.json`, a `UxReport`) into a `RunRecord`. The report
 * names no origin, so `site` (from its sibling `usability-<stamp>.recording.json`) supplies it.
 * Findings in an offline `ux-<stamp>.json` review have no origin at all (no `site`).
 */
export function runFromUxReport(path: string, raw: unknown, sibling: { site?: string; screenshotDir?: string } = {}): RunRecord | null {
  if (!isRecord(raw) || !Array.isArray(raw.findings) || typeof raw.headline !== "string") return null;
  const runId = runIdOf(path);
  const startedAt = stampToIso(runId);
  const origin = originOf(sibling.site);
  // `jevitate check` stamps a report it ran with `{engine, targetBuild, target}` (a UxReport has no engine).
  const stamp = isRecord(raw.stamp) ? raw.stamp : undefined;
  return {
    runId,
    mode: "usability",
    path,
    observations: uxObservations(raw, sibling.screenshotDir),
    ...(origin === undefined ? {} : { target: origin }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(str(stamp?.targetBuild) === undefined ? {} : { targetBuild: str(stamp?.targetBuild) }),
    ...(str(stamp?.target) === undefined ? {} : { targetName: str(stamp?.target) }),
    ...(engineOf(stamp?.engine) === undefined ? {} : { engine: engineOf(stamp?.engine) }),
  };
}
