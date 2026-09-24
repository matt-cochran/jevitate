import type { Command } from "commander";
import type { MissionFailure } from "@jevitate/domain";
import type { SecretField } from "@jevitate/explore";
import {
  FixtureSetupError,
  FixtureSpecError,
  MissionFixtures,
  SETUP_REF,
  UnboundSetupRefError,
  hookHash,
  loadFixtureFile,
  parseFixtureSpec,
  referencedNames,
  type FixtureRecord,
  type FixtureSpec,
  type ShellHooks,
} from "./mission-fixtures.js";

/**
 * The CLI side of mission fixtures (#140/#144): the shared flags, building the lifecycle from them
 * (or from a target's `fixtures` in `~/.jevitate/targets.json`), the static `${setup.x}` checks that
 * run before any browser or request, and the `inconclusive` result a failed setup ends a run with.
 */

export interface FixtureFlags {
  readonly fixtures?: string;
  readonly before?: string;
  readonly after?: string;
  readonly allowShellHooks?: boolean;
  readonly hookTimeoutMs?: string;
}

/** Adds `--fixtures`, `--before`, `--after`, `--allow-shell-hooks` and `--hook-timeout-ms`. */
export function withFixtureFlags(cmd: Command): Command {
  return cmd
    .option(
      "--fixtures <file>",
      "mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from " +
        "--storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>}",
    )
    .option("--before <cmd>", "operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret}")
    .option("--after <cmd>", "operator shell hook run after the mission and every replay (needs --allow-shell-hooks)")
    .option("--allow-shell-hooks", "opt in to running --before/--after (operator commands; never model-chosen)", false)
    .option("--hook-timeout-ms <ms>", "timeout for each --before/--after hook (default 60000; the process group is killed)");
}

export interface FixtureContext {
  readonly allowlist: readonly string[];
  readonly baseUrl: string;
  readonly storageState?: string;
  readonly secretFields?: readonly SecretField[];
  readonly secrets?: readonly string[];
  /** A target's own fixtures file (`~/.jevitate/targets.json`), used when `--fixtures` is absent. */
  readonly targetFixtures?: string;
  /** A spec already validated elsewhere (a persisted mission result), used when no file is given. */
  readonly spec?: FixtureSpec;
}

function hooksOf(flags: FixtureFlags): ShellHooks | undefined {
  if (flags.before === undefined && flags.after === undefined) return undefined;
  const timeoutMs = flags.hookTimeoutMs === undefined ? undefined : Number(flags.hookTimeoutMs);
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
    throw new FixtureSpecError("--hook-timeout-ms must be a positive integer");
  }
  return {
    ...(flags.before === undefined ? {} : { before: flags.before }),
    ...(flags.after === undefined ? {} : { after: flags.after }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** The run's fixture lifecycle, or `undefined` when none was asked for. Throws `FixtureSpecError`. */
export function buildMissionFixtures(flags: FixtureFlags, ctx: FixtureContext): MissionFixtures | undefined {
  const hooks = hooksOf(flags);
  const file = flags.fixtures ?? ctx.targetFixtures;
  const bounds = { allowlist: ctx.allowlist, baseUrl: ctx.baseUrl };
  const spec = file !== undefined ? loadFixtureFile(file, bounds, { openRefs: hooks?.before !== undefined }) : ctx.spec;
  if (spec === undefined && hooks === undefined) return undefined;
  const secretFields = Object.fromEntries((ctx.secretFields ?? []).filter((f) => f.kind === "value").map((f) => [f.name, f.secret]));
  return new MissionFixtures({
    ...bounds,
    ...(spec === undefined ? {} : { spec }),
    ...(hooks === undefined ? {} : { hooks }),
    allowShellHooks: flags.allowShellHooks === true,
    auth: { ...(ctx.storageState === undefined ? {} : { storageStatePath: ctx.storageState }), secretFields },
    ...(ctx.secrets === undefined ? {} : { secrets: ctx.secrets }),
  });
}

/**
 * Before any browser or request: every `${setup.x}` in `texts` must be an output the fixture
 * declares (unless a `--before` hook may bind it), and a run without fixtures may not reference one.
 */
export function checkSetupRefs(texts: Readonly<Record<string, string | readonly string[] | undefined>>, fx: MissionFixtures | undefined): void {
  // `null`: a `--before` hook may bind more names at run time (still checked when substituted).
  const declared = fx === undefined ? new Set<string>() : fx.declaredOutputs();
  const secret = fx?.declaredSecretOutputs() ?? new Set<string>();
  for (const [where, v] of Object.entries(texts)) {
    for (const text of v === undefined ? [] : typeof v === "string" ? [v] : v) {
      for (const name of referencedNames(text)) {
        if (fx === undefined) throw new UnboundSetupRefError(`${where} references \${setup.${name}} but the run has no --fixtures/--before`);
        if (secret.has(name)) {
          throw new UnboundSetupRefError(`${where} references the secret output \${setup.${name}}; secret outputs stay inside the fixture's own requests`);
        }
        if (declared !== null && !declared.has(name)) throw new UnboundSetupRefError(`${where} references \${setup.${name}}, which the fixture does not output`);
      }
    }
  }
}

/** Throws unless a `${setup.*}` reference in `url` leaves its origin fixed (the allowlist is decided before setup runs). */
export function checkUrlRefOrigin(url: string): void {
  if (!url.includes("${setup.")) return;
  try {
    if (new URL(url.replace(SETUP_REF, "0")).origin !== new URL(url.replace(SETUP_REF, "x.evil.test")).origin) throw new Error("origin");
  } catch {
    throw new UnboundSetupRefError("--url: a ${setup.*} reference may fill the path or query, never the origin");
  }
}

/** The typed result a run ends with when its fixture could not be set up: `inconclusive`, a configuration error. */
export interface FixtureSetupFailedResult {
  readonly outcome: "inconclusive";
  readonly reason: string;
  readonly failure: MissionFailure;
  readonly attribution: "configuration";
  readonly exitCode: 2;
  readonly fixtures: FixtureRecord;
}

export function fixtureSetupFailedResult(err: FixtureSetupError | UnboundSetupRefError, fx: MissionFixtures): FixtureSetupFailedResult {
  const reason = err instanceof FixtureSetupError ? err.message : `fixture setup failed: ${err.message}`;
  return {
    outcome: "inconclusive",
    reason,
    failure: { kind: "configuration", message: reason },
    attribution: "configuration",
    exitCode: 2,
    fixtures: fx.record(),
  };
}

/**
 * Regression capture (#144): every reproduce/minimize replay restores + re-runs the fixture the
 * failing Recording was made from. The spec is `--fixtures`, else the one saved in `--result`
 * (re-validated against that mission's allowlist); shell hooks must be re-supplied (and match the
 * mission's by hash). A Recording that carries a fixture identity is never replayed without one.
 */
export function regressionFixtures(
  flags: FixtureFlags,
  recording: { readonly site: string; readonly fixture?: { readonly identity: string } },
  missionResult: unknown,
  /** `--storage-state` (#129): wins over the one recorded with the mission. */
  storageState?: string,
): MissionFixtures | undefined {
  const result = isObject(missionResult) && isObject(missionResult.result) ? missionResult.result : undefined;
  const target = isObject(result?.target) ? result.target : undefined;
  const saved = isObject(result?.fixtures) ? result.fixtures : undefined;
  const allowlist = Array.isArray(target?.allowlist) ? target.allowlist.filter((a): a is string => typeof a === "string") : [recording.site];
  const baseUrl = typeof target?.seedUrl === "string" ? target.seedUrl : recording.site;
  const savedHooks = isObject(saved?.hooks) ? saved.hooks : {};
  if (
    (savedHooks.before !== undefined || savedHooks.after !== undefined) &&
    ((flags.before === undefined ? undefined : hookHash(flags.before)) !== savedHooks.before ||
      (flags.after === undefined ? undefined : hookHash(flags.after)) !== savedHooks.after)
  ) {
    throw new FixtureSpecError("the mission ran with --before/--after shell hooks: re-supply the SAME commands with --allow-shell-hooks");
  }
  const spec =
    flags.fixtures === undefined && saved?.spec !== undefined
      ? parseFixtureSpec(saved.spec, { allowlist, baseUrl }, { openRefs: flags.before !== undefined })
      : undefined;
  const fx = buildMissionFixtures(flags, {
    allowlist,
    baseUrl,
    ...(storageState !== undefined
      ? { storageState }
      : typeof target?.storageStatePath === "string"
        ? { storageState: target.storageStatePath }
        : {}),
    ...(spec === undefined ? {} : { spec }),
  });
  if (fx === undefined && recording.fixture !== undefined) {
    throw new FixtureSpecError(
      `this Recording started from fixture ${recording.fixture.identity}: pass --fixtures (or --result with its saved fixture) so every replay restores the same state`,
    );
  }
  return fx;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
