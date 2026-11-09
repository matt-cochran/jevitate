import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { execGitReadOnly, type GitExec } from "./change-context.js";

/**
 * 0.30.0 #799 (docs/design/0.30.0-evidence-and-trust.md §5.5): `jevitate check --require-trust`. A target's
 * `trust` in `.jevitate/environments.json` decides the run mode, and the file is PR-reviewed. This gate fails
 * when any environment's `trust` in the working tree differs from the value in the last commit (HEAD), so a
 * change of trust cannot ride into a check run unreviewed: it must be committed first. It reads git only through
 * the read-only runner (`execGitReadOnly`); it never writes the repository or its configuration.
 */

export class TrustCheckError extends Error {
  readonly code: "E_TRUST_CHECK" = "E_TRUST_CHECK";
  constructor(message: string) {
    super(message);
    this.name = "TrustCheckError";
  }
}

/** One environment whose `trust` differs from the committed value. `undefined` = no `trust` key (or no environment). */
export interface TrustDrift {
  readonly environment: string;
  readonly committed: string | undefined;
  readonly working: string | undefined;
}

function trustsOf(text: string, where: string): Map<string, string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TrustCheckError(`${where} is not valid JSON`);
  }
  const out = new Map<string, string | undefined>();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    const trust = typeof def === "object" && def !== null ? (def as { trust?: unknown }).trust : undefined;
    out.set(name, trust === undefined ? undefined : typeof trust === "string" ? trust : JSON.stringify(trust));
  }
  return out;
}

/**
 * Every environment whose `trust` in `file` differs from the one in HEAD, by name. A file not yet committed has
 * a committed trust of nothing, so any `trust` it declares is a drift. Throws `TrustCheckError` outside a git
 * work tree or in a repository with no commit: nothing there says what was reviewed.
 */
export async function trustDrift(file: string | null, exec: GitExec = execGitReadOnly, env: NodeJS.ProcessEnv = process.env): Promise<TrustDrift[]> {
  if (file === null || !existsSync(file)) {
    // No working file: only a committed trust that was removed counts, which needs the file's location; none to read.
    return [];
  }
  const cwd = dirname(file);
  const run = async (args: string[]): Promise<string | undefined> => {
    try {
      return (await exec(args, { cwd, env })).stdout;
    } catch {
      return undefined;
    }
  };
  if ((await run(["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") throw new TrustCheckError(`--require-trust needs ${file} inside a git work tree: nothing says which trust was reviewed`);
  if ((await run(["rev-parse", "--verify", "--quiet", "HEAD"])) === undefined) throw new TrustCheckError("--require-trust needs a commit: the repository has none, so no trust was reviewed");
  const committedText = await run(["show", `HEAD:./${basename(file)}`]);
  const committed = committedText === undefined ? new Map<string, string | undefined>() : trustsOf(committedText, `${basename(file)} at HEAD`);
  const working = trustsOf(readFileSync(file, "utf8"), file);
  const drift: TrustDrift[] = [];
  for (const name of new Set([...committed.keys(), ...working.keys()])) {
    if (committed.get(name) !== working.get(name)) drift.push({ environment: name, committed: committed.get(name), working: working.get(name) });
  }
  return drift;
}

/** The refusal text naming each drifted environment and what a person does. */
export function trustDriftMessage(drift: readonly TrustDrift[]): string {
  const show = (v: string | undefined): string => (v === undefined ? "none" : JSON.stringify(v));
  const lines = drift.map((d) => `  ${d.environment}: committed trust ${show(d.committed)}, working tree ${show(d.working)}`);
  return `--require-trust: ${drift.length} environment(s) have a trust that differs from the last commit; a change of trust is reviewed in a PR and committed before a check relies on it:\n${lines.join("\n")}`;
}
