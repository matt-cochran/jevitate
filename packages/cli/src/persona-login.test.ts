import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertEnvVarName,
  authExpiredResult,
  checkSaveTarget,
  ensurePersonaSession,
  LoginArgsError,
  loginFromFlags,
  parseAuthCheck,
  parseLoginSuccess,
  parsePersonaLogin,
  resolveLoginSecrets,
  writeStorageStateFile,
} from "./persona-login.js";
import { loadPersonasFile, MultiRunArgsError, parsePersonaSpec, projectPersonaFor } from "./multi-run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-persona-login-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LOGIN = { url: "http://127.0.0.1:3000/login", userEnv: "APP_USER", passwordEnv: "APP_PASSWORD" };

describe("#427 parsing", () => {
  it("--auth-check: off | auto | urlExcludes:<text> | selector:<css>; anything else refused", () => {
    expect(parseAuthCheck(undefined)).toEqual({ mode: "auto" });
    expect(parseAuthCheck("off")).toEqual({ mode: "off" });
    expect(parseAuthCheck("urlExcludes:/sso")).toEqual({ mode: "urlExcludes", text: "/sso" });
    expect(parseAuthCheck("selector:#avatar")).toEqual({ mode: "selector", selector: "#avatar" });
    for (const bad of ["on", "urlExcludes:", "selector:", "text:x"]) expect(() => parseAuthCheck(bad), bad).toThrow(LoginArgsError);
  });

  it("--success: urlIncludes / selector / text", () => {
    expect(parseLoginSuccess("urlIncludes:/home")).toEqual({ kind: "urlIncludes", text: "/home" });
    expect(parseLoginSuccess("selector:nav .avatar")).toEqual({ kind: "selector", selector: "nav .avatar" });
    expect(parseLoginSuccess("text:Welcome back")).toEqual({ kind: "text", text: "Welcome back" });
    expect(() => parseLoginSuccess("visible:x")).toThrow(LoginArgsError);
  });

  it("credentials are environment variable NAMES only — a value pasted in their place is refused, never echoed", () => {
    expect(() => assertEnvVarName("hunter2!secret", "--password-env")).toThrow(/environment variable NAME/);
    try {
      assertEnvVarName("hunter2!secret", "--password-env");
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }
    for (const reserved of ["OPENROUTER_API_KEY", "GITHUB_TOKEN", "JEVITATE_ANYTHING"]) expect(() => assertEnvVarName(reserved, "--user-env")).toThrow(/never typed into a page/);
    expect(() => loginFromFlags({ ...LOGIN, url: "http://u:p@127.0.0.1/login" })).toThrow(/credentials in the URL/);
    expect(() => loginFromFlags({ ...LOGIN, url: "/login" })).toThrow(/absolute http/);
  });

  it("a personas file `login` object is validated (unknown keys, e.g. a literal password, refused)", () => {
    expect(parsePersonaLogin({ ...LOGIN, submit: "Sign in" }, "p.login")).toEqual({ ...LOGIN, submit: "Sign in" });
    expect(() => parsePersonaLogin({ ...LOGIN, password: "x" }, "p.login")).toThrow(/p\.login\.password: unknown key/);
    expect(() => parsePersonaLogin({ url: LOGIN.url, userEnv: "APP_USER" }, "p.login")).toThrow(/passwordEnv/);
  });

  it("an unset or empty variable refuses, naming the variable only", () => {
    expect(() => resolveLoginSecrets(LOGIN, { APP_USER: "alice" })).toThrow(/APP_PASSWORD is not set/);
    expect(() => resolveLoginSecrets(LOGIN, { APP_USER: "alice", APP_PASSWORD: "" })).toThrow(/APP_PASSWORD is not set/);
    expect(resolveLoginSecrets(LOGIN, { APP_USER: "alice", APP_PASSWORD: "pw" })).toEqual({ username: "alice", password: "pw" });
  });
});

describe("#427 personas files with login parameters", () => {
  it("both file forms take `login`; a persona with login may not have a session yet", () => {
    const state = join(dir, "admin.json");
    writeFileSync(state, "{}");
    writeFileSync(join(dir, "a.json"), JSON.stringify({ personas: [{ name: "admin", storageState: "admin.json", login: LOGIN }, { name: "new", storageState: "new.json", login: LOGIN }] }));
    expect(loadPersonasFile(join(dir, "a.json"))).toEqual([
      { name: "admin", storageState: state, login: LOGIN },
      { name: "new", storageState: join(dir, "new.json"), login: LOGIN },
    ]);
    writeFileSync(join(dir, "b.json"), JSON.stringify({ admin: { storageState: "admin.json", login: LOGIN }, plain: "admin.json" }));
    expect(loadPersonasFile(join(dir, "b.json"))).toEqual([
      { name: "admin", storageState: state, login: LOGIN },
      { name: "plain", storageState: state },
    ]);
    writeFileSync(join(dir, "c.json"), JSON.stringify({ nologin: "missing.json" }));
    expect(() => loadPersonasFile(join(dir, "c.json"))).toThrow(/storage state not found/);
    writeFileSync(join(dir, "d.json"), JSON.stringify({ admin: { storageState: "admin.json", login: { ...LOGIN, passwordEnv: "not a var" } } }));
    expect(() => loadPersonasFile(join(dir, "d.json"))).toThrow(MultiRunArgsError);
  });

  it("the project's .jevitate/personas.json: a bare --persona <name>, login for <name>=<state>, and lookup by storage state", () => {
    const project = join(dir, "repo");
    mkdirSync(join(project, ".jevitate"), { recursive: true });
    const state = join(project, "states", "admin.json");
    mkdirSync(join(project, "states"));
    writeFileSync(state, "{}");
    writeFileSync(join(project, ".jevitate", "personas.json"), JSON.stringify({ admin: { storageState: "../states/admin.json", login: LOGIN } }));
    expect(parsePersonaSpec("admin", project)).toEqual({ name: "admin", storageState: state, login: LOGIN });
    expect(parsePersonaSpec(`admin=${state}`, project)).toEqual({ name: "admin", storageState: state, login: LOGIN });
    expect(() => parsePersonaSpec("sales", project)).toThrow(/known personas: admin/);
    expect(projectPersonaFor("states/admin.json", project)?.name).toBe("admin");
    expect(projectPersonaFor("other.json", project)).toBeUndefined();
  });
});

describe("#427 saving a storage state", () => {
  it("writes atomically with mode 0600 (also over an existing, wider file)", () => {
    const f = join(dir, "deep", "state.json");
    writeStorageStateFile(f, '{"cookies":[]}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, "old", { mode: 0o644 });
    writeStorageStateFile(f, '{"cookies":[1]}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, "utf8")).toBe('{"cookies":[1]}');
  });

  it("refuses a repo's .jevitate/, and warns for a path in a repo that git does not ignore", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".jevitate"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    expect(() => checkSaveTarget(join(repo, ".jevitate", "s.json"), "--save")).toThrow(/never holds storage states/);
    expect(checkSaveTarget(join(repo, "auth", "s.json"), "--save").warnings[0]).toMatch(/is not gitignored/);
    writeFileSync(join(repo, ".gitignore"), "auth/\n");
    expect(checkSaveTarget(join(repo, "auth", "s.json"), "--save").warnings).toEqual([]);
    expect(checkSaveTarget(join(dir, "outside.json"), "--save").warnings).toEqual([]);
  });
});

describe("#427 the pre-flight", () => {
  it("off never opens a browser; the auth-expired result names the persona", async () => {
    const port = {
      open: async () => {
        throw new Error("no browser expected");
      },
    };
    const r = await ensurePersonaSession({ storageState: join(dir, "s.json"), url: "http://127.0.0.1:1/app", allowlist: ["http://127.0.0.1:1"], check: { mode: "off" }, port, env: {}, timeoutMs: 1000 });
    expect(r).toEqual({ ok: true, refreshed: false });
    const expired = authExpiredResult("goal", "http://127.0.0.1:1/app?token=abc", { ok: false, reason: "the session in s.json is not signed in" }, "admin");
    expect(expired).toMatchObject({ missionOutcome: "inconclusive", exitCode: 2, persona: "admin", failure: { kind: "auth-expired", persona: "admin" } });
    expect(expired.startUrl).not.toContain("abc");
  });

  it("a missing session without login parameters is expired, without opening a browser", async () => {
    const port = {
      open: async () => {
        throw new Error("no browser expected");
      },
    };
    const r = await ensurePersonaSession({ persona: "admin", storageState: join(dir, "missing.json"), url: "http://127.0.0.1:1/app", allowlist: ["http://127.0.0.1:1"], check: { mode: "auto" }, port, env: {}, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist yet/) });
  });
});
