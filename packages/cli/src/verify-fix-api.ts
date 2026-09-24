import { readFile } from "node:fs/promises";
import { resolveTargetConfig, type TargetConfig } from "./target-config.js";
import { existsSync } from "node:fs";
import { InvariantSpecSchema, RecordingSchema, validateInvariantSpec, type InvariantSpec, type Recording } from "@jevitate/recording";
import { loadInvariantFiles } from "./invariants-file.js";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import {
  assertAuthorizedExploreTarget,
  verifyFix,
  type HangSignal,
  type VerifyFixResult,
  type VerifyFixVerdict,
} from "@jevitate/explore";

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
}

export interface VerifyFixReport extends VerifyFixResult {
  readonly exitCode: number;
  readonly title?: string;
}

export class VerifyFixInputError extends Error {
  readonly code = "E_VERIFY_FIX_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "VerifyFixInputError";
  }
}

interface PersistedFinding {
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

interface PersistedMission {
  readonly recording: Recording | null;
  readonly target: { readonly seedUrl: string; readonly allowlist: string[]; readonly storageStatePath?: string };
  readonly findings: PersistedFinding[];
  /** The declared-invariant spec the mission evaluated (#86), when it had one and it still validates. */
  readonly invariantSpec?: InvariantSpec;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asFinding(v: unknown): PersistedFinding | null {
  if (!isRecord(v) || typeof v.fingerprint !== "string" || typeof v.kind !== "string") return null;
  const repro = v.repro;
  if (!isRecord(repro) || typeof repro.recordingStepIndex !== "number") return null;
  const hang = v.kind === "hang" ? asHangSignal(v.signal) : null;
  if (v.kind === "hang" && hang === null) return null;
  const own = repro.recording === undefined ? undefined : RecordingSchema.safeParse(repro.recording);
  if (own !== undefined && !own.success) return null; // a finding whose repro cannot be trusted is skipped
  return {
    ...(own?.success === true ? { recording: own.data } : {}),
    fingerprint: v.fingerprint,
    kind: v.kind,
    repro: { recordingStepIndex: repro.recordingStepIndex },
    ...(hang === null ? {} : { hang }),
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
  for (const list of [result.defects, result.hangs]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const f = asFinding(item);
      if (f !== null) findings.push(f);
    }
  }
  // A persisted spec that no longer validates is dropped: its defects are then inconclusive, never fixed.
  const spec = result.invariantSpec === undefined ? undefined : InvariantSpecSchema.safeParse(result.invariantSpec);
  return {
    ...(spec?.success === true ? { invariantSpec: spec.data } : {}),
    recording,
    target: {
      seedUrl: target.seedUrl,
      allowlist: target.allowlist.filter((a): a is string => typeof a === "string"),
      ...(typeof target.storageStatePath === "string" ? { storageStatePath: target.storageStatePath } : {}),
    },
    findings,
  };
}

export async function runVerifyFix(opts: RunVerifyFixOptions): Promise<VerifyFixReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(opts.resultPath, "utf8"));
  } catch (e) {
    throw new VerifyFixInputError(`cannot read mission result ${opts.resultPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const mission = parsePersistedMission(raw);
  const finding = mission.findings.find(
    (f) => f.fingerprint === opts.fingerprint || (f.related ?? []).includes(opts.fingerprint),
  );
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
  // A declared-invariant defect (#86) is re-checked with the same spec (or `--invariants`), its probes
  // authorized against the MISSION's own origins before any browser opens.
  let invariantSpec: InvariantSpec | undefined;
  try {
    const bounds = { allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl };
    invariantSpec =
      opts.invariantFiles !== undefined && opts.invariantFiles.length > 0
        ? loadInvariantFiles(opts.invariantFiles, bounds)
        : mission.invariantSpec === undefined
          ? undefined
          : validateInvariantSpec(mission.invariantSpec, bounds);
  } catch (e) {
    throw new VerifyFixInputError(e instanceof Error ? e.message : String(e));
  }
  const declared =
    finding.kind === "invariant" && finding.invariantId !== undefined && invariantSpec !== undefined
      ? { spec: invariantSpec, id: finding.invariantId, allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl }
      : undefined;
  const result = await verifyFix({
    perceive: perceiveOpts,
    recording,
    recordingStepIndex: finding.repro.recordingStepIndex,
    fingerprint: finding.fingerprint,
    defectKind: finding.kind,
    ...(declared === undefined ? {} : { invariant: declared }),
    ...(finding.hang === undefined ? {} : { hang: finding.hang }),
    ...(finding.occurrences === undefined ? {} : { occurrences: finding.occurrences }),
    ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
    ...(opts.replays === undefined ? {} : { replays: opts.replays }),
    openSession: async () => {
      const session = await portFactory().open({
        headless: true,
        allowedOrigins: [...mission.target.allowlist],
        baseUrl: origin,
        ...opts.browser,
        ...(storageState !== undefined ? { storageState } : {}),
      });
      const actor = CastActor.named("verify-fix").whoCan(new BrowseTheWeb(session, [...mission.target.allowlist]));
      return { page: session.page, actor, close: () => session.close() };
    },
  });
  return {
    ...result,
    exitCode: VERIFY_FIX_EXIT_CODES[result.verdict],
    ...(finding.title === undefined ? {} : { title: finding.title }),
  };
}
