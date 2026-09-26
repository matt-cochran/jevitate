import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { projectDataDir } from "./project-dir.js";
import {
  VERIFY_FIX_EXIT_CODES,
  VerifyFixInputError,
  findFinding,
  parsePersistedMission,
  runVerifyFix,
  type RunVerifyFixOptions,
  type VerifyFixReport,
} from "./verify-fix-api.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";

/**
 * The finding ledger (#195 part 6): a built-in store of the repro material `verify-fix` needs,
 * keyed by fingerprint, so "is it still fixed?" can be asked months later from the fingerprint
 * alone — after the run's `.jevitate/logs/<date>/` output has been pruned by retention.
 *
 * It extends the committed regressions store rather than duplicating it: entries live in
 * `<regressions>/ledger/<fingerprint>.json` (default `.jevitate/regressions/ledger/`, committed with
 * the app's code, like `regression capture`'s artifacts). Each entry is a minimal, self-contained
 * mission result — `{ ledger, result }` — that `runVerifyFix` reads exactly like a `<stem>.result.json`.
 *
 * What an entry holds is ALLOW-LISTED, never a copy of the result: the finding itself (with its own
 * path Recording, when it has one), the run's Recording only when the finding has none, the scope
 * (`seedUrl` + `allowlist`), the declared-invariant spec and the fixture spec the replay re-checks,
 * and the write controls the run fired (for hang-replay safety). Never a storage state, a session
 * PATH, an actor's session, the transcript, page text, screenshots or usage: a replay of an
 * authenticated target takes `--storage-state` (or the operator's targets.json session) at verify
 * time. A value the caller names as secret (`--secret`) anywhere in the material refuses the add.
 */

export const LEDGER_ENTRY_VERSION = 1 as const;

export class LedgerError extends Error {
  readonly code: "E_LEDGER_INPUT" | "E_LEDGER_NOT_FOUND" | "E_LEDGER_SECRET";
  constructor(code: LedgerError["code"], message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export interface LedgerMeta {
  readonly version: typeof LEDGER_ENTRY_VERSION;
  readonly fingerprint: string;
  readonly kind: string;
  readonly title?: string;
  /** The tracker ticket the finding was filed as (`--ticket`). */
  readonly ticket?: string;
  readonly addedAt: string;
  /** Where the material came from: the result's file NAME (never a machine-local path), its strategy and build. */
  readonly source: { readonly result: string; readonly strategy?: string; readonly missionOutcome?: string; readonly engine?: EngineInfo };
  /** The build that added it. */
  readonly addedBy: EngineInfo;
}

export interface LedgerEntry {
  readonly ledger: LedgerMeta;
  readonly result: Record<string, unknown>;
}

/** `<regressions>/ledger` — `.jevitate/regressions/ledger` in a project, else `~/.jevitate/regressions/ledger`. */
export function ledgerDir(regressionsDir?: string): string {
  return join(regressionsDir ?? projectDataDir(["regressions"]), "ledger");
}

const FINGERPRINT = /^[0-9a-f]{16}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function entryPath(dir: string, fingerprint: string): string {
  if (!FINGERPRINT.test(fingerprint)) throw new LedgerError("E_LEDGER_INPUT", `not a finding fingerprint: ${JSON.stringify(fingerprint)} (16 hex characters)`);
  return join(dir, `${fingerprint}.json`);
}

/** The raw finding object (as persisted) whose fingerprint or `related` list is `fp`. */
function rawFinding(result: Record<string, unknown>, fp: string): Record<string, unknown> | undefined {
  for (const list of [result.defects, result.hangs, result.serverLogDefects]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const related = Array.isArray(item.related) ? item.related : [];
      if (item.fingerprint === fp || related.includes(fp)) return item;
    }
  }
  return undefined;
}

/** Refuses repro material that contains any value the caller declared secret. */
function assertNoSecrets(material: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(material);
  const leaked = secrets.filter((s) => s.length > 0 && text.includes(s));
  if (leaked.length > 0) {
    throw new LedgerError(
      "E_LEDGER_SECRET",
      `the finding's repro material contains ${leaked.length} value(s) passed as --secret — refusing to store it (the ledger is committed with the repo)`,
    );
  }
}

export interface LedgerAddOptions {
  readonly resultPath: string;
  readonly fingerprint: string;
  readonly ticket?: string;
  /** `<regressions>` dir (CLI `--dir`); default `.jevitate/regressions`. */
  readonly regressionsDir?: string;
  /** Values that must never be stored (CLI `--secret`): an add whose material contains one is refused. */
  readonly secrets?: readonly string[];
  /** Test seam. */
  readonly nowIso?: () => string;
}

export interface LedgerAddResult {
  readonly entryPath: string;
  readonly fingerprint: string;
  readonly kind: string;
  readonly title?: string;
  readonly ticket?: string;
  /** True when an entry for this fingerprint already existed (its `addedAt` is kept). */
  readonly updated: boolean;
}

/** `jevitate ledger add <result> <fp>`: stores the redacted repro material `verify-fix` needs. */
export function ledgerAdd(opts: LedgerAddOptions): LedgerAddResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.resultPath, "utf8"));
  } catch (e) {
    throw new LedgerError("E_LEDGER_INPUT", `cannot read mission result ${opts.resultPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let mission;
  try {
    mission = parsePersistedMission(raw);
  } catch (e) {
    throw new LedgerError("E_LEDGER_INPUT", `${opts.resultPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const finding = findFinding(mission, opts.fingerprint);
  const result = isRecord(raw) && isRecord(raw.result) ? raw.result : {};
  const item = finding === undefined ? undefined : rawFinding(result, finding.fingerprint);
  if (finding === undefined || item === undefined) {
    throw new LedgerError("E_LEDGER_INPUT", `no finding with fingerprint ${opts.fingerprint} in ${opts.resultPath}`);
  }
  // The replay needs a Recording: the finding's own path, else the run's.
  const ownRecording = isRecord(item.repro) && item.repro.recording !== undefined;
  if (!ownRecording && mission.recording === null) {
    throw new LedgerError("E_LEDGER_INPUT", `finding ${finding.fingerprint} has no Recording to replay — nothing verify-fix could re-check`);
  }
  const list = finding.kind === "hang" ? "hangs" : "defects";
  const persistedFixtures = isRecord(result.fixtures) ? result.fixtures : undefined;
  const material: Record<string, unknown> = {
    ...(typeof result.schemaVersion === "number" ? { schemaVersion: result.schemaVersion } : {}),
    ...(typeof result.strategy === "string" ? { strategy: result.strategy } : {}),
    // The scope only: never a storage-state path or an actor's session (machine-local, and a pointer at credentials).
    target: { seedUrl: mission.target.seedUrl, allowlist: [...mission.target.allowlist] },
    recording: ownRecording ? null : mission.recording,
    defects: list === "defects" ? [item] : [],
    hangs: list === "hangs" ? [item] : [],
    ...(finding.kind === "invariant" && mission.invariantSpec !== undefined ? { invariantSpec: mission.invariantSpec } : {}),
    // The fixture's spec, hook HASHES and non-secret outputs — what a replay restores; hooks are never stored.
    ...(persistedFixtures === undefined
      ? {}
      : {
          fixtures: {
            identity: persistedFixtures.identity,
            ...(persistedFixtures.spec === undefined ? {} : { spec: persistedFixtures.spec }),
            hooks: isRecord(persistedFixtures.hooks) ? persistedFixtures.hooks : {},
            outputs: isRecord(persistedFixtures.outputs) ? persistedFixtures.outputs : {},
          },
        }),
    // Only which controls fired a write (hang-replay safety, #153/#181) — never the requests themselves.
    sideEffects: (Array.isArray(result.sideEffects) ? result.sideEffects : []).flatMap((e: unknown) =>
      isRecord(e) && typeof e.control === "string" ? [{ control: e.control }] : [],
    ),
  };
  assertNoSecrets(material, opts.secrets ?? []);

  const dir = ledgerDir(opts.regressionsDir);
  const path = entryPath(dir, finding.fingerprint);
  const previous = existsSync(path) ? readEntry(path) : undefined;
  const ticket = opts.ticket ?? previous?.ledger.ticket;
  const meta: LedgerMeta = {
    version: LEDGER_ENTRY_VERSION,
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    ...(finding.title === undefined ? {} : { title: finding.title }),
    ...(ticket === undefined ? {} : { ticket }),
    addedAt: previous?.ledger.addedAt ?? (opts.nowIso ?? (() => new Date().toISOString()))(),
    source: {
      result: basename(opts.resultPath),
      ...(typeof result.strategy === "string" ? { strategy: result.strategy } : {}),
      ...(isRecord(raw) && typeof raw.missionOutcome === "string" ? { missionOutcome: raw.missionOutcome } : {}),
      ...(isRecord(result.engine) ? { engine: result.engine as unknown as EngineInfo } : {}),
    },
    addedBy: currentEngineInfo(),
  };
  const entry: LedgerEntry = { ledger: meta, result: material };
  // The entry must itself be a mission result verify-fix can read (fail closed before writing).
  const check = findFinding(parsePersistedMission(entry), finding.fingerprint);
  if (check === undefined) throw new LedgerError("E_LEDGER_INPUT", `finding ${finding.fingerprint} did not survive into its ledger entry`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return {
    entryPath: path,
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    ...(finding.title === undefined ? {} : { title: finding.title }),
    ...(ticket === undefined ? {} : { ticket }),
    updated: previous !== undefined,
  };
}

function readEntry(path: string): LedgerEntry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LedgerError("E_LEDGER_INPUT", `cannot read ledger entry ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(raw) || !isRecord(raw.ledger) || !isRecord(raw.result) || typeof raw.ledger.fingerprint !== "string") {
    throw new LedgerError("E_LEDGER_INPUT", `not a ledger entry: ${path}`);
  }
  return raw as unknown as LedgerEntry;
}

/** Every entry in the ledger, oldest first. */
export function ledgerList(regressionsDir?: string): Array<LedgerMeta & { readonly entryPath: string }> {
  const dir = ledgerDir(regressionsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FINGERPRINT.test(f.replace(/\.json$/, "")) && f.endsWith(".json"))
    .map((f) => {
      const entryPath = join(dir, f);
      return { ...readEntry(entryPath).ledger, entryPath };
    })
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * The ledger entry for a fingerprint — its own, or the entry whose finding lists it as `related`
 * (the same defect seen at another point). What `verify-fix --fingerprint <fp>` replays when no
 * `--result` is given.
 */
export function ledgerEntryFor(fingerprint: string, regressionsDir?: string): string {
  const dir = ledgerDir(regressionsDir);
  const own = entryPath(dir, fingerprint);
  if (existsSync(own)) return own;
  for (const e of ledgerList(regressionsDir)) {
    if (findFinding(parsePersistedMission(readEntry(e.entryPath)), fingerprint) !== undefined) return e.entryPath;
  }
  throw new LedgerError(
    "E_LEDGER_NOT_FOUND",
    `no ledger entry for fingerprint ${fingerprint} in ${dir} — add one with \`jevitate ledger add <result> ${fingerprint}\`, or pass --result`,
  );
}

/** Which entries to re-check, plus every `verify-fix` option (passed to each replay as `verify-fix` takes it). */
export interface RunLedgerVerifyOptions extends Omit<RunVerifyFixOptions, "resultPath" | "fingerprint"> {
  /** Fingerprints to verify; default every entry (narrowed by `ticket`). */
  readonly fingerprints?: readonly string[];
  readonly ticket?: string;
  readonly regressionsDir?: string;
}

export interface LedgerVerifyItem {
  readonly fingerprint: string;
  readonly ticket?: string;
  readonly title?: string;
  readonly verdict: VerifyFixReport["verdict"];
  readonly exitCode: number;
  readonly reason?: string;
  readonly report?: VerifyFixReport;
}

export interface LedgerVerifyResult {
  readonly kind: "ledger-verify";
  readonly entries: LedgerVerifyItem[];
  readonly summary: Readonly<Record<VerifyFixReport["verdict"], number>>;
  /** 0 every entry fixed · 1 any still reproduces · 4 any intermittent · 2 any inconclusive (worst wins, in that order). */
  readonly exitCode: number;
}

/** A regression beats a flaky signal beats a check that could not run; only all-`fixed` passes. */
const VERDICT_SEVERITY: Readonly<Record<VerifyFixReport["verdict"], number>> = { fixed: 0, inconclusive: 1, intermittent: 2, "still-reproduces": 3 };

/** `jevitate ledger verify`: re-checks every (or the named) ledger entry with `verify-fix`, from the ledger alone. */
export async function runLedgerVerify(opts: RunLedgerVerifyOptions): Promise<LedgerVerifyResult> {
  const { fingerprints: _fps, ticket: _ticket, regressionsDir: _dir, ...verify } = opts;
  const all = ledgerList(opts.regressionsDir);
  const chosen =
    opts.fingerprints !== undefined && opts.fingerprints.length > 0
      ? opts.fingerprints.map((fp) => {
          const entryPath = ledgerEntryFor(fp, opts.regressionsDir);
          const meta = readEntry(entryPath).ledger;
          return { ...meta, entryPath, fingerprint: fp };
        })
      : all.filter((e) => opts.ticket === undefined || e.ticket === opts.ticket);
  const entries: LedgerVerifyItem[] = [];
  for (const e of chosen) {
    const base = { fingerprint: e.fingerprint, ...(e.ticket === undefined ? {} : { ticket: e.ticket }), ...(e.title === undefined ? {} : { title: e.title }) };
    try {
      const report = await runVerifyFix({ ...verify, resultPath: e.entryPath, fingerprint: e.fingerprint });
      entries.push({ ...base, verdict: report.verdict, exitCode: report.exitCode, ...(report.reason === undefined ? {} : { reason: report.reason }), report });
    } catch (err) {
      // An entry that cannot be replayed (a missing session, a refused origin) is inconclusive — never fixed.
      if (!(err instanceof VerifyFixInputError) && !(err instanceof LedgerError)) throw err;
      entries.push({ ...base, verdict: "inconclusive", exitCode: VERIFY_FIX_EXIT_CODES.inconclusive, reason: err.message });
    }
  }
  const summary = { fixed: 0, "still-reproduces": 0, intermittent: 0, inconclusive: 0 };
  for (const e of entries) summary[e.verdict] += 1;
  const worst = entries.reduce<VerifyFixReport["verdict"]>((w, e) => (VERDICT_SEVERITY[e.verdict] > VERDICT_SEVERITY[w] ? e.verdict : w), "fixed");
  return { kind: "ledger-verify", entries, summary, exitCode: VERIFY_FIX_EXIT_CODES[worst] };
}
