import { readFile } from "node:fs/promises";
import { resolveTargetConfig, type TargetConfig } from "./target-config.js";
import { existsSync } from "node:fs";
import { InvariantSpecSchema, RecordingSchema, validateInvariantSpec, type InvariantSpec, type Recording, type RecordingEmulation } from "@jevitate/recording";
import { loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { buildMissionFixtures, type FixtureFlags } from "./fixture-cli.js";
import { observerSessions } from "./mission-actors.js";
import {
  FixtureSpecError,
  fixtureReplayOpener,
  hookHash,
  loadFixtureFile,
  parseFixtureSpec,
  type FixtureRecord,
  type FixtureSpec,
  type MissionFixtures,
} from "./mission-fixtures.js";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserLaunchOptions, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import {
  assertAuthorizedExploreTarget,
  verifyFix,
  type HangSignal,
  type VerifyFixResult,
  type VerifyFixVerdict,
  type VerifySession,
} from "@jevitate/explore";
import { verifyServerLogDefect } from "./server-log-verify.js";

/**
 * The programmatic surface behind `jevitate verify-fix` and the MCP `verify_fix` tool: loads a
 * finished mission's persisted typed result (`<stem>.result.json`), finds the defect by
 * fingerprint, and replays its reproduction in a FRESH browser session (`@jevitate/explore`'s
 * `verifyFix`, which reuses the Recording interpreter). The replay is authorized against the
 * mission's own allowlist before any browser opens.
 *
 * Exit codes: 0 fixed · 1 still reproduces · 2 inconclusive (the replay could not reach the
 * defect's step, or the input was unusable) · 4 intermittent (the signal fired on some but not
 * all fresh-context replays — #74; mirrors the mission `intermittent` hang outcome) — a broken or
 * flaky check never reads as "fixed".
 */

export const VERIFY_FIX_EXIT_CODES: Readonly<Record<VerifyFixVerdict, number>> = {
  fixed: 0,
  "still-reproduces": 1,
  inconclusive: 2,
  intermittent: 4,
};

export interface RunVerifyFixOptions {
  /** Path of the mission's `<stem>.result.json`. */
  readonly resultPath: string;
  /** The defect (or hang) fingerprint to verify. */
  readonly fingerprint: string;
  /** Overrides the storageState recorded with the mission (CLI `--storage-state`). */
  readonly storageState?: string;
  readonly browserPortFactory?: () => BrowserPort;
  readonly browser?: BrowserLaunchOptions;
  /** Settle ceiling after the replay (ms). */
  readonly settleCeilingMs?: number;
  /** Per-target settle/hang configuration, keyed by origin (`~/.jevitate/targets.json`). */
  readonly targets?: Readonly<Record<string, TargetConfig>>;
  /** Fresh-context replays for a non-hang defect signal (#74, CLI `--replays`). Default 3. */
  readonly replays?: number;
  /**
   * Invariant files (CLI `--invariants`, #86) to re-check a declared-invariant defect with, instead of
   * the spec persisted with the mission. Validated against the MISSION's allowlist before any replay.
   */
  readonly invariantFiles?: readonly string[];
  /** Re-checking a `server-log` defect whose sources include a `cmd:` one needs this too (#142). */
  readonly allowLogCmd?: boolean;
  /** `--hang-replay-writes` (#153): a hang's replay may re-send a paid/destructive write. */
  readonly hangReplayWrites?: boolean;
  /**
   * Mission fixtures (#140/#144): every replay restores + re-runs the mission's own fixture (saved
   * with its result) so it starts from the same state. `fixtures` overrides the saved spec; the
   * mission's shell hooks are never replayed from the file — the operator re-supplies the SAME
   * `before`/`after` (checked by hash) with `allowShellHooks`.
   */
  readonly fixtureFlags?: FixtureFlags;
  /** Values redacted from everything the fixture logs (CLI `--secret`). */
  readonly secrets?: readonly string[];
  /**
   * Explicit `--viewport` / `--device` override (#149). Defaults to the finding's OWN recorded
   * emulation (`recording.emulation`) — a 375px defect replays at 375px, not the caller's desktop
   * default. An override that DIFFERS from the recorded emulation is refused (fails closed) unless
   * `allowEmulationOverride` is set: replaying at the wrong device could report a false "fixed".
   */
  readonly emulation?: EmulationSpec;
  /** Replay at `emulation` even though it differs from the finding's recorded emulation. */
  readonly allowEmulationOverride?: boolean;
}

export interface VerifyFixReport extends VerifyFixResult {
  readonly exitCode: number;
  readonly title?: string;
  /** The fixture every replay started from (#140/#144): the mission's identity and this run's setup/restore log. */
  readonly fixtures?: FixtureRecord & { readonly missionIdentity: string };
}

export class VerifyFixInputError extends Error {
  readonly code = "E_VERIFY_FIX_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "VerifyFixInputError";
  }
}

export interface PersistedFinding {
  readonly fingerprint: string;
  readonly related?: readonly string[];
  readonly kind: string;
  readonly title?: string;
  readonly repro: { readonly recordingStepIndex: number };
  /** For a hang finding: its signal (what the replay must no longer show). */
  readonly hang?: HangSignal;
  /** The finding's own Recording (found after a reset / on a coverage path), when it has one. */
  readonly recording?: Recording;
  /** How many times the mission's OWN run hit this same finding (its `occurrences`), when recorded. */
  readonly occurrences?: number;
  /** For a declared-invariant defect (#86): the invariant id to re-check. */
  readonly invariantId?: string;
  /** For a `server-log` defect (#142): what to re-tail and match, from the defect's own `serverLog`. */
  readonly serverLog?: { readonly sources: readonly string[]; readonly matcher: string; readonly normalizedMessage: string; readonly drainMs: number };
}

const HANG_KINDS = new Set(["main-thread-unresponsive", "request-pending", "never-settled", "ui-no-progress"]);

/** A persisted hang signal, validated just enough to re-check it (fail closed otherwise). */
function asHangSignal(v: unknown): HangSignal | null {
  if (!isRecord(v) || typeof v.kind !== "string" || !HANG_KINDS.has(v.kind)) return null;
  const last = v.lastState;
  if (!isRecord(last) || typeof last.signature !== "string" || !Array.isArray(last.controls)) return null;
  if (typeof v.detail !== "string" || typeof v.route !== "string" || typeof v.url !== "string" || !Array.isArray(v.pending)) {
    return null;
  }
  return v as unknown as HangSignal;
}

/** #147: a persisted actor — its name, role and storageState PATH (never its contents). */
export interface PersistedActor {
  readonly name: string;
  readonly storageStatePath: string;
  readonly role: "primary" | "observer";
}

export interface PersistedMission {
  readonly recording: Recording | null;
  readonly target: {
    readonly seedUrl: string;
    readonly allowlist: string[];
    readonly storageStatePath?: string;
    /** #147: the mission's actors (`--actor`), when it had any. */
    readonly actors?: readonly PersistedActor[];
  };
  readonly findings: PersistedFinding[];
  /** The declared-invariant spec the mission evaluated (#86), when it had one and it still validates. */
  readonly invariantSpec?: InvariantSpec;
  /** The mission's fixture (#140/#144): spec (re-validated before use), hook hashes and recorded outputs. */
  readonly fixtures?: PersistedMissionFixtures;
}

interface PersistedMissionFixtures {
  readonly identity: string;
  readonly spec?: unknown;
  readonly hooks: { readonly before?: string; readonly after?: string };
  readonly outputs: Readonly<Record<string, string>>;
}

function asPersistedFixtures(v: unknown): PersistedMissionFixtures | undefined {
  if (!isRecord(v) || typeof v.identity !== "string") return undefined;
  const hooks = isRecord(v.hooks) ? v.hooks : {};
  const outputs = isRecord(v.outputs) ? v.outputs : {};
  return {
    identity: v.identity,
    ...(v.spec === undefined ? {} : { spec: v.spec }),
    hooks: {
      ...(typeof hooks.before === "string" ? { before: hooks.before } : {}),
      ...(typeof hooks.after === "string" ? { after: hooks.after } : {}),
    },
    outputs: Object.fromEntries(Object.entries(outputs).filter((e): e is [string, string] => typeof e[1] === "string")),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A persisted `server-log` defect's re-check spec (#142), validated just enough to replay it. */
function asServerLog(v: unknown): PersistedFinding["serverLog"] | null {
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.sources) || !v.sources.every((s): s is string => typeof s === "string")) return null;
  if (typeof v.matcher !== "string" || typeof v.normalizedMessage !== "string" || typeof v.drainMs !== "number") return null;
  return { sources: v.sources, matcher: v.matcher, normalizedMessage: v.normalizedMessage, drainMs: v.drainMs };
}

function asFinding(v: unknown): PersistedFinding | null {
  if (!isRecord(v) || typeof v.fingerprint !== "string" || typeof v.kind !== "string") return null;
  const repro = v.repro;
  if (!isRecord(repro) || typeof repro.recordingStepIndex !== "number") return null;
  const hang = v.kind === "hang" ? asHangSignal(v.signal) : null;
  if (v.kind === "hang" && hang === null) return null;
  const serverLog = v.kind === "server-log" ? asServerLog(v.serverLog) : null;
  if (v.kind === "server-log" && serverLog === null) return null;
  const own = repro.recording === undefined ? undefined : RecordingSchema.safeParse(repro.recording);
  if (own !== undefined && !own.success) return null; // a finding whose repro cannot be trusted is skipped
  return {
    ...(own?.success === true ? { recording: own.data } : {}),
    fingerprint: v.fingerprint,
    kind: v.kind,
    repro: { recordingStepIndex: repro.recordingStepIndex },
    ...(hang === null ? {} : { hang }),
    ...(serverLog === null ? {} : { serverLog }),
    ...(Array.isArray(v.related) ? { related: v.related.filter((r): r is string => typeof r === "string") } : {}),
    ...(typeof v.title === "string" ? { title: v.title } : {}),
    ...(typeof v.occurrences === "number" ? { occurrences: v.occurrences } : {}),
    ...(v.kind === "invariant" && isRecord(v.invariant) && typeof v.invariant.id === "string" ? { invariantId: v.invariant.id } : {}),
  };
}

/** Parses a persisted mission result, failing closed on anything it cannot trust. */
export function parsePersistedMission(raw: unknown): PersistedMission {
  if (!isRecord(raw) || !isRecord(raw.result)) throw new VerifyFixInputError("not a mission result file");
  const result = raw.result;
  const target = result.target;
  if (!isRecord(target) || typeof target.seedUrl !== "string" || !Array.isArray(target.allowlist)) {
    throw new VerifyFixInputError("the mission result has no replay target (seedUrl/allowlist)");
  }
  // A run's own Recording (a coverage run has none; its findings carry their path).
  const recording = result.recording === null || result.recording === undefined ? null : RecordingSchema.parse(result.recording);
  const findings: PersistedFinding[] = [];
  for (const list of [result.defects, result.hangs, result.serverLogDefects]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const f = asFinding(item);
      if (f !== null) findings.push(f);
    }
  }
  // A persisted spec that no longer validates is dropped: its defects are then inconclusive, never fixed.
  const spec = result.invariantSpec === undefined ? undefined : InvariantSpecSchema.safeParse(result.invariantSpec);
  const fixtures = asPersistedFixtures(result.fixtures);
  const actors = Array.isArray(target.actors)
    ? target.actors.flatMap((a): PersistedActor[] =>
        isRecord(a) && typeof a.name === "string" && typeof a.storageStatePath === "string" && (a.role === "primary" || a.role === "observer")
          ? [{ name: a.name, storageStatePath: a.storageStatePath, role: a.role }]
          : [],
      )
    : [];
  return {
    ...(spec?.success === true ? { invariantSpec: spec.data } : {}),
    ...(fixtures === undefined ? {} : { fixtures }),
    recording,
    target: {
      seedUrl: target.seedUrl,
      allowlist: target.allowlist.filter((a): a is string => typeof a === "string"),
      ...(typeof target.storageStatePath === "string" ? { storageStatePath: target.storageStatePath } : {}),
      ...(actors.length === 0 ? {} : { actors }),
    },
    findings,
  };
}

/**
 * The one place a mission's findings (declared-invariant defects, hangs, adversarial defects) are
 * looked up by fingerprint — a fingerprint the CALLER supplied may equal the finding's own, or one
 * of its `related` fingerprints (the same underlying defect observed at a different point). Shared
 * by `verify-fix` and `regression capture` (#119/#129): the latter reuses this lookup rather than
 * re-implementing "is this fingerprint a defect this mission found" itself.
 */
export function findFinding(mission: PersistedMission, fingerprint: string): PersistedFinding | undefined {
  return mission.findings.find((f) => f.fingerprint === fingerprint || (f.related ?? []).includes(fingerprint));
}

/** Whether an explicit `--viewport`/`--device` matches a finding's recorded emulation (#149). */
function emulationMatchesRecorded(explicit: EmulationSpec, recorded: RecordingEmulation): boolean {
  if (explicit.device !== undefined || recorded.device !== undefined) return explicit.device === recorded.device;
  if (explicit.viewport === undefined) return true;
  return explicit.viewport.width === recorded.viewport.width && explicit.viewport.height === recorded.viewport.height;
}

function describeEmulation(e: RecordingEmulation): string {
  return e.device !== undefined ? `--device "${e.device}"` : `--viewport ${e.viewport.width}x${e.viewport.height}`;
}

export async function runVerifyFix(opts: RunVerifyFixOptions): Promise<VerifyFixReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(opts.resultPath, "utf8"));
  } catch (e) {
    throw new VerifyFixInputError(`cannot read mission result ${opts.resultPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const mission = parsePersistedMission(raw);
  const finding = findFinding(mission, opts.fingerprint);
  if (finding === undefined) {
    throw new VerifyFixInputError(`no finding with fingerprint ${opts.fingerprint} in ${opts.resultPath}`);
  }
  // Guardrail #1: the replay may only ever touch the mission's own authorized origins.
  const origin = assertAuthorizedExploreTarget(mission.target.seedUrl, mission.target.allowlist);
  const storageState = opts.storageState ?? mission.target.storageStatePath;
  if (storageState !== undefined && !existsSync(storageState)) {
    throw new VerifyFixInputError(`storage state not found: ${storageState}`);
  }

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const target = resolveTargetConfig(opts.targets ?? {}, origin);
  const perceiveOpts = {
    ...(opts.settleCeilingMs === undefined ? {} : { renderWaitMs: opts.settleCeilingMs }),
    ...(target.settle === undefined ? {} : { settleConfig: target.settle }),
    ...(target.hangs === undefined ? {} : { hangConfig: target.hangs }),
  };
  const recording = finding.recording ?? mission.recording;
  if (recording === null) throw new VerifyFixInputError(`finding ${finding.fingerprint} has no Recording to replay`);
  // #149: replay under the finding's OWN recorded emulation by default — a 375px defect reproduces
  // at 375px, not the caller's desktop default. An explicit --viewport/--device that DIFFERS from
  // it fails closed (never silently "verifies fixed" at the wrong device) unless overridden.
  const recordedEmulation = recording.emulation;
  let effectiveEmulation: EmulationSpec | undefined;
  if (opts.emulation !== undefined) {
    if (recordedEmulation !== undefined && !emulationMatchesRecorded(opts.emulation, recordedEmulation) && opts.allowEmulationOverride !== true) {
      throw new VerifyFixInputError(
        `--viewport/--device differs from the finding's recorded emulation (${describeEmulation(recordedEmulation)}); ` +
          "pass allowEmulationOverride (CLI --allow-emulation-override) to replay at a different emulation anyway",
      );
    }
    effectiveEmulation = opts.emulation;
  } else if (recordedEmulation !== undefined) {
    effectiveEmulation = recordedEmulation.device !== undefined ? { device: recordedEmulation.device } : { viewport: recordedEmulation.viewport };
  }
  resolveEmulation(effectiveEmulation); // refused BEFORE any browser opens (an unknown device, e.g.)
  // A declared-invariant defect (#86) is re-checked with the same spec (or `--invariants`), its probes
  // authorized against the MISSION's own origins before any browser opens.
  let invariantSpec: InvariantSpec | undefined;
  // #135: authFrom.secret refs (env:VAR), resolved from the environment HERE — the one place this
  // package reads process.env for invariants — never inside @jevitate/explore or @jevitate/recording.
  let invariantAuthTokens: Map<string, string> | undefined;
  // #147: a cross-actor defect is re-checked from the SAME observers, each in a fresh context per replay.
  const observers = (mission.target.actors ?? []).filter((a) => a.role === "observer");
  for (const o of observers) {
    if (!existsSync(o.storageStatePath)) throw new VerifyFixInputError(`actor ${o.name}: storage state not found: ${o.storageStatePath}`);
  }
  try {
    const bounds = { allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl, observers: observers.map((o) => o.name) };
    invariantSpec =
      opts.invariantFiles !== undefined && opts.invariantFiles.length > 0
        ? loadInvariantFiles(opts.invariantFiles, bounds)
        : mission.invariantSpec === undefined
          ? undefined
          : validateInvariantSpec(mission.invariantSpec, bounds);
    invariantAuthTokens = invariantSpec === undefined ? undefined : resolveInvariantAuthTokens(invariantSpec, process.env);
  } catch (e) {
    throw new VerifyFixInputError(e instanceof Error ? e.message : String(e));
  }
  const authTokenValues = [...(invariantAuthTokens?.values() ?? [])];
  const primaryActor = mission.target.actors?.find((a) => a.role === "primary")?.name;
  const fx = missionFixtures(mission, opts.fixtureFlags ?? {}, storageState, [...(opts.secrets ?? []), ...authTokenValues]);
  const declared =
    finding.kind === "invariant" && finding.invariantId !== undefined && invariantSpec !== undefined
      ? {
          spec: invariantSpec,
          id: finding.invariantId,
          allowlist: mission.target.allowlist,
          baseUrl: mission.target.seedUrl,
          ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { authTokens: invariantAuthTokens }),
          ...(observers.length === 0
            ? {}
            : {
                openObservers: () =>
                  observerSessions(
                    portFactory,
                    { headless: true, allowedOrigins: [...mission.target.allowlist], baseUrl: origin, ...opts.browser },
                    observers.map((o) => ({ name: o.name, storageState: o.storageStatePath })),
                  ),
              }),
          ...(primaryActor === undefined ? {} : { primaryActor }),
        }
      : undefined;
  const openSession = async (): Promise<VerifySession> => {
    const session = await portFactory().open({
      headless: true,
      allowedOrigins: [...mission.target.allowlist],
      baseUrl: origin,
      ...opts.browser,
      ...effectiveEmulation,
      ...(storageState !== undefined ? { storageState } : {}),
    });
    const actor = CastActor.named("verify-fix").whoCan(new BrowseTheWeb(session, [...mission.target.allowlist]));
    return { page: session.page, actor, close: () => session.close() };
  };
  // Each replay restores the mission's fixture state first; a failed setup makes that replay
  // "could not open a session" — no evidence, so never `fixed`.
  const replaySession =
    fx === undefined ? openSession : fixtureReplayOpener(openSession, fx, recording.fixture?.outputs ?? mission.fixtures?.outputs ?? {});
  let result: VerifyFixResult;
  try {
    // A `server-log` defect (#142) is re-checked by REPLAYING and re-tailing the SAME log sources —
    // never by `@jevitate/explore`'s `verifyFix`, which only looks at DOM/console/network signals.
    if (finding.kind === "server-log") {
      if (finding.serverLog === undefined) {
        result = {
          fingerprint: finding.fingerprint,
          verdict: "inconclusive",
          observedFingerprints: [],
          replay: { outcome: "failed", at: -1, error: "not replayed" },
          reason: "a server-log defect needs its log source(s) and matcher to be re-checked",
        };
      } else {
        result = await verifyServerLogDefect({
          recording,
          recordingStepIndex: finding.repro.recordingStepIndex,
          fingerprint: finding.fingerprint,
          sources: finding.serverLog.sources,
          matcher: finding.serverLog.matcher,
          normalizedMessage: finding.serverLog.normalizedMessage,
          drainMs: finding.serverLog.drainMs,
          // #142 follow-up: an explicit --allow-log-cmd wins; otherwise the operator's own
          // ~/.jevitate/targets.json entry for this origin may opt in (never an MCP argument).
          allowLogCmd: opts.allowLogCmd === true || target.allowLogCmd === true,
          ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
          ...(opts.replays === undefined ? {} : { replays: opts.replays }),
          openSession: replaySession,
        });
      }
    } else {
      result = await verifyFix({
        perceive: perceiveOpts,
        recording,
        recordingStepIndex: finding.repro.recordingStepIndex,
        fingerprint: finding.fingerprint,
        defectKind: finding.kind,
        ...(declared === undefined ? {} : { invariant: declared }),
        ...(finding.hang === undefined ? {} : { hang: finding.hang }),
        // #153: never re-send a paid/destructive write unless the operator opted in.
        safety: { ...(target.safety ?? {}), ...(opts.hangReplayWrites === true ? { hangReplayWrites: true } : {}) },
        ...(finding.occurrences === undefined ? {} : { occurrences: finding.occurrences }),
        ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
        ...(opts.replays === undefined ? {} : { replays: opts.replays }),
        openSession: replaySession,
      });
    }
  } finally {
    await fx?.restore();
  }
  return {
    ...result,
    exitCode: VERIFY_FIX_EXIT_CODES[result.verdict],
    ...(finding.title === undefined ? {} : { title: finding.title }),
    ...(fx === undefined ? {} : { fixtures: { ...fx.record(), missionIdentity: mission.fixtures?.identity ?? "none" } }),
  };
}

/**
 * The replay fixture: the mission's saved spec (re-validated against the MISSION's allowlist, never
 * trusted as-is) or `--fixtures`, plus the operator's re-supplied shell hooks, which must match the
 * mission's by hash. A mission that ran with a fixture never replays without one.
 */
function missionFixtures(
  mission: PersistedMission,
  flags: FixtureFlags,
  storageState: string | undefined,
  secrets: readonly string[],
): MissionFixtures | undefined {
  const saved = mission.fixtures;
  if (saved === undefined && flags.fixtures === undefined && flags.before === undefined && flags.after === undefined) return undefined;
  const bounds = { allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl };
  const hooks = saved?.hooks ?? {};
  const given = {
    ...(flags.before === undefined ? {} : { before: hookHash(flags.before) }),
    ...(flags.after === undefined ? {} : { after: hookHash(flags.after) }),
  };
  if (given.before !== hooks.before || given.after !== hooks.after) {
    throw new VerifyFixInputError(
      hooks.before === undefined && hooks.after === undefined
        ? "the mission ran without shell hooks; do not pass --before/--after"
        : "the mission ran with --before/--after shell hooks: re-supply the SAME commands with --allow-shell-hooks (they are never replayed from the result file)",
    );
  }
  try {
    const openRefs = { openRefs: hooks.before !== undefined };
    const spec: FixtureSpec | undefined =
      flags.fixtures !== undefined
        ? loadFixtureFile(flags.fixtures, bounds, openRefs)
        : saved?.spec !== undefined
          ? parseFixtureSpec(saved.spec, bounds, openRefs)
          : undefined;
    // `--secret-field` bindings a spec authenticates with come from the same environment variables.
    const names = [...(spec?.setup ?? []), ...(spec?.restore ?? [])].flatMap((s) => (s.auth?.from === "secretField" ? [s.auth.name] : []));
    const secretFields = names.flatMap((name) => {
      const secret = process.env[name];
      return secret === undefined ? [] : [{ descriptor: name, matcher: { key: "name" as const, value: name }, name, kind: "value" as const, secret }];
    });
    const { fixtures: _file, ...hookFlags } = flags;
    return buildMissionFixtures(hookFlags, {
      ...bounds,
      ...(storageState === undefined ? {} : { storageState }),
      secretFields,
      secrets,
      ...(spec === undefined ? {} : { spec }),
    });
  } catch (e) {
    if (e instanceof FixtureSpecError) throw new VerifyFixInputError(`mission fixtures: ${e.message}`);
    throw e;
  }
}
