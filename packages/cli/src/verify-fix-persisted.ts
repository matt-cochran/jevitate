import { InvariantSpecSchema, RecordingSchema, type InvariantSpec, type Recording } from "@jevitate/recording";
import { isRecord } from "@jevitate/domain";
import { type HangSignal } from "@jevitate/explore";

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
  readonly serverLog?: {
    readonly sources: readonly string[];
    readonly matcher: string;
    readonly normalizedMessage: string;
    readonly drainMs: number;
    /** #282: the run's `--log-scope`. */
    readonly scope?: readonly string[];
  };
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
  /** #243: the fixture identities the mission's steps authenticated as → storageState paths. */
  readonly identities?: Readonly<Record<string, string>>;
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
    ...(isRecord(v.identities)
      ? { identities: Object.fromEntries(Object.entries(v.identities).filter((e): e is [string, string] => typeof e[1] === "string")) }
      : {}),
  };
}


/** A persisted `server-log` defect's re-check spec (#142), validated just enough to replay it. */
function asServerLog(v: unknown): PersistedFinding["serverLog"] | null {
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.sources) || !v.sources.every((s): s is string => typeof s === "string")) return null;
  if (typeof v.matcher !== "string" || typeof v.normalizedMessage !== "string" || typeof v.drainMs !== "number") return null;
  // A scope that does not parse is refused (never dropped: that would widen what counts as a reproduction).
  if (v.scope !== undefined && !(Array.isArray(v.scope) && v.scope.every((s): s is string => typeof s === "string"))) return null;
  const scope = v.scope === undefined ? {} : { scope: v.scope as string[] };
  return { sources: v.sources, matcher: v.matcher, normalizedMessage: v.normalizedMessage, drainMs: v.drainMs, ...scope };
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
  // `defects` holds every defect (#195). `serverLogDefects` is no longer written (removed in 0.3.0)
  // but is still read: a 0.2.0 result carries it as an alias, a pre-#195 result as the only list
  // of its server-log defects — each fingerprint is taken once.
  for (const list of [result.defects, result.hangs, result.serverLogDefects]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const f = asFinding(item);
      if (f !== null && !findings.some((g) => g.fingerprint === f.fingerprint)) findings.push(f);
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
