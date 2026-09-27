import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * One helper for turning a user-supplied NAME into a path under a root directory (#221): a profile
 * name, a regression id, … A name is a single safe path segment — never a path — so a crafted name
 * (`../x`, `a/../../x`, `/etc/x`, `..\x`, NUL) can never reach a file outside its root. The
 * resolved path is ALSO checked to stay inside the root (defence in depth, should the name rule
 * ever loosen).
 */

/** Letters, digits, `.`, `_`, `-`; starts with a letter or digit (so never `.`/`..`/a dotfile). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_SAFE_NAME_LENGTH = 128;

export class UnsafeNameError extends Error {
  /** A usage error (exit 64): `E_INVALID_*`. */
  readonly code = "E_INVALID_NAME" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnsafeNameError";
  }
}

/** Throws `UnsafeNameError` unless `name` is one safe path segment (`what` names it in the message). */
export function assertSafeName(name: string, what = "name"): void {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_SAFE_NAME_LENGTH || !SAFE_NAME.test(name) || name.includes("..")) {
    throw new UnsafeNameError(
      `invalid ${what} ${JSON.stringify(name)}: must be 1–${MAX_SAFE_NAME_LENGTH} characters of letters, digits, '.', '_' or '-', starting with a letter or digit, with no '..' (a name, never a path)`,
    );
  }
}

/** Throws `UnsafeNameError` unless `path` resolves strictly inside `root`. Returns the resolved path. */
export function assertInsideRoot(root: string, path: string, what = "name"): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafeNameError(`invalid ${what}: ${JSON.stringify(path)} resolves outside ${resolvedRoot}`);
  }
  return resolved;
}

/**
 * `<root>/<prefix><name><suffix>` for a validated `name`, verified to resolve inside `root`
 * (e.g. `safeChildPath(dir, id, { suffix: ".recording.json" })`).
 */
export function safeChildPath(root: string, name: string, opts: { readonly what?: string; readonly suffix?: string } = {}): string {
  const what = opts.what ?? "name";
  assertSafeName(name, what);
  return assertInsideRoot(root, `${name}${opts.suffix ?? ""}`, what);
}
