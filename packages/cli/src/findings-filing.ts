import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_JEVITATE_REPO,
  fileDraft,
  type FilingConfig,
  type FilingOutcome,
  type IssueDraft,
  type IssueFilerPort,
} from "@jevitate/domain";
import { resolveDataDir } from "./data-dir.js";

/**
 * Where a run's findings go (owner ruling 3). Drafts are ALWAYS written next to the Recording
 * (`<stem>.issues/<fingerprint>.md`); they are filed only when filing is enabled AND a destination
 * repo is configured. jevitate stays solution-agnostic: the system-under-test repo is configured
 * PER TARGET (by origin) in `~/.jevitate/filing.json` or per run with `--issue-repo`, never
 * hardcoded.
 *
 * `~/.jevitate/filing.json`:
 * ```json
 * { "enabled": false,
 *   "jevitateRepo": "matt-cochran/jevitate",
 *   "targets": { "https://app.example.test": { "repo": "acme/app" } } }
 * ```
 */

export interface FilingFileConfig {
  readonly enabled?: boolean;
  readonly jevitateRepo?: string;
  readonly targets?: Readonly<Record<string, { readonly repo: string }>>;
}

export class FilingConfigError extends Error {
  readonly code = "E_FILING_CONFIG" as const;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/name`, or a config error — a malformed repo is never silently used. */
export function assertRepo(repo: string, where: string): string {
  if (!REPO.test(repo)) throw new FilingConfigError(`${where}: ${JSON.stringify(repo)} is not an owner/name repo`);
  return repo;
}

/** Reads `~/.jevitate/filing.json`; a missing file is "no filing config". Anything malformed fails closed. */
export function loadFilingFileConfig(path = resolveDataDir(["filing.json"])): FilingFileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return {};
    throw new FilingConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilingConfigError(`${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FilingConfigError(`${path} must be a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  const out: { enabled?: boolean; jevitateRepo?: string; targets?: Record<string, { repo: string }> } = {};
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") throw new FilingConfigError(`${path}: enabled must be a boolean`);
    out.enabled = o.enabled;
  }
  if (o.jevitateRepo !== undefined) {
    if (typeof o.jevitateRepo !== "string") throw new FilingConfigError(`${path}: jevitateRepo must be a string`);
    out.jevitateRepo = assertRepo(o.jevitateRepo, `${path} jevitateRepo`);
  }
  if (o.targets !== undefined) {
    if (o.targets === null || typeof o.targets !== "object" || Array.isArray(o.targets)) {
      throw new FilingConfigError(`${path}: targets must be an object keyed by origin`);
    }
    const targets: Record<string, { repo: string }> = {};
    for (const [origin, v] of Object.entries(o.targets as Record<string, unknown>)) {
      const repo = v !== null && typeof v === "object" && "repo" in v ? (v as { repo: unknown }).repo : undefined;
      if (typeof repo !== "string") throw new FilingConfigError(`${path}: targets[${origin}].repo must be a string`);
      targets[origin] = { repo: assertRepo(repo, `${path} targets[${origin}]`) };
    }
    out.targets = targets;
  }
  return out;
}

export interface FilingFlags {
  /** `--file-issues`: enable filing for this run. */
  readonly fileIssues?: boolean;
  /** `--issue-repo`: the system-under-test repo for this run's target. */
  readonly issueRepo?: string;
  /** `--jevitate-repo`: override where engine findings go. */
  readonly jevitateRepo?: string;
}

/** Flags win over the file; the target repo is looked up by the run's origin. */
export function resolveFilingConfig(file: FilingFileConfig, flags: FilingFlags, targetOrigin: string): FilingConfig {
  const targetRepo = flags.issueRepo ?? file.targets?.[targetOrigin]?.repo;
  return {
    enabled: flags.fileIssues ?? file.enabled ?? false,
    jevitateRepo: assertRepo(flags.jevitateRepo ?? file.jevitateRepo ?? DEFAULT_JEVITATE_REPO, "jevitate repo"),
    ...(targetRepo === undefined ? {} : { targetRepo: assertRepo(targetRepo, "issue repo") }),
  };
}

/** `<dir>/<stem>.json` → `<dir>/<stem>.issues/`. */
export function issuesDirFor(recordingPath: string): string {
  return recordingPath.endsWith(".json") ? `${recordingPath.slice(0, -".json".length)}.issues` : `${recordingPath}.issues`;
}

export interface WrittenDraft {
  readonly fingerprint: string;
  readonly title: string;
  readonly attribution: IssueDraft["attribution"];
  readonly targets: IssueDraft["targets"];
  readonly path: string;
}

/** Writes each draft as `<fingerprint>.md` (title heading + body) next to the Recording. */
export function writeIssueDrafts(recordingPath: string, drafts: readonly IssueDraft[]): WrittenDraft[] {
  if (drafts.length === 0) return [];
  const dir = issuesDirFor(recordingPath);
  mkdirSync(dir, { recursive: true });
  return drafts.map((d) => {
    const path = join(dir, `${d.fingerprint}.md`);
    writeFileSync(path, `# ${d.title}\n\n${d.body}\n`, "utf8");
    return { fingerprint: d.fingerprint, title: d.title, attribution: d.attribution, targets: d.targets, path };
  });
}

export interface FindingsIssues {
  readonly drafts: WrittenDraft[];
  readonly filing: Array<{ readonly fingerprint: string; readonly outcomes: FilingOutcome[] }>;
}

/**
 * Writes every draft, then files them per the config. The filer is created ONLY when filing is
 * enabled (so a disabled run never even looks for `gh` or a token).
 */
export async function processIssueDrafts(
  recordingPath: string,
  drafts: readonly IssueDraft[],
  config: FilingConfig,
  makeFiler: () => IssueFilerPort,
  nowIso: string,
): Promise<FindingsIssues> {
  const written = writeIssueDrafts(recordingPath, drafts);
  const filing: FindingsIssues["filing"] = [];
  const filer = config.enabled && drafts.length > 0 ? makeFiler() : null;
  for (const d of drafts) {
    const outcomes =
      filer === null
        ? d.targets.map((target): FilingOutcome => ({
            target,
            status: "draft-only",
            reason: config.enabled ? "no filer" : "filing is disabled",
          }))
        : await fileDraft(filer, d, config, nowIso);
    filing.push({ fingerprint: d.fingerprint, outcomes });
  }
  return { drafts: written, filing };
}
