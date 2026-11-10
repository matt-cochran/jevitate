/** #479: the app's release label — 1-64 of [A-Za-z0-9._+-], starting with a letter or digit. */
export const APP_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** The `--app-version` refusal text (each command wraps it in its own args error). */
export function appVersionFlagProblem(flag: string): string | undefined {
  return APP_VERSION_RE.test(flag) ? undefined : `--app-version must be 1-64 characters of [A-Za-z0-9._+-], starting with a letter or digit (got ${JSON.stringify(flag)})`;
}

/** `JEVITATE_APP_VERSION` when it is a valid label; an invalid value is ignored (with `warn`, when given). */
export function envAppVersion(env: Readonly<Record<string, string | undefined>>, warn?: (line: string) => void): string | undefined {
  const fromEnv = env.JEVITATE_APP_VERSION;
  if (fromEnv === undefined) return undefined;
  if (!APP_VERSION_RE.test(fromEnv)) {
    warn?.(`warning: ignoring JEVITATE_APP_VERSION: ${JSON.stringify(fromEnv)} is not a valid app version (1-64 of [A-Za-z0-9._+-], starting alphanumeric)\n`);
    return undefined;
  }
  return fromEnv;
}
