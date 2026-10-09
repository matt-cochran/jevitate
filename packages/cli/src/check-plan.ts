// check-plan.ts — `jevitate check` planning: targets, per-item setup, fixtures, sessions (#231).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { InvariantSpec } from "@jevitate/recording";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { assertAuthorizedExploreTarget, matchGlob, parseSecretField, resolveCoverageThresholds, secretFieldSecrets, SecretFieldSpecError, type CoverageThresholds, type DialogPolicy, type SecretField, type SuccessCheck } from "@jevitate/explore";
import { buildMissionFixtures, checkSetupRefs, type FixtureFlags } from "./fixture-cli.js";
import { parseLogSourceSpecs } from "./log-sources.js";
import { parseLogDefectSpecs, parseLogIgnoreSpecs, parseLogScopeSpecs } from "./log-correlation.js";
import { loadLogClassRules } from "./log-classes.js";
import { parseCorrelationHeaders, parseLogIdPatterns } from "./log-trace.js";
import { checkActorsAgainstSpec, resolveMissionActors, type MissionActors } from "./mission-actors.js";
import { loadPersonasFile, parsePersonaSpec, type Persona } from "./multi-run.js";
import { assertHeadedDisplay } from "./browser-run-options.js";
import { effectiveExploreOptions, type ExploreItemKind, type SuiteExploreOptions } from "./suite-explore-options.js";
import { FixtureSpecError, SETUP_REF, UnboundSetupRefError, type MissionFixtures } from "./mission-fixtures.js";
import { parseSuccessSpec, resolveExploreAllowlist, type ServerLogOptions } from "./explore-api.js";
import { findFinding, parsePersistedMission } from "./verify-fix-api.js";
import { loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { serverLogFromTargetConfig } from "./mission-queue-runner.js";
import { resolveTargetConfig, type TargetConfig } from "./target-config.js";
import { type EngineInfo } from "./engine.js";
import { applyJourneyEnvironment, isEnvironmentError, resolveJourneyEnvironment, type ResolvedJourneyEnvironment } from "./environments.js";
import { resolveJourneyPrefix, type JourneyPrefix } from "./journey-prefix.js";
import { isSweepMode, splitBudget, sweepStops } from "@jevitate/journey";
import type { SuiteGoal, SuiteItemOverrides, SuiteJourney, SuiteMission, SuiteTarget, SuiteVerifyFix } from "./check-suite.js";
import { CheckAiSetupError, CheckArgsError, CheckPreflightError, type ItemKind, type RunCheckOptions } from "./check-types.js";
import type { HealBudget, SelfHealMode } from "@jevitate/domain";
import type { ChangeScope } from "@jevitate/runtime";
import { JourneyHealArgsError, journeyHealBudget, readJourneyChangeScope, validateJourneyHeal } from "./journey-heal.js";
import { parseScreenshotsArg } from "./run-screenshots.js";

// ── changed routes ───────────────────────────────────────────────────────────

/** Concrete paths standing for a route or route glob (`/cart/**` → `/cart`, `/cart/x`). */
function representatives(route: string): string[] {
  if (!route.includes("*")) return [route];
  const concrete = route.replace(/\*\*/g, "x").replace(/\*/g, "x");
  const base = route.split("/*")[0] ?? "";
  return [concrete, base === "" ? "/" : base];
}

/** Does an item covering `routes` touch any changed route glob? No known routes ⇒ it runs. */
export function affectedBy(routes: readonly string[] | undefined, changed: readonly string[]): boolean {
  if (routes === undefined || routes.length === 0) return true;
  return routes.some((r) =>
    changed.some((g) => representatives(r).some((p) => matchGlob(g, p)) || representatives(g).some((p) => matchGlob(r, p))),
  );
}

function pathOf(url: string, base?: string): string {
  try {
    return new URL(url, base).pathname;
  } catch {
    return url;
  }
}

/** The page routes a Journey visits (from its Recording). */
function journeyRoutes(j: Journey): string[] {
  return [...new Set(j.recording.pages.map((p) => pathOf(p.url, j.recording.site)))];
}

// ── helpers ──────────────────────────────────────────────────────────────────

export type Json = Record<string, unknown>;

export function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Executed actions in a persisted result: its `actions`, else its transcript's acted steps. */
export function actionsOf(result: Json): number {
  if (typeof result.actions === "number") return result.actions;
  let transcript: unknown = result.transcript;
  if (!Array.isArray(transcript) && typeof result.transcriptPath === "string" && existsSync(result.transcriptPath)) {
    try {
      transcript = JSON.parse(readFileSync(result.transcriptPath, "utf8"));
    } catch {
      transcript = [];
    }
  }
  return Array.isArray(transcript) ? transcript.filter((e) => isRecord(e) && e.op !== null && e.op !== undefined).length : 0;
}

export interface Stamp {
  readonly engine: EngineInfo;
  readonly targetBuild?: string;
  readonly suite: { readonly name: string; readonly target: string; readonly item: string };
  /**
   * #213: stamped on a goal result run under `--fake-ai`/`ai:"fake"` — read back by
   * `@jevitate/findings` to keep the fake judge's OWN "goal not reached" ending out of the hard,
   * gating `goal-check` findings (a genuine hard signal it observed along the way, e.g. an
   * invariant violation or a 5xx, still gates: it never depended on the judge).
   */
  readonly aiMode?: "real" | "fake";
}

/** Adds the check's stamp (engine, target build, suite item, ai mode) to a result the runner already wrote. */
export function stampResultFile(path: string, stamp: Stamp): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(raw)) return;
  if (isRecord(raw.result)) {
    raw.result = {
      ...raw.result,
      engine: raw.result.engine ?? stamp.engine,
      suite: stamp.suite,
      ...(stamp.targetBuild === undefined ? {} : { targetBuild: stamp.targetBuild }),
      ...(stamp.aiMode === undefined ? {} : { aiMode: stamp.aiMode }),
    };
  } else {
    raw.stamp = { engine: stamp.engine, target: stamp.suite.target, item: stamp.suite.item, ...(stamp.targetBuild === undefined ? {} : { targetBuild: stamp.targetBuild }) };
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/** The flat step index → the page URL that step ran on (for a failed Journey step's route). */
export function journeyStepUrl(j: Journey, at: number | undefined): string | undefined {
  if (at === undefined) return undefined;
  let i = 0;
  for (const page of j.recording.pages) {
    if (at < i + page.steps.length) {
      try {
        return new URL(page.url, j.recording.site).toString();
      } catch {
        return undefined;
      }
    }
    i += page.steps.length;
  }
  return undefined;
}

export function recordingSteps(j: Journey): number {
  return j.recording.pages.reduce((n, p) => n + p.steps.length, 0);
}

// ── planning ─────────────────────────────────────────────────────────────────

export interface PreparedTarget {
  readonly target: SuiteTarget;
  readonly allowlist: string[];
  readonly invariants?: InvariantSpec;
  /** The invariants' `authFrom.secret` values, resolved from the environment at preflight (as `explore --invariants`). */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /** targets.json `logSources`/`logDefect` for the target's origin (as `explore` and the queue apply them). */
  readonly serverLog?: ServerLogOptions;
  readonly config?: TargetConfig;
  readonly journeys: Map<string, Journey>;
  /** #247: each Journey item that names an `env`/`baseUrl`, and the environment it resolved to at preflight. */
  readonly environments?: ReadonlyMap<SuiteJourney, ResolvedJourneyEnvironment>;
  readonly goals: Map<string, SuccessCheck[]>;
  /** The target's `secretFields`, resolved from the environment at preflight (#170). */
  readonly secretFields: readonly SecretField[];
  /** The target's fixtures file (the suite's, else targets.json's), validated at preflight (#170). */
  readonly fixturesFile?: string;
  /** #293: each journey-anchored mission item's Journey prefix, resolved (and refused) at preflight. */
  readonly prefixes?: ReadonlyMap<SuiteMission, JourneyPrefix>;
  /** #293: each anchored mission item → the items it runs as (a sweep: one per stop point). */
  readonly expanded?: ReadonlyMap<SuiteMission, readonly SuiteMission[]>;
}

/** What an item's fixture lifecycle is built from: its fixtures file and hooks, authenticated like its session. */
interface FixtureSource {
  readonly allowlist: readonly string[];
  readonly flags: FixtureFlags;
  readonly storageState?: string;
  readonly secretFields: readonly SecretField[];
}

/**
 * An item's fixture lifecycle (#170/#195), authenticated like the item's session: its storage
 * state and `secretFields`. `undefined` when it declares no fixtures file and no hooks.
 */
export function fixturesFor(f: FixtureSource, baseUrl: string): MissionFixtures | undefined {
  return buildMissionFixtures(f.flags, {
    allowlist: f.allowlist,
    baseUrl: baseUrl.replace(SETUP_REF, "0"),
    ...(f.storageState === undefined ? {} : { storageState: f.storageState }),
    secretFields: f.secretFields,
    secrets: secretFieldSecrets(f.secretFields),
  });
}

/** The target's own fixtures (around Journey items), with `storageState` the item's session. */
export function targetFixtures(p: PreparedTarget, storageState: string | undefined): FixtureSource {
  return {
    allowlist: p.allowlist,
    flags: p.fixturesFile === undefined ? {} : { fixtures: p.fixturesFile },
    ...(storageState === undefined ? {} : { storageState }),
    secretFields: p.secretFields,
  };
}

/** An item's session: its own `storageState` (`null`: none), else the target's. */
export function sessionOf(t: SuiteTarget, own: string | null | undefined): string | undefined {
  return own === null ? undefined : (own ?? t.storageState);
}

/**
 * Everything one goal/mission item runs with (#195): `explore`'s options, the target's defaults
 * overridden by the item's own, resolved and validated at preflight exactly as `explore` does for
 * its flags — the target config its safety/settle/timing flags build, its backend log sources,
 * secret references resolved from the environment, actors, personas and fixtures.
 */
interface ItemSetup {
  readonly x: SuiteExploreOptions;
  readonly storageState?: string;
  readonly secretFields: readonly SecretField[];
  readonly secrets?: readonly string[];
  readonly config?: TargetConfig;
  readonly serverLog?: ServerLogOptions;
  readonly actors?: MissionActors;
  readonly personas?: readonly Persona[];
  readonly fixtures?: FixtureSource;
  readonly coverageThresholds?: CoverageThresholds;
}

const TARGET_FLAG_KEYS = [
  "deny", "paid", "allowControl", "allowDestructive", "dialogs", "allowWrites", "allowWrite", "readRpc", "hangReplayWrites", "settleIgnore", "longPollMs", "apiPrefix", "ignoreNoProgress",
] as const;

function envSecret(ref: string, env: Readonly<Record<string, string | undefined>>): string {
  const name = ref.slice("env:".length);
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`secret ${ref}: environment variable ${name} is not set`);
  return v;
}

function itemSetup(
  p: PreparedTarget,
  item: SuiteItemOverrides & { readonly fixtures?: string },
  kind: ExploreItemKind,
  opts: RunCheckOptions,
  /** A goal's start URL and the texts that may reference `${setup.x}`. */
  refs?: { readonly url: string; readonly texts: Readonly<Record<string, string | readonly string[] | undefined>> },
): ItemSetup {
  const t = p.target;
  const env = opts.env ?? process.env;
  const x = effectiveExploreOptions(t.explore, item.explore, kind);
  // #245: a headed item without a display is refused here, before anything runs (use recordVideo).
  assertHeadedDisplay(x.headed === true, env);
  // #251: an unusable `screenshots` value is refused at preflight, before anything runs.
  parseScreenshotsArg(x.screenshots, "screenshots");
  let storageState = sessionOf(t, item.storageState);
  if (item.storageState !== undefined && item.storageState !== null && !existsSync(item.storageState)) {
    throw new Error(`storage state not found: ${item.storageState}`);
  }
  const secretFields = [
    ...(item.secretFields === undefined ? p.secretFields : item.secretFields.map((s) => parseSecretField(s, "value", env))),
    ...(x.totp ?? []).map((s) => parseSecretField(s, "totp", env)),
  ];
  const secrets = x.secret?.map((r) => envSecret(r, env));
  if (x.fixture !== undefined && !existsSync(x.fixture)) throw new Error(`fixture (upload file) not found: ${x.fixture}`);
  let config = p.config;
  if (TARGET_FLAG_KEYS.some((k) => x[k] !== undefined)) {
    config = resolveTargetConfig(opts.targetsConfig ?? {}, new URL(t.url).origin, {
      ...(x.settleIgnore === undefined ? {} : { settleIgnore: x.settleIgnore }),
      ...(x.ignoreNoProgress === undefined ? {} : { ignoreNoProgress: x.ignoreNoProgress }),
      ...(x.apiPrefix === undefined ? {} : { apiPrefixes: x.apiPrefix }),
      ...(x.deny === undefined ? {} : { deny: x.deny }),
      ...(x.paid === undefined ? {} : { paid: x.paid }),
      ...(x.allowControl === undefined ? {} : { allowControl: x.allowControl }),
      ...(x.readRpc === undefined ? {} : { readRpc: x.readRpc }),
      ...(x.allowDestructive === true ? { allowDestructive: true } : {}),
      ...(x.dialogs === undefined ? {} : { dialogs: x.dialogs as DialogPolicy }),
      ...(x.allowWrites === true ? { allowWrites: true } : {}),
      ...(x.allowWrite === undefined ? {} : { allowWrite: x.allowWrite }),
      ...(x.hangReplayWrites === true ? { hangReplayWrites: true } : {}),
      ...(x.longPollMs === undefined ? {} : { longPollMs: x.longPollMs }),
    });
  }
  // #142: an item's (or its target's) log sources replace targets.json's, as `--log-source` does.
  let serverLog = p.serverLog;
  if (x.logSource !== undefined || x.logDefect !== undefined) {
    const allowLogCmd = x.allowLogCmd ?? false;
    serverLog = {
      sources: parseLogSourceSpecs(x.logSource ?? [], allowLogCmd),
      logDefect: parseLogDefectSpecs(x.logDefect ?? []),
      allowLogCmd,
      quietOk: x.logQuietOk ?? [],
      logIgnore: parseLogIgnoreSpecs(x.logIgnore ?? []),
      logScope: parseLogScopeSpecs(x.logScope ?? []),
      correlationHeaders: parseCorrelationHeaders(x.logCorrelationHeader ?? []),
      idPatterns: parseLogIdPatterns(x.logIdPattern ?? []),
      ...(x.serverLogDrainMs === undefined ? {} : { drainMs: x.serverLogDrainMs }),
      logClasses: loadLogClassRules(),
    };
  }
  // #313: an item's `logTriage` turns triage on (or, `false`, off) over whichever log sources apply.
  if (serverLog !== undefined && x.logTriage !== undefined) {
    const { triage: _drop, ...rest } = serverLog;
    serverLog = x.logTriage ? { ...rest, triage: {} } : rest;
  }
  const actors = x.actor === undefined ? null : resolveMissionActors(x.actor);
  if (actors !== null) {
    checkActorsAgainstSpec(actors, p.invariants);
    storageState = actors.primary.storageState;
  }
  const personas = [...(x.persona ?? []).map((s) => parsePersonaSpec(s)), ...(x.personas === undefined ? [] : loadPersonasFile(x.personas))];
  const seen = new Set<string>();
  for (const q of personas) {
    if (seen.has(q.name)) throw new Error(`persona ${q.name} is declared twice`);
    seen.add(q.name);
  }
  let fixtures: FixtureSource | undefined;
  if (kind === "goal") {
    const flags: FixtureFlags = {
      ...((item.fixtures ?? p.fixturesFile) === undefined ? {} : { fixtures: item.fixtures ?? p.fixturesFile }),
      ...(x.before === undefined ? {} : { before: x.before }),
      ...(x.after === undefined ? {} : { after: x.after }),
      ...(x.allowShellHooks === undefined ? {} : { allowShellHooks: x.allowShellHooks }),
      ...(x.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: String(x.hookTimeoutMs) }),
      ...(x.fixtureIdentity === undefined ? {} : { fixtureIdentity: x.fixtureIdentity }),
    };
    fixtures = { allowlist: p.allowlist, flags, ...(storageState === undefined ? {} : { storageState }), secretFields };
    // Validated now (the spec, and every ${setup.x} the goal uses), before anything runs.
    checkSetupRefs(refs?.texts ?? {}, fixturesFor(fixtures, refs?.url ?? t.url));
  }
  const coverageThresholds =
    kind === "adversarial" && (x.minControlCoverage !== undefined || x.requireFormSubmit !== undefined)
      ? resolveCoverageThresholds({
          ...(x.minControlCoverage === undefined ? {} : { minControlRatio: x.minControlCoverage }),
          ...(x.requireFormSubmit === undefined ? {} : { requireFormSubmit: x.requireFormSubmit }),
        })
      : undefined;
  return {
    x,
    ...(storageState === undefined ? {} : { storageState }),
    secretFields,
    ...(secrets === undefined ? {} : { secrets }),
    ...(config === undefined ? {} : { config }),
    ...(serverLog === undefined ? {} : { serverLog }),
    ...(actors === null ? {} : { actors }),
    ...(personas.length === 0 ? {} : { personas }),
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(coverageThresholds === undefined ? {} : { coverageThresholds }),
  };
}

export interface Planned {
  readonly t: PreparedTarget;
  readonly kind: ItemKind;
  readonly name: string;
  readonly strategy?: string;
  readonly needsAi: boolean;
  readonly skipped?: string;
  readonly journey?: SuiteJourney;
  readonly goal?: SuiteGoal;
  readonly mission?: SuiteMission;
  readonly verify?: SuiteVerifyFix;
  /** Goal and mission items: what they run with (#195). */
  readonly setup?: ItemSetup;
  /** A persona matrix cell: the persona this item runs as (#143/#195). */
  readonly persona?: Persona;
}

/** The implicit invariant sweep: a target with invariants but no goal or mission gets one. */
function invariantSweep(): SuiteMission {
  return { name: "invariants", strategy: "feature", feature: "invariants" };
}

export async function prepareTarget(t: SuiteTarget, opts: RunCheckOptions): Promise<PreparedTarget> {
  const allowlist = resolveExploreAllowlist(t.url, t.allow);
  // #147/#195: every observer a goal item (or the target's default) declares may be named by the invariants.
  const observers = new Set(
    [t.explore?.actor, ...t.goals.map((g) => g.explore?.actor)].flatMap((a) => (a ?? []).slice(1).map((spec) => spec.slice(0, spec.indexOf("=")))),
  );
  let invariants: InvariantSpec | undefined;
  try {
    invariants = loadInvariantFiles(t.invariants, { allowlist, baseUrl: t.url, ...(observers.size === 0 ? {} : { observers: [...observers] }) });
  } catch (e) {
    throw new CheckPreflightError(`target ${t.name}: ${errorMessage(e)}`);
  }
  if (t.storageState !== undefined && !existsSync(t.storageState)) {
    throw new CheckPreflightError(`target ${t.name}: storage state not found: ${t.storageState}`);
  }
  const goals = new Map<string, SuccessCheck[]>();
  for (const g of t.goals) {
    try {
      goals.set(g.name, g.success.map(parseSuccessSpec));
    } catch (e) {
      throw new CheckPreflightError(`target ${t.name}: goal ${g.name}: ${errorMessage(e)}`);
    }
    // #218: the URL the goal actually starts at (its own, else the target's) — an `allow` list
    // REPLACES the target URL's own origin, so the target URL itself may be off it.
    const goalUrl = g.url ?? t.url;
    if (!allowlist.includes(new URL(goalUrl).origin)) {
      throw new CheckPreflightError(`target ${t.name}: goal ${g.name}: ${goalUrl} is not on the target's allowlist`);
    }
  }
  const sweep = t.missions.length === 0 && t.goals.length === 0 && invariants !== undefined ? [invariantSweep()] : [];
  const prefixes = new Map<SuiteMission, JourneyPrefix>();
  const expanded = new Map<SuiteMission, SuiteMission[]>();
  for (const m of [...t.missions, ...sweep]) {
    // #293: a journey-anchored mission — its Journey, step, params and environment, refused now if
    // unusable; it starts where the prefix lands, which (with every origin the prefix may visit)
    // must be on the target's allowlist.
    if (m.fromJourney !== undefined && m.atStep !== undefined) {
      const fromJourney = m.fromJourney;
      try {
        const env = resolveJourneyEnvironment({
          ...(m.env === undefined ? {} : { env: m.env }),
          ...(m.baseUrl === undefined ? {} : { baseUrl: m.baseUrl }),
          ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }),
          targets: opts.targetsConfig ?? {},
        });
        const session = sessionOf(t, m.storageState) ?? (m.storageState === null ? undefined : env?.storageState);
        const dir = t.journeysDir ?? opts.journeysDir;
        // #293 sweep: `atStep` "all"/"anchors" expands into one item per stop point, the item's
        // maxActions/maxDecisions split evenly over them (each a fresh session, restored by the target's fixtures).
        let derived: SuiteMission[] = [m];
        if (isSweepMode(m.atStep)) {
          const j = await new JourneyRegistry(new FsJourneyStore(dir)).get(fromJourney);
          if (j === null || j === undefined) throw new Error(`unknown journey '${fromJourney}'`);
          const stops = sweepStops(applyJourneyEnvironment(j, env), m.atStep);
          derived = stops.map((stop) => ({
            ...m,
            atStep: stop,
            name: `${m.name}@${stop}`,
            ...(m.maxActions === undefined ? {} : { maxActions: splitBudget(m.maxActions, stops.length) }),
            ...(m.maxDecisions === undefined ? {} : { maxDecisions: splitBudget(m.maxDecisions, stops.length) }),
          }));
        }
        for (const dm of derived) {
          const prefix = await resolveJourneyPrefix({
            dir,
            id: fromJourney,
            atStep: dm.atStep!,
            params: { ...(m.params ?? {}) },
            ...(env === undefined ? {} : { environment: env }),
            ...(session === undefined ? {} : { storageState: session }),
            ...(opts.sitePolicyDbPath === undefined ? {} : { dbPath: opts.sitePolicyDbPath }),
            environmentFlags: { ...(m.env === undefined ? {} : { env: m.env }), ...(m.baseUrl === undefined ? {} : { baseUrl: m.baseUrl }) },
          });
          const off = [new URL(prefix.startUrl).origin, ...prefix.allowedOrigins].filter((o) => !allowlist.includes(o));
          if (off.length > 0) throw new Error(`Journey ${fromJourney} runs on ${off.join(", ")}, which is not on the target's allowlist`);
          if (prefix.secrets.length > 0 && (m.strategy === "coverage" || m.strategy === "exploratory")) {
            throw new Error(`Journey ${fromJourney} types a secret param before its anchor; strategy ${m.strategy} cannot redact it`);
          }
          prefixes.set(dm, prefix);
        }
        expanded.set(m, derived);
      } catch (e) {
        throw new CheckPreflightError(`target ${t.name}: mission ${m.name}: ${errorMessage(e)}`);
      }
      continue;
    }
    const missionUrl = m.url ?? t.url;
    if (!allowlist.includes(new URL(missionUrl).origin)) {
      throw new CheckPreflightError(`target ${t.name}: mission ${m.name}: ${missionUrl} is not on the target's allowlist`);
    }
    // #225: a usability mission's success checks are refused up front when unparseable, like a goal's.
    try {
      for (const spec of m.success ?? []) parseSuccessSpec(spec);
    } catch (e) {
      throw new CheckPreflightError(`target ${t.name}: mission ${m.name}: ${errorMessage(e)}`);
    }
  }
  for (const v of t.verifyFix) {
    if (!existsSync(v.result)) throw new CheckPreflightError(`target ${t.name}: verify-fix ${v.name}: result not found: ${v.result}`);
    // #218: the same lookup `verify-fix` does, up front — a fingerprint the result does not hold
    // (or a result it cannot use) is a suite error, refused before anything runs, never an ERROR item.
    try {
      const mission = parsePersistedMission(JSON.parse(readFileSync(v.result, "utf8")));
      if (findFinding(mission, v.fingerprint) === undefined) throw new Error(`no finding with fingerprint ${v.fingerprint} in ${v.result}`);
      assertAuthorizedExploreTarget(mission.target.seedUrl, mission.target.allowlist);
    } catch (e) {
      throw new CheckPreflightError(`target ${t.name}: verify-fix ${v.name}: ${errorMessage(e)}`);
    }
  }
  const journeys = new Map<string, Journey>();
  const environments = new Map<SuiteJourney, ResolvedJourneyEnvironment>();
  if (t.journeys.length > 0) {
    const registry = new JourneyRegistry(new FsJourneyStore(t.journeysDir ?? opts.journeysDir));
    for (const sj of t.journeys) {
      const j = await registry.get(sj.id);
      if (j === null || j === undefined) throw new CheckPreflightError(`target ${t.name}: unknown Journey ${JSON.stringify(sj.id)}`);
      if (!j.metadata.promoted) throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id} is not promoted`);
      // #247: an item's `env`/`baseUrl` — resolved and the Journey rebased onto it now, so an unknown
      // environment or a step on an origin it does not allow refuses the suite before anything runs.
      let env: ResolvedJourneyEnvironment | undefined;
      try {
        env = resolveJourneyEnvironment({
          ...(sj.env === undefined ? {} : { env: sj.env }),
          ...(sj.baseUrl === undefined ? {} : { baseUrl: sj.baseUrl }),
          ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }),
          targets: opts.targetsConfig ?? {},
        });
        applyJourneyEnvironment(j, env);
      } catch (e) {
        if (!isEnvironmentError(e)) throw e;
        throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id}: ${e.message}`);
      }
      if (env !== undefined) environments.set(sj, env);
      let origin: string;
      try {
        origin = new URL(env?.baseUrl ?? j.recording.site).origin;
      } catch {
        throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id} has no site origin (${JSON.stringify(j.recording.site)})`);
      }
      if (!allowlist.includes(origin)) {
        throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id} runs on ${origin}, which is not on the target's allowlist`);
      }
      journeys.set(sj.id, j);
    }
  }
  let config: TargetConfig | undefined;
  try {
    config = resolveTargetConfig(opts.targetsConfig ?? {}, new URL(t.url).origin);
  } catch (e) {
    throw new CheckPreflightError(`target ${t.name}: ${errorMessage(e)}`);
  }
  // #170: secret fields are read from the environment now (an unset variable is a preflight
  // refusal naming it, never its value); the fixtures spec and every ${setup.x} a goal uses are
  // validated before anything runs.
  let secretFields: SecretField[];
  try {
    secretFields = (t.secretFields ?? []).map((s) => parseSecretField(s, "value", opts.env ?? process.env));
  } catch (e) {
    if (!(e instanceof SecretFieldSpecError)) throw e;
    throw new CheckPreflightError(`target ${t.name}: ${e.message}`);
  }
  let invariantAuthTokens: Map<string, string> | undefined;
  let serverLog: ServerLogOptions | undefined;
  try {
    invariantAuthTokens = invariants === undefined ? undefined : resolveInvariantAuthTokens(invariants, opts.env ?? process.env);
    serverLog = serverLogFromTargetConfig(opts.targetsConfig, t.url);
  } catch (e) {
    throw new CheckPreflightError(`target ${t.name}: ${errorMessage(e)}`);
  }
  const fixturesFile = t.fixtures ?? config?.fixtures;
  if (fixturesFile !== undefined) {
    // The target's own spec (around Journeys; goals validate theirs in their item setup).
    try {
      fixturesFor({ allowlist, flags: { fixtures: fixturesFile }, secretFields, ...(t.storageState === undefined ? {} : { storageState: t.storageState }) }, t.url);
    } catch (e) {
      if (!(e instanceof FixtureSpecError || e instanceof UnboundSetupRefError)) throw e;
      throw new CheckPreflightError(`target ${t.name}: fixtures: ${e.message}`);
    }
  }
  return {
    target: t,
    allowlist,
    journeys,
    ...(environments.size === 0 ? {} : { environments }),
    goals,
    ...(invariants === undefined ? {} : { invariants }),
    ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { invariantAuthTokens }),
    ...(serverLog === undefined ? {} : { serverLog }),
    config,
    secretFields,
    ...(fixturesFile === undefined ? {} : { fixturesFile }),
    ...(prefixes.size === 0 ? {} : { prefixes, expanded }),
  };
}

/** The item's setup, a refusal naming its path-precise location (#213: like every other suite refusal), before anything runs. */
function setupOrRefuse(label: string, run: () => ItemSetup): ItemSetup {
  try {
    return run();
  } catch (e) {
    const fixtures = e instanceof FixtureSpecError || e instanceof UnboundSetupRefError ? "fixtures: " : "";
    throw new CheckPreflightError(`${label}: ${fixtures}${errorMessage(e)}`);
  }
}

/** One planned item per persona (each from its own session, gated on its own), else the item itself. */
function perPersona(item: Planned): Planned[] {
  const personas = item.setup?.personas;
  if (personas === undefined || item.setup === undefined) return [item];
  const setup = item.setup;
  return personas.map((q) => ({
    ...item,
    name: `${item.name}@${q.name}`,
    persona: q,
    setup: { ...setup, storageState: q.storageState, ...(setup.fixtures === undefined ? {} : { fixtures: { ...setup.fixtures, storageState: q.storageState } }) },
  }));
}

export function plan(prepared: readonly PreparedTarget[], changed: readonly string[] | undefined, opts: RunCheckOptions): Planned[] {
  const out: Planned[] = [];
  const skip = (routes: readonly string[] | undefined): string | undefined =>
    changed === undefined || changed.length === 0 || affectedBy(routes, changed) ? undefined : `not affected by --changed-routes ${changed.join(",")}`;
  prepared.forEach((p, ti) => {
    const t = p.target;
    for (const sj of t.journeys) {
      const j = p.journeys.get(sj.id);
      const routes = sj.routes ?? (j === undefined ? undefined : journeyRoutes(j));
      const s = skip(routes);
      out.push({ t: p, kind: "journey", name: sj.id, journey: sj, needsAi: false, ...(s === undefined ? {} : { skipped: s }) });
    }
    t.goals.forEach((g, gi) => {
      const s = skip(g.routes ?? [pathOf(g.url ?? t.url)]);
      const texts = { [`goal ${g.name} url`]: g.url, [`goal ${g.name}`]: g.goal, [`goal ${g.name} success`]: g.success };
      const setup = setupOrRefuse(`$.targets[${ti}].goals[${gi}]`, () => itemSetup(p, g, "goal", opts, { url: g.url ?? t.url, texts }));
      out.push(...perPersona({ t: p, kind: "goal", name: g.name, goal: g, needsAi: true, setup, ...(s === undefined ? {} : { skipped: s }) }));
    });
    const missions = t.missions.length === 0 && t.goals.length === 0 && p.invariants !== undefined ? [invariantSweep()] : t.missions;
    missions.forEach((m0, mi) => {
      for (const m of p.expanded?.get(m0) ?? [m0]) {
        const setup = setupOrRefuse(`$.targets[${ti}].missions[${mi}]`, () => itemSetup(p, m, m.strategy, opts));
        out.push(...perPersona({ t: p, kind: "mission", name: m.name, strategy: m.strategy, mission: m, needsAi: m.strategy !== "feature", setup }));
      }
    });
    for (const v of t.verifyFix) out.push({ t: p, kind: "verify-fix", name: v.name, verify: v, needsAi: false });
  });
  return out;
}

/** #453: the self-heal a check re-runs a quarantined Journey with — validated, and the change scope read, ONCE. */
export interface PreparedHeal {
  readonly mode: SelfHealMode;
  readonly scope: ChangeScope;
  readonly budget: HealBudget;
}

/**
 * `check --self-heal`: refuses (before anything runs) a heal without a change context, a bad range,
 * or no gateway; then reads the change scope once (git root of the default journeys dir). Absent
 * `opts.selfHeal`: undefined — every Journey fails closed.
 */
export async function prepareSelfHeal(opts: RunCheckOptions): Promise<PreparedHeal | undefined> {
  const req = opts.selfHeal;
  if (req === undefined || req.selfHeal === "fail-closed") return undefined;
  try {
    validateJourneyHeal(req);
  } catch (e) {
    if (e instanceof JourneyHealArgsError) throw new CheckArgsError(e.message);
    throw e;
  }
  if (opts.aiMode === undefined || opts.gateways === undefined) {
    throw new CheckAiSetupError("--self-heal needs a model gateway for its candidate ranking: pass --real or --fake-ai (or set \"ai\" in the suite)");
  }
  return { mode: req.selfHeal, scope: await readJourneyChangeScope(req, opts.journeysDir, opts.changeGitExec), budget: journeyHealBudget(req) };
}
