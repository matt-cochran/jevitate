import { FLAG_LABELS, LoginArgsError, type ApiLogin, type ApiLoginLabels, type AuthCheck, type LoginSecrets, type LoginSuccess, type PersonaLogin } from "./persona-login-types.js";

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** jevitate's own credentials are never typed into a page (a login config cannot name them). */
const RESERVED_VARS = new Set(["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "GITHUB_TOKEN"]);

/** Checks an environment variable NAME (a value pasted in its place is never echoed). */
export function assertEnvVarName(name: string, what: string): void {
  if (!VAR_NAME.test(name)) {
    throw new LoginArgsError(`${what} expects an environment variable NAME (letters, digits, _; not starting with a digit) — the credential itself is read from the environment, never passed as a value`);
  }
  if (RESERVED_VARS.has(name) || name.startsWith("JEVITATE_")) {
    throw new LoginArgsError(`${what} ${name}: jevitate's own credentials and settings are never typed into a page`);
  }
}

function httpUrl(v: string, what: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new LoginArgsError(`${what} must be an absolute http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new LoginArgsError(`${what} must be an absolute http(s) URL`);
  if (u.username !== "" || u.password !== "") throw new LoginArgsError(`${what} must not carry credentials in the URL`);
  return u.href;
}

const LOGIN_KEYS = ["url", "api", "userEnv", "passwordEnv", "userField", "passwordField", "submit", "success", "organizationField", "roleField"] as const;
/** The keys only a form sign-in uses (refused beside `api`). */
const FORM_ONLY_KEYS = ["url", "userField", "passwordField", "submit", "success", "organizationField", "roleField"] as const;
const API_KEYS = ["url", "userKey", "passwordKey", "tokenPath", "storageKey", "storage", "verifyUrl"] as const;

/** A JSON body key: a plain identifier (letters, digits, `_`, `-`). */
const BODY_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** One segment of a token path: an identifier or an array index. */
const PATH_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|0|[1-9][0-9]{0,5})$/;
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
/** A storage key: a safe identifier (letters, digits, `_`, `-`, `.`, `:`, `$`). */
const STORAGE_KEY = /^[A-Za-z_$][A-Za-z0-9_$.:-]{0,127}$/;

/** `a.b.0.c` → its segments (strict: identifiers or indexes, no prototype keys). */
export function parseTokenPath(path: string, what: string): string[] {
  const segments = path.split(".");
  if (segments.length > 8 || segments.some((s) => !PATH_SEGMENT.test(s) || UNSAFE_SEGMENTS.has(s))) {
    throw new LoginArgsError(`${what} must be a simple dotted path of identifiers or array indexes (e.g. token, data.accessToken; at most 8 segments), got ${JSON.stringify(path)}`);
  }
  return segments;
}

/** Validates an API login's settings (fail closed before any network). */
export function parseApiLogin(
  raw: {
    readonly url: string;
    readonly userKey?: string | undefined;
    readonly passwordKey?: string | undefined;
    readonly tokenPath?: string | undefined;
    readonly storageKey?: string | undefined;
    readonly storage?: string | undefined;
    readonly verifyUrl?: string | undefined;
  },
  labels: ApiLoginLabels = FLAG_LABELS,
): ApiLogin {
  const url = httpUrl(raw.url, labels.url);
  for (const [k, label] of [["userKey", labels.userKey], ["passwordKey", labels.passwordKey]] as const) {
    const v = raw[k];
    if (v !== undefined && !BODY_KEY.test(v)) throw new LoginArgsError(`${label} must be a JSON key of letters, digits, _ or - (starting with a letter or _), got ${JSON.stringify(v)}`);
  }
  const userKey = raw.userKey ?? "username";
  const passwordKey = raw.passwordKey ?? "password";
  if (userKey === passwordKey) throw new LoginArgsError(`${labels.userKey} and ${labels.passwordKey} must differ (both are ${JSON.stringify(userKey)})`);
  if (raw.storage !== undefined && raw.storage !== "local") {
    if (raw.storage === "session") {
      throw new LoginArgsError(
        `${labels.storage} session is not supported: a Playwright storage state holds cookies and localStorage only, so a sessionStorage token could not be saved or restored — use ${labels.storage} local, or a cookie session`,
      );
    }
    throw new LoginArgsError(`${labels.storage} must be local, got ${JSON.stringify(raw.storage)}`);
  }
  let segments: string[] | undefined;
  if (raw.tokenPath !== undefined) segments = parseTokenPath(raw.tokenPath, labels.tokenPath);
  else if (raw.storageKey !== undefined || raw.storage !== undefined) throw new LoginArgsError(`${labels.storageKey}/${labels.storage} place the token ${labels.tokenPath} reads: pass ${labels.tokenPath} too`);
  if (raw.storageKey !== undefined && !STORAGE_KEY.test(raw.storageKey)) {
    throw new LoginArgsError(`${labels.storageKey} must be a safe identifier (letters, digits, _ $ . : -; starting with a letter, _ or $), got ${JSON.stringify(raw.storageKey)}`);
  }
  const storageKey = raw.storageKey ?? segments?.at(-1);
  if (storageKey !== undefined && !STORAGE_KEY.test(storageKey)) {
    throw new LoginArgsError(`${labels.tokenPath} ends in ${JSON.stringify(storageKey)}, which is not a storage key: name one with ${labels.storageKey}`);
  }
  return {
    url,
    userKey,
    passwordKey,
    ...optional("tokenPath", raw.tokenPath),
    ...optional("storageKey", storageKey),
    storage: "local",
    ...optional("verifyUrl", raw.verifyUrl === undefined ? undefined : httpUrl(raw.verifyUrl, labels.verifyUrl)),
  };
}

/** Validates a personas file entry's `login` object (`where` names it in errors). */
export function parsePersonaLogin(v: unknown, where: string): PersonaLogin {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new LoginArgsError(`${where} must be an object {url | api, userEnv, passwordEnv, …}`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(LOGIN_KEYS as readonly string[]).includes(k)) {
      throw new LoginArgsError(`${where}.${k}: unknown key (allowed: ${LOGIN_KEYS.join(", ")}; credentials are read from the environment variables userEnv/passwordEnv name)`);
    }
  }
  const str = (from: Record<string, unknown>, k: string, label: string, required: boolean): string | undefined => {
    const x = from[k];
    if (x === undefined && !required) return undefined;
    if (typeof x !== "string" || x.trim() === "") throw new LoginArgsError(`${label} must be a non-empty string`);
    return x;
  };
  const userEnv = str(o, "userEnv", `${where}.userEnv`, true)!;
  const passwordEnv = str(o, "passwordEnv", `${where}.passwordEnv`, true)!;
  let login: PersonaLogin;
  if (o.api !== undefined) {
    const formKeys = FORM_ONLY_KEYS.filter((k) => o[k] !== undefined);
    if (formKeys.length > 0) throw new LoginArgsError(`${where}: api signs in through an HTTP endpoint — the form keys ${formKeys.join(", ")} do not apply beside it`);
    const a = typeof o.api === "string" ? { url: o.api } : o.api;
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw new LoginArgsError(`${where}.api must be the endpoint URL or an object {url, userKey?, passwordKey?, tokenPath?, storageKey?, storage?, verifyUrl?}`);
    const ao = a as Record<string, unknown>;
    for (const k of Object.keys(ao)) {
      if (!(API_KEYS as readonly string[]).includes(k)) throw new LoginArgsError(`${where}.api.${k}: unknown key (allowed: ${API_KEYS.join(", ")})`);
    }
    const label = (k: string): string => `${where}.api${typeof o.api === "string" && k === "url" ? "" : `.${k}`}`;
    const api = parseApiLogin(
      {
        url: str(ao, "url", label("url"), true)!,
        userKey: str(ao, "userKey", label("userKey"), false),
        passwordKey: str(ao, "passwordKey", label("passwordKey"), false),
        tokenPath: str(ao, "tokenPath", label("tokenPath"), false),
        storageKey: str(ao, "storageKey", label("storageKey"), false),
        storage: str(ao, "storage", label("storage"), false),
        verifyUrl: str(ao, "verifyUrl", label("verifyUrl"), false),
      },
      { url: label("url"), userKey: label("userKey"), passwordKey: label("passwordKey"), tokenPath: label("tokenPath"), storageKey: label("storageKey"), storage: label("storage"), verifyUrl: label("verifyUrl") },
    );
    login = { api, userEnv, passwordEnv };
  } else {
    login = {
      url: httpUrl(str(o, "url", `${where}.url`, true)!, `${where}.url`),
      userEnv,
      passwordEnv,
      ...optional("userField", str(o, "userField", `${where}.userField`, false)),
      ...optional("passwordField", str(o, "passwordField", `${where}.passwordField`, false)),
      ...optional("submit", str(o, "submit", `${where}.submit`, false)),
      ...optional("success", str(o, "success", `${where}.success`, false)),
      ...optional("organizationField", str(o, "organizationField", `${where}.organizationField`, false)),
      ...optional("roleField", str(o, "roleField", `${where}.roleField`, false)),
    };
  }
  assertEnvVarName(login.userEnv, `${where}.userEnv`);
  assertEnvVarName(login.passwordEnv, `${where}.passwordEnv`);
  if (login.success !== undefined) parseLoginSuccess(login.success);
  return login;
}

function optional<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

/** `jevitate login`'s flags → a validated `PersonaLogin` (fail closed before any browser opens). */
export function loginFromFlags(f: {
  readonly url?: string;
  readonly api?: Parameters<typeof parseApiLogin>[0];
  readonly userEnv: string;
  readonly passwordEnv: string;
  readonly userField?: string;
  readonly passwordField?: string;
  readonly submit?: string;
  readonly success?: string;
  readonly organizationField?: string;
  readonly roleField?: string;
}): PersonaLogin {
  if (f.api !== undefined) {
    if (f.url !== undefined) throw new LoginArgsError("--api and --url are two ways to sign in: pass one");
    const formFlags = (
      [
        ["--user-field", f.userField],
        ["--password-field", f.passwordField],
        ["--submit", f.submit],
        ["--success", f.success],
        ["--organization-field", f.organizationField],
        ["--role-field", f.roleField],
      ] as const
    )
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (formFlags.length > 0) throw new LoginArgsError(`--api signs in through an HTTP endpoint, not a form: ${formFlags.join(", ")} ${formFlags.length === 1 ? "does" : "do"} not apply`);
    const login: PersonaLogin = { api: parseApiLogin(f.api), userEnv: f.userEnv, passwordEnv: f.passwordEnv };
    assertEnvVarName(login.userEnv, "--user-env");
    assertEnvVarName(login.passwordEnv, "--password-env");
    return login;
  }
  if (f.url === undefined) throw new LoginArgsError("missing --url (or --api)");
  const login: PersonaLogin = {
    url: httpUrl(f.url, "--url"),
    userEnv: f.userEnv,
    passwordEnv: f.passwordEnv,
    ...optional("userField", f.userField),
    ...optional("passwordField", f.passwordField),
    ...optional("submit", f.submit),
    ...optional("success", f.success),
    ...optional("organizationField", f.organizationField),
    ...optional("roleField", f.roleField),
  };
  assertEnvVarName(login.userEnv, "--user-env");
  assertEnvVarName(login.passwordEnv, "--password-env");
  if (login.success !== undefined) parseLoginSuccess(login.success);
  return login;
}

/** `urlIncludes:<text>` | `selector:<css>` | `text:<text>`. */
export function parseLoginSuccess(spec: string): LoginSuccess {
  const ci = spec.indexOf(":");
  const kind = ci === -1 ? "" : spec.slice(0, ci);
  const rest = ci === -1 ? "" : spec.slice(ci + 1);
  if ((kind === "urlIncludes" || kind === "selector" || kind === "text") && rest.trim() !== "") {
    return kind === "selector" ? { kind, selector: rest } : { kind, text: rest };
  }
  throw new LoginArgsError(`--success must be urlIncludes:<text>, selector:<css> or text:<text>, got ${JSON.stringify(spec)}`);
}

/** `--auth-check <off|auto|urlExcludes:<text>|selector:<css>>` (default `auto`). */
export function parseAuthCheck(spec: string | undefined): AuthCheck {
  if (spec === undefined || spec === "auto") return { mode: "auto" };
  if (spec === "off") return { mode: "off" };
  const ci = spec.indexOf(":");
  const kind = ci === -1 ? "" : spec.slice(0, ci);
  const rest = ci === -1 ? "" : spec.slice(ci + 1);
  if (kind === "urlExcludes" && rest !== "") return { mode: "urlExcludes", text: rest };
  if (kind === "selector" && rest !== "") return { mode: "selector", selector: rest };
  throw new LoginArgsError(`--auth-check must be off, auto, urlExcludes:<text> or selector:<css>, got ${JSON.stringify(spec)}`);
}

/** Reads the two credentials from the environment (fail closed: unset/empty refuses, naming the variable only). */
export function resolveLoginSecrets(login: PersonaLogin, env: Readonly<Record<string, string | undefined>>): LoginSecrets {
  const read = (name: string, what: string): string => {
    const v = env[name];
    if (v === undefined || v === "") throw new LoginArgsError(`${what}: environment variable ${name} is not set`);
    return v;
  };
  return { username: read(login.userEnv, "--user-env"), password: read(login.passwordEnv, "--password-env") };
}
