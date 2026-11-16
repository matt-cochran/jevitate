import { realpathSync } from "node:fs";
import { basename, dirname as dirnameOf, join as joinPath, resolve as resolveFile, sep as pathSep } from "node:path";
import { findGitRoot, logsDirFor, type LayoutDeps } from "./project-dir.js";
import { redactThrown } from "./terminal-result.js";
import { replayFinding, type RunVerifyFixOptions, type VerifyFixReport } from "./verify-fix-replay.js";

export { VerifyFixInputError, parsePersistedMission } from "./verify-fix-persisted.js";
export type * from "./verify-fix-persisted.js";
export { VERIFY_FIX_EXIT_CODES, findFinding, replayAllowlist } from "./verify-fix-replay.js";
export type * from "./verify-fix-replay.js";

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

/** `path` with every link resolved, as far as it exists: an input that is not there yet still has a real parent. */
function realPathAsFarAsItExists(path: string): string {
  const missing: string[] = [];
  for (let at = path; ; at = dirnameOf(at)) {
    try {
      return joinPath(realpathSync(at), ...missing);
    } catch {
      if (dirnameOf(at) === at) return path;
      missing.unshift(basename(at));
    }
  }
}

/** Where `file` stands in a data directory or a git work tree, and whether a file beside it would land in something committed. */
function artifactPlace(file: string): { readonly committed: boolean; readonly project: string | undefined } {
  const dir = dirnameOf(file);
  const parts = dir.split(pathSep);
  const dataDir = parts.lastIndexOf(".jevitate");
  const inLogs = dataDir !== -1 && parts[dataDir + 1] === "logs";
  const repo = findGitRoot(dir);
  return {
    committed: parts.at(-1) === "ledger" || parts.includes("regressions") || (dataDir !== -1 && !inLogs) || (repo !== null && !inLogs),
    project: dataDir === -1 ? (repo ?? undefined) : parts.slice(0, dataDir).join(pathSep) || pathSep,
  };
}

/**
 * Where a verify-fix run's own output is based (`verify-fix-<stamp>.json`: its result, videos and
 * screenshots unless a flag says otherwise). Beside a mission result, which is itself run output. But
 * not beside anything committed: a ledger entry, anything else under `.jevitate/` but `logs/`, or anything
 * in a git work tree but its `.jevitate/logs/`, such as a fixture. That run's output goes to the TTL logs of
 * the project holding the input, else the working directory's.
 * Decided on the real path as well as the given one, so a link into a ledger is still a ledger.
 * The one path the CLI's terminal layer and this report's writer share.
 */
export function verifyFixArtifactPath(resultPath: string, stamp: string, deps: LayoutDeps = {}): string {
  const input = resolveFile(resultPath);
  const real = artifactPlace(realPathAsFarAsItExists(input));
  const given = artifactPlace(input);
  const name = `verify-fix-${stamp}.json`;
  if (!real.committed && !given.committed) return joinPath(dirnameOf(input), name);
  const project = real.committed ? real.project : given.project;
  return joinPath(logsDirFor(stamp, project === undefined ? deps : { ...deps, cwd: () => project }), name);
}

/**
 * Runs the replay and returns its report. The returned report and the artifact are one redacted
 * object: every surface (`--json`, the human summary, the artifact, the MCP result) prints that, and
 * a thrown error's text gets the same rule. Its verdict, exit code and paths stay as they are.
 */
export async function runVerifyFix(opts: RunVerifyFixOptions): Promise<VerifyFixReport> {
  const known = new Set((opts.secrets ?? []).filter((s) => s !== ""));
  const learn = (values: readonly string[]): void => {
    const fresh = values.filter((v) => v !== "" && !known.has(v));
    for (const v of fresh) known.add(v);
    if (fresh.length > 0) opts.onSecrets?.(fresh);
  };
  const artifactPathFor = (stamp: string): string => verifyFixArtifactPath(opts.resultPath, stamp);
  try {
    return await replayFinding(opts, known, learn, artifactPathFor);
  } catch (err) {
    throw redactThrown(err, [...known]);
  }
}
