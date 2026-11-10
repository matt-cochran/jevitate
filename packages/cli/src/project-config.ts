import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDoneCheckPolicy, type DoneCheckPolicy } from "@jevitate/domain";
import { isMutationProofPolicySetting, normalizeMutationProofPolicy, type MutationProofPolicyMode } from "./mutation-proof-policy.js";

/**
 * The project's own settings: `<repo>/.jevitate/project.json`, committed with the app (unlike the
 * per-user `~/.jevitate/config.json`, which holds machine-local and secret settings). Read-only here;
 * a team edits it by hand. Unknown keys are ignored (later settings), a malformed known key is an
 * error naming the file — never a silent default.
 *
 *   { "testIdAttributes": ["data-testid", "data-test", "data-cy"] }
 *
 * - `testIdAttributes` (#470): the attributes that count as the team's test-id convention, in
 *   preference order (the first is the one a locator-health fix suggests). Default `data-testid`,
 *   `data-test`. `data-tflow-id` (#468) is tracking metadata and is refused.
 * - `doneCheckPolicy` (#800, 0.30.0): how a `journey run` pass whose job is `unverified` (no done
 *   check, or one already true) exits: `require` (the default when absent) exits 2; `advisory` keeps 0.
 */

export const PROJECT_CONFIG_FILE = "project.json";

/** The default test-id convention when the project config names none. */
export const DEFAULT_TEST_ID_ATTRIBUTES: readonly string[] = ["data-testid", "data-test"];

/** #468: never a test-id attribute. */
const TFLOW_ID_ATTRIBUTE = "data-tflow-id";
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export class ProjectConfigError extends Error {
  readonly code = "E_PROJECT_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

export interface ProjectConfig {
  readonly testIdAttributes: readonly string[];
  /** Default `advisory` (owner decision "Proof role"). 0.29.0's alias for `require-sensitive` is read as it, with one warning per process. */
  readonly mutationProofPolicy?: MutationProofPolicyMode;
  /** #800: absent means the default, `require` (`DEFAULT_DONE_CHECK_POLICY`). */
  readonly doneCheckPolicy?: DoneCheckPolicy;
}

/** Validates a `testIdAttributes` value; throws `ProjectConfigError` naming `where`. */
export function parseTestIdAttributes(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectConfigError(`${where}: testIdAttributes must be a non-empty array of attribute names (e.g. ["data-testid", "data-cy"])`);
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !ATTRIBUTE_NAME.test(v)) {
      throw new ProjectConfigError(`${where}: testIdAttributes entry ${JSON.stringify(v)} is not an attribute name`);
    }
    const attr = v.toLowerCase();
    if (attr === TFLOW_ID_ATTRIBUTE) {
      throw new ProjectConfigError(
        `${where}: testIdAttributes may not include ${TFLOW_ID_ATTRIBUTE} — it is TFlow tracking metadata (#468), never the automation convention; add a test id (e.g. data-testid) instead`,
      );
    }
    if (!out.includes(attr)) out.push(attr);
  }
  return out;
}

/**
 * The project config of a project data dir (`<repo>/.jevitate`); defaults outside a project or when
 * the file is absent. Throws `ProjectConfigError` for unreadable JSON or a malformed known key.
 */
export function loadProjectConfig(projectDir: string | null): ProjectConfig {
  if (projectDir === null) return { testIdAttributes: DEFAULT_TEST_ID_ATTRIBUTES };
  const path = join(projectDir, PROJECT_CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { testIdAttributes: DEFAULT_TEST_ID_ATTRIBUTES };
    throw new ProjectConfigError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProjectConfigError(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProjectConfigError(`${path}: must be a JSON object`);
  const value = (parsed as Record<string, unknown>).testIdAttributes;
  const policy = (parsed as Record<string, unknown>).mutationProofPolicy;
  if (policy !== undefined && !isMutationProofPolicySetting(policy)) {
    throw new ProjectConfigError(`${path}: mutationProofPolicy must be advisory, require-attempt or require-sensitive`);
  }
  const doneCheckPolicy = (parsed as Record<string, unknown>).doneCheckPolicy;
  if (doneCheckPolicy !== undefined && !isDoneCheckPolicy(doneCheckPolicy)) {
    throw new ProjectConfigError(`${path}: doneCheckPolicy must be require or advisory`);
  }
  return {
    testIdAttributes: value === undefined ? DEFAULT_TEST_ID_ATTRIBUTES : parseTestIdAttributes(value, path),
    ...(policy === undefined ? {} : { mutationProofPolicy: normalizeMutationProofPolicy(policy) }),
    ...(doneCheckPolicy === undefined ? {} : { doneCheckPolicy }),
  };
}
