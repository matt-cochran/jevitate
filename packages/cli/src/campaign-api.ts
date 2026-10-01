import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  FsJourneyStore,
  JourneyRegistry,
  JourneyStepError,
  deriveParamSchema,
  journeyBranchPoint,
  journeyPrefix,
  resolveJourneyStep,
  validateParams,
  CAMPAIGN_LIMITS,
  CampaignSpecSchema,
  splitBudget,
  sweepStops,
  type JourneyBranchPoint,
} from "@jevitate/journey";
import { assertSafeName, combineOutcomes, MISSION_OUTCOMES, type MissionOutcome } from "@jevitate/domain";
import type { ConsolidatedDefect } from "@jevitate/findings";
import { applyJourneyEnvironment, environmentFromFlags, isEnvironmentError, type ResolvedJourneyEnvironment } from "./environments.js";
import { prefixParams } from "./journey-api.js";
import type { AnchoredStrategy } from "./journey-prefix.js";
import { buildMissionFixtures } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, type MissionFixtures } from "./mission-fixtures.js";
import { lastEnvelope } from "./multi-run-cli.js";
import { buildReport, loadRunFile, type RunSummary } from "./report-api.js";
import { exitCodeForOutcome } from "./exit-codes.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import type { RunRecord } from "@jevitate/findings";

/**
 * #293 — `jevitate campaign run <spec.json>`: many journey-anchored missions, run in order, read as
 * ONE deduped report.
 *
 * A campaign spec lists jobs: a promoted Journey, the anchors (names or step numbers) to branch off,
 * the strategies to run from each, and their budgets. The run is:
 *
 *  1. discovery — each job's whole Journey is replayed once (`journey run`, fail-closed): a stale
 *     Journey is reported and its missions are skipped (`journey-stale`), never run from a URL;
 *  2. anchored missions, in spec order (job → anchor → strategy): each is `explore --from-journey
 *     <id> --at-step <anchor> --strategy <s>` (its own fresh browser context), with the campaign's
 *     state restore around it — the `--fixtures` setup/restore semantics (and operator hooks when
 *     `--allow-shell-hooks` is given) — so one mission's side effects never leak into the next;
 *  3. one report — every mission's persisted result consolidated by `@jevitate/findings` (the same
 *     dedupe as `jevitate report`), each defect listing the Journey steps it branched from.
 *
 * Bounded: at most 50 jobs and `maxRuns` missions (default 50, at most 200), each with an action
 * budget (default 40). An invalid spec is refused with EVERY problem listed (E_CAMPAIGN_SPEC, exit
 * 64) before any browser opens. The campaign's outcome is the worst of its missions' (a broken or
 * stale mission dominates, as `combineOutcomes` rules) — the report keeps every finding either way.
 */

export { CAMPAIGN_LIMITS, CampaignSpecSchema, type CampaignSpec } from "@jevitate/journey";

/** The spec cannot be run as given — every problem listed (exit 64, nothing ran). */
export class CampaignSpecError extends Error {
  readonly code = "E_CAMPAIGN_SPEC" as const;
  constructor(readonly problems: readonly string[]) {
    super(`invalid campaign spec (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CampaignSpecError";
  }
}



export interface CampaignAnchor {
  /** What `--at-step` is given (the anchor's name, else the step number). */
  readonly atStep: string;
  readonly branch: JourneyBranchPoint;
}

export interface CampaignJobPlan {
  readonly id: string;
  readonly journey: string;
  readonly params: Readonly<Record<string, string>>;
  readonly storageState?: string;
  readonly anchors: readonly CampaignAnchor[];
  readonly strategies: readonly AnchoredStrategy[];
  readonly goal?: string;
  readonly appClass?: string;
  readonly success: readonly string[];
  /** Per mission (a sweep's total already split). */
  readonly maxActions: number;
  readonly maxDecisions?: number;
  /** #293: set when the job sweeps every step (`all`) or every anchor (`anchors`). */
  readonly sweep?: "all" | "anchors";
  /** The campaign's state restore for this job's runs (built for its Journey's origins). */
  readonly fixtures?: MissionFixtures;
}

export interface CampaignPlan {
  readonly name?: string;
  readonly specPath: string;
  readonly env?: string;
  readonly baseUrl?: string;
  readonly discovery: boolean;
  readonly totalRuns: number;
  readonly jobs: readonly CampaignJobPlan[];
}

export interface ValidateCampaignOptions {
  readonly journeysDir: string;
  /** `--allow-shell-hooks`: the spec's before/after hooks may run. */
  readonly allowShellHooks?: boolean;
  /** #247 seams (`environments.json`, `targets.json`). */
  readonly environmentSeams?: { readonly environmentsFile?: string; readonly targetsFile?: string };
}

const at = (path: readonly PropertyKey[]): string => (path.length === 0 ? "spec" : path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, ""));

/**
 * Reads and validates a campaign spec against the Journey store — structure, then every job's
 * Journey (exists, promoted), anchors, params, session, strategies' inputs, the fixtures and the
 * run cap — and returns the plan. Throws `CampaignSpecError` listing EVERY problem found.
 */
export async function validateCampaign(specPath: string, opts: ValidateCampaignOptions): Promise<CampaignPlan> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (e) {
    throw new CampaignSpecError([`cannot read ${specPath}: ${e instanceof SyntaxError ? "not valid JSON" : e instanceof Error ? e.message : String(e)}`]);
  }
  return validateCampaignSpec(raw, resolve(specPath), opts);
}

/**
 * Validates a campaign spec OBJECT (`specPath` names where it came from; its relative paths resolve
 * against that file's directory) — what `explore --at-step all|anchors` builds for its sweep.
 */
export async function validateCampaignSpec(raw: unknown, specPath: string, opts: ValidateCampaignOptions): Promise<CampaignPlan> {
  const parsed = CampaignSpecSchema.safeParse(raw);
  if (!parsed.success) throw new CampaignSpecError(parsed.error.issues.map((i) => `${at(i.path)}: ${i.message}`));
  const spec = parsed.data;
  const base = dirname(resolve(specPath));
  // A spec path is relative to the spec file; `~/` is the home directory (sessions live in ~/.jevitate).
  const abs = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(base, p));
  const problems: string[] = [];

  let environment: ResolvedJourneyEnvironment | undefined;
  try {
    environment = environmentFromFlags(
      { ...(spec.env === undefined ? {} : { env: spec.env }), ...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }) },
      opts.environmentSeams ?? {},
    );
  } catch (err) {
    if (!isEnvironmentError(err)) throw err;
    problems.push(`env: ${err.message}`);
  }
  const defaultSession = spec.storageState === undefined ? environment?.storageState : abs(spec.storageState);
  if (spec.storageState !== undefined && !existsSync(abs(spec.storageState))) problems.push(`storageState: not found: ${abs(spec.storageState)}`);
  if (spec.fixtures !== undefined && !existsSync(abs(spec.fixtures))) problems.push(`fixtures: not found: ${abs(spec.fixtures)}`);
  if ((spec.before !== undefined || spec.after !== undefined) && opts.allowShellHooks !== true) {
    problems.push("before/after: operator shell hooks run only with --allow-shell-hooks");
  }

  const registry = new JourneyRegistry(new FsJourneyStore(opts.journeysDir));
  const seen = new Set<string>();
  const jobs: CampaignJobPlan[] = [];
  let totalRuns = 0;
  for (const [i, job] of spec.jobs.entries()) {
    const where = `jobs[${i}]${job.id === "" ? "" : ` (${job.id})`}`;
    try {
      assertSafeName(job.id, "job id");
    } catch (err) {
      problems.push(`${where}.id: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (seen.has(job.id)) problems.push(`${where}.id: duplicate job id ${JSON.stringify(job.id)}`);
    seen.add(job.id);
    const needsGoal = job.strategies.filter((s) => s === "goal" || s === "usability");
    if (needsGoal.length > 0 && job.goal === undefined) problems.push(`${where}.goal: required by strategy ${needsGoal.join(", ")}`);
    if (job.strategies.includes("usability") && job.appClass === undefined) problems.push(`${where}.appClass: required by strategy usability`);
    if (job.success !== undefined && needsGoal.length !== job.strategies.length) {
      problems.push(`${where}.success: checks apply only to goal and usability missions — give them a job of their own`);
    }
    if (new Set(job.strategies).size !== job.strategies.length) problems.push(`${where}.strategies: duplicate strategy`);
    const session = job.storageState === undefined ? defaultSession : abs(job.storageState);
    if (job.storageState !== undefined && !existsSync(abs(job.storageState))) problems.push(`${where}.storageState: not found: ${abs(job.storageState)}`);

    let stored: Awaited<ReturnType<typeof registry.get>> = null;
    try {
      stored = await registry.get(job.journey);
    } catch (err) {
      problems.push(`${where}.journey: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      continue;
    }
    if (stored === null) {
      problems.push(`${where}.journey: unknown journey '${job.journey}'`);
      continue;
    }
    if (!stored.metadata.promoted) problems.push(`${where}.journey: journey '${job.journey}' is not promoted (a person promotes it: jevitate journey promote ${job.journey})`);
    let full = stored;
    try {
      full = applyJourneyEnvironment(stored, environment);
    } catch (err) {
      problems.push(`${where}.journey: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (full.metadata.requiresAuth === true && session === undefined) problems.push(`${where}: journey '${job.journey}' requires auth — give storageState`);
    // #293: a sweep — every step ("all") or every declared anchor ("anchors") — or the listed stops.
    let refs: Array<string | number> = [];
    const sweep = typeof job.anchors === "string" ? job.anchors : undefined;
    try {
      refs = sweep !== undefined ? sweepStops(full, sweep) : (job.anchors as Array<string | number> | undefined) ?? (full.metadata.anchors ?? []).map((a) => a.name);
    } catch (err) {
      if (!(err instanceof JourneyStepError)) throw err;
      problems.push(`${where}.anchors: ${err.message}`);
    }
    if (refs.length === 0 && sweep === undefined) problems.push(`${where}.anchors: journey '${job.journey}' declares no anchors — list anchor names or step numbers`);
    const anchors: CampaignAnchor[] = [];
    for (const [k, ref] of refs.entries()) {
      try {
        const resolved = resolveJourneyStep(full, String(ref));
        anchors.push({ atStep: resolved.anchor?.name ?? String(resolved.step), branch: journeyBranchPoint(full, resolved) });
      } catch (err) {
        if (!(err instanceof JourneyStepError)) throw err;
        problems.push(`${where}.anchors[${k}]: ${err.message}`);
      }
    }
    if (new Set(anchors.map((a) => a.branch.step)).size !== anchors.length) problems.push(`${where}.anchors: two anchors name the same step`);
    const deepest = Math.max(0, ...anchors.map((a) => a.branch.step));
    if (deepest > 0) {
      try {
        const prefix = journeyPrefix(full, deepest);
        validateParams(deriveParamSchema(prefix.recording), prefixParams(full, prefix, job.params ?? {}));
      } catch (err) {
        problems.push(`${where}.params: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let fixtures: MissionFixtures | undefined;
    if (spec.fixtures !== undefined || spec.before !== undefined || spec.after !== undefined) {
      try {
        fixtures = buildMissionFixtures(
          {
            ...(spec.fixtures === undefined ? {} : { fixtures: abs(spec.fixtures) }),
            ...(spec.before === undefined ? {} : { before: spec.before }),
            ...(spec.after === undefined ? {} : { after: spec.after }),
            allowShellHooks: opts.allowShellHooks === true,
          },
          {
            allowlist: environment === undefined ? [new URL(full.recording.site).origin] : environment.allowedOrigins,
            baseUrl: full.recording.site,
            ...(session === undefined ? {} : { storageState: session }),
          },
        );
      } catch (err) {
        if (!(err instanceof FixtureSpecError) && !(err instanceof TypeError)) throw err;
        // Reported once for the campaign, not per job.
        const message = `fixtures: ${err.message}`;
        if (!problems.includes(message)) problems.push(message);
      }
    }
    totalRuns += anchors.length * job.strategies.length;
    jobs.push({
      id: job.id,
      journey: job.journey,
      params: job.params ?? {},
      ...(session === undefined ? {} : { storageState: session }),
      anchors,
      strategies: job.strategies,
      ...(job.goal === undefined ? {} : { goal: job.goal }),
      ...(job.appClass === undefined ? {} : { appClass: job.appClass }),
      success: job.success ?? [],
      // #293: a sweep's budgets are its TOTAL, split evenly over its missions (stop points × strategies).
      ...budgetsOf(job.maxActions ?? spec.maxActions, job.maxDecisions ?? spec.maxDecisions, sweep === undefined ? 1 : anchors.length * job.strategies.length),
      ...(sweep === undefined ? {} : { sweep }),
      ...(fixtures === undefined ? {} : { fixtures }),
    });
  }
  const cap = spec.maxRuns ?? CAMPAIGN_LIMITS.defaultMaxRuns;
  if (totalRuns > cap) problems.push(`jobs: ${totalRuns} anchored missions exceed maxRuns ${cap} (raise maxRuns, at most ${CAMPAIGN_LIMITS.maxRuns}, or split the campaign)`);
  if (problems.length > 0) throw new CampaignSpecError(problems);
  return {
    ...(spec.name === undefined ? {} : { name: spec.name }),
    specPath: resolve(specPath),
    ...(spec.env === undefined ? {} : { env: spec.env }),
    ...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }),
    discovery: spec.discovery ?? true,
    totalRuns,
    jobs,
  };
}

// ── Running ───────────────────────────────────────────────────────────────────────────────────

export interface CampaignDiscovery {
  readonly job: string;
  readonly journeyId: string;
  /** `ok`: the whole Journey replays · `stale`: it did not (its missions were skipped) · `error`: the replay could not run. */
  readonly outcome: "ok" | "stale" | "error";
  readonly reason?: string;
}

export interface CampaignMission {
  readonly job: string;
  readonly strategy: AnchoredStrategy;
  readonly branch: JourneyBranchPoint;
  /** `ran`: the mission ran (its outcome is `missionOutcome`) · `skipped`: its Journey was stale at discovery · `error`: it could not run. */
  readonly status: "ran" | "skipped" | "error";
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly resultPath?: string;
  readonly failure?: { readonly kind: string; readonly message: string };
  /** True when the campaign's state restore (`fixtures`/hooks) ran around this mission (setup before, restore after). */
  readonly restored?: boolean;
}

export interface CampaignResult {
  readonly name?: string;
  readonly specPath: string;
  readonly outDir: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly discovery: readonly CampaignDiscovery[];
  readonly missions: readonly CampaignMission[];
  /** One deduped defect list across every mission (`@jevitate/findings`), each with its branch points. */
  readonly report: {
    readonly defects: readonly ConsolidatedDefect[];
    readonly summary: { readonly defects: number; readonly advisory: number; readonly runs: number };
    readonly runs: readonly RunSummary[];
  };
  /** `campaign.json` (this result) and `campaign.md` (the report) in `outDir`. */
  readonly resultPath: string;
  readonly reportPath: string;
  /** The worst mission outcome (`combineOutcomes`). */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
}

export interface RunCampaignOptions {
  /** A fresh, unparsed program (each run is the same CLI command, in process). */
  readonly newProgram: () => Command;
  readonly journeysDir: string;
  readonly outDir?: string;
  readonly real?: boolean;
  readonly fakeAi?: boolean;
  /** Where `jevitate report`'s target filter would read mission targets (unused without one). */
  readonly missionTargetsDir: string;
  readonly nowIso?: () => string;
  /** More `explore` flags every mission is run with (an `explore --at-step all` sweep forwards its own). */
  readonly missionArgs?: readonly string[];
}

interface ChildRun {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

async function runChild(newProgram: () => Command, argv: readonly string[]): Promise<ChildRun> {
  const lines: string[] = [];
  const child = newProgram();
  child.exitOverride();
  child.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  const saved = process.exitCode;
  try {
    await child.parseAsync([...argv], { from: "user" });
  } catch (err) {
    return { ok: false, error: { code: "E_CAMPAIGN_RUN", message: err instanceof Error ? err.message : String(err) } };
  } finally {
    process.exitCode = saved;
  }
  const env = lastEnvelope(lines) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  if (!env.ok) return { ok: false, error: env.error ?? { code: "E_CAMPAIGN_RUN", message: "the run failed" } };
  return { ok: true, data: (env.data ?? {}) as Record<string, unknown> };
}

const isOutcome = (v: unknown): v is MissionOutcome => typeof v === "string" && (MISSION_OUTCOMES as readonly string[]).includes(v);

/**
 * Per-mission budgets: as given for listed stops; for a sweep (`missions` > 1 stop × strategy) the
 * given value is the sweep's TOTAL, split evenly (each mission at least 1 action). Without a value,
 * every mission gets the default 40 actions.
 */
function budgetsOf(maxActions: number | undefined, maxDecisions: number | undefined, missions: number): { maxActions: number; maxDecisions?: number } {
  return {
    maxActions: maxActions === undefined ? CAMPAIGN_LIMITS.defaultMaxActions : splitBudget(maxActions, missions),
    ...(maxDecisions === undefined ? {} : { maxDecisions: splitBudget(maxDecisions, missions) }),
  };
}

/** The flags a job's discovery replay and its missions share: params, environment, session. */
function commonArgs(plan: CampaignPlan, job: CampaignJobPlan): string[] {
  return [
    ...Object.entries(job.params).flatMap(([k, v]) => ["--param", `${k}=${v}`]),
    ...(plan.env === undefined ? [] : ["--env", plan.env]),
    ...(plan.baseUrl === undefined ? [] : ["--base-url", plan.baseUrl]),
    ...(job.storageState === undefined ? [] : ["--storage-state", job.storageState]),
  ];
}

/** Runs a validated campaign: discovery, then every anchored mission in order with state restore, then one report. */
export async function runCampaign(plan: CampaignPlan, opts: RunCampaignOptions): Promise<CampaignResult> {
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const startedAt = now();
  const outDir = opts.outDir ?? join(logsDirFor(startedAt), `campaign-${artifactStamp(startedAt)}`);
  await mkdir(outDir, { recursive: true });
  const ai = opts.real === true ? ["--real"] : opts.fakeAi === true ? ["--fake-ai"] : [];
  const discovery: CampaignDiscovery[] = [];
  const missions: CampaignMission[] = [];
  /** Runs `body` between the job's fixture setup and restore (a failed setup still restores). */
  const restored = async <T>(job: CampaignJobPlan, body: () => Promise<T>, onSetupFailed: (message: string) => T): Promise<T> => {
    const fx = job.fixtures;
    if (fx === undefined) return body();
    try {
      await fx.setup();
    } catch (err) {
      await fx.restore();
      if (err instanceof FixtureSetupError) return onSetupFailed(err.message);
      throw err;
    }
    try {
      return await body();
    } finally {
      await fx.restore();
    }
  };

  for (const job of plan.jobs) {
    const shared = commonArgs(plan, job);
    let stale: string | undefined;
    if (plan.discovery) {
      const d = await restored(
        job,
        async (): Promise<CampaignDiscovery> => {
          const r = await runChild(opts.newProgram, ["journey", "run", job.journey, "--dir", opts.journeysDir, ...shared, "--json"]);
          if (!r.ok) return { job: job.id, journeyId: job.journey, outcome: "error", reason: `${r.error?.code}: ${r.error?.message}` };
          const outcome = r.data?.outcome;
          if (outcome === "ok") return { job: job.id, journeyId: job.journey, outcome: "ok" };
          return { job: job.id, journeyId: job.journey, outcome: "stale", reason: typeof r.data?.reason === "string" ? r.data.reason : `the replay ended ${String(outcome)}` };
        },
        (message): CampaignDiscovery => ({ job: job.id, journeyId: job.journey, outcome: "error", reason: `fixture setup failed: ${message}` }),
      );
      discovery.push(d);
      if (d.outcome !== "ok") stale = d.reason ?? d.outcome;
    }
    for (const anchor of job.anchors) {
      for (const strategy of job.strategies) {
        if (stale !== undefined) {
          missions.push({
            job: job.id,
            strategy,
            branch: anchor.branch,
            status: "skipped",
            missionOutcome: "inconclusive",
            exitCode: exitCodeForOutcome("inconclusive"),
            failure: { kind: "journey-stale", message: `discovery: journey '${job.journey}' did not replay (${stale})` },
          });
          continue;
        }
        const runDir = join(outDir, job.id, `${anchor.atStep}-${strategy}`);
        const argv = [
          "explore",
          "--from-journey", job.journey,
          "--at-step", anchor.atStep,
          "--strategy", strategy,
          "--journeys-dir", opts.journeysDir,
          ...shared,
          "--max-actions", String(job.maxActions),
          ...(job.maxDecisions === undefined ? [] : ["--max-decisions", String(job.maxDecisions)]),
          ...(strategy === "goal" || strategy === "usability" ? [...(job.goal === undefined ? [] : ["--goal", job.goal]), ...job.success.flatMap((c) => ["--success", c])] : []),
          ...(strategy === "usability" && job.appClass !== undefined ? ["--app-class", job.appClass] : []),
          ...ai,
          ...(opts.missionArgs ?? []),
          "--out", runDir,
          "--json",
        ];
        const m = await restored(
          job,
          async (): Promise<CampaignMission> => {
            const r = await runChild(opts.newProgram, argv);
            if (!r.ok) {
              return {
                job: job.id,
                strategy,
                branch: anchor.branch,
                status: "error",
                missionOutcome: "inconclusive",
                exitCode: exitCodeForOutcome("inconclusive"),
                failure: { kind: "mission-error", message: `${r.error?.code}: ${r.error?.message}` },
              };
            }
            const data = r.data ?? {};
            const outcome: MissionOutcome = isOutcome(data.missionOutcome) ? data.missionOutcome : "inconclusive";
            const failure = data.failure as { kind?: unknown; message?: unknown } | undefined;
            return {
              job: job.id,
              strategy,
              branch: anchor.branch,
              status: "ran",
              missionOutcome: outcome,
              exitCode: typeof data.exitCode === "number" ? data.exitCode : exitCodeForOutcome(outcome),
              ...(typeof data.resultPath === "string" ? { resultPath: data.resultPath } : {}),
              ...(failure !== undefined && typeof failure.kind === "string" ? { failure: { kind: failure.kind, message: String(failure.message ?? "") } } : {}),
            };
          },
          (message): CampaignMission => ({
            job: job.id,
            strategy,
            branch: anchor.branch,
            status: "error",
            missionOutcome: "inconclusive",
            exitCode: exitCodeForOutcome("inconclusive"),
            failure: { kind: "configuration", message: `fixture setup failed: ${message}` },
          }),
        );
        missions.push(job.fixtures === undefined ? m : { ...m, restored: true });
      }
    }
  }

  // One deduped report over every mission that persisted a result.
  const runs: RunRecord[] = missions.flatMap((m) => {
    if (m.resultPath === undefined) return [];
    const r = loadRunFile(m.resultPath);
    return r === null ? [] : [r];
  });
  const report = await buildReport({ runs, missionTargetsDir: opts.missionTargetsDir });
  const missionOutcome = combineOutcomes(missions.map((m) => m.missionOutcome));
  const finishedAt = now();
  const resultPath = join(outDir, "campaign.json");
  const reportPath = join(outDir, "campaign.md");
  const result: CampaignResult = {
    ...(plan.name === undefined ? {} : { name: plan.name }),
    specPath: plan.specPath,
    outDir,
    startedAt,
    finishedAt,
    discovery,
    missions,
    report: { defects: report.defects, summary: report.summary, runs: report.runs },
    resultPath,
    reportPath,
    missionOutcome,
    exitCode: exitCodeForOutcome(missionOutcome),
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(reportPath, campaignMarkdown(result, report.markdown), "utf8");
  return result;
}

/** The campaign's own summary (discovery, missions) above the deduped report's markdown. */
function campaignMarkdown(r: CampaignResult, reportMarkdown: string): string {
  const lines = [
    `# Campaign${r.name === undefined ? "" : ` — ${r.name}`}`,
    "",
    `${r.missions.length} anchored mission(s) · outcome ${r.missionOutcome} (exit ${r.exitCode}) · ${r.report.summary.defects} deduped defect(s), ${r.report.summary.advisory} advisory.`,
    "",
    "## Discovery",
    "",
    ...(r.discovery.length === 0 ? ["Skipped (discovery: false)."] : ["| job | journey | outcome | reason |", "| --- | --- | --- | --- |", ...r.discovery.map((d) => `| ${d.job} | ${d.journeyId} | ${d.outcome} | ${(d.reason ?? "").replace(/\|/g, "\\|")} |`)]),
    "",
    "## Missions",
    "",
    "| job | branch | strategy | status | outcome | result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.missions.map(
      (m) =>
        `| ${m.job} | ${m.branch.journeyId} step ${m.branch.step}${m.branch.anchor === undefined ? "" : ` (${m.branch.anchor})`} | ${m.strategy} | ${m.status} | ${m.missionOutcome}${m.failure === undefined ? "" : ` — ${m.failure.kind}`} | ${m.resultPath === undefined ? "" : `\`${m.resultPath}\``} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n${reportMarkdown.replace(/^# /, "## ").replace(/\n## /g, "\n### ")}`;
}
