/**
 * `--secret` values (#195 part 4): a literal, or `env:VAR` — read from the environment so the value
 * never sits in the process list or shell history (the same `env:` binding `--secret-field` uses).
 * Resolved HERE, at the CLI dispatch, before any browser opens; the resolved value is registered as a
 * run secret exactly like a literal one (redacted from every model call, transcript and artifact).
 *
 * Fail closed: an unset/empty variable or a malformed ref is a refusal — never an empty secret, and
 * never the literal text `env:VAR` standing in for the value. An error names the variable, never a
 * value (a malformed ref is not echoed: it may be a value pasted in place of the variable name).
 */

export class SecretArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretArgError";
  }
}

const ENV_REF = "env:";
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The warning a literal `--secret` earns (it still works): the value is visible to other processes. */
export const LITERAL_SECRET_WARNING =
  "warning: a literal --secret is visible in the process list and shell history; pass --secret env:VAR to read it from the environment\n";

/**
 * Resolves each `--secret` value: `env:VAR` → `env[VAR]`, anything else → itself. `literals` counts
 * the values given literally (for the caller's warning). Throws `SecretArgError`.
 */
export function resolveSecretArgs(
  values: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  flag: string,
): { secrets: string[]; literals: number } {
  const secrets: string[] = [];
  let literals = 0;
  for (const v of values) {
    if (!v.startsWith(ENV_REF)) {
      secrets.push(v);
      literals += 1;
      continue;
    }
    const name = v.slice(ENV_REF.length);
    if (!VAR_NAME_RE.test(name)) {
      throw new SecretArgError(`${flag} env:<VAR> expects an environment variable name (letters, digits, _; not starting with a digit)`);
    }
    const value = env[name];
    if (value === undefined || value === "") throw new SecretArgError(`${flag} env:${name}: environment variable ${name} is not set`);
    secrets.push(value);
  }
  return { secrets, literals };
}
