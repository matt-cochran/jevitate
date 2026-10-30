import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import type { CliDeps } from "./cli-shared.js";
import { parsePersonaLogin, selectLoginContext } from "./persona-login.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #741 end to end, REAL Chromium: `jevitate login` selects the persona's declared
 * `context: {organization, role}` in the app and asserts the selection BEFORE it captures the
 * storage state. An unavailable declared organization fails with `E_LOGIN_CONTEXT` and writes
 * no state file; a selected organization/role is persisted into the captured state.
 */

const USER = "alice@example.test";
const PASSWORD = "pw-correct";
const ENV = { APP_USER: USER, APP_PASSWORD: PASSWORD };

let server: Server;
let origin: string;

const LOGIN_PAGE = `<!doctype html><html><body>
<form method="post" action="/login">
  <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></body></html>`;

const chooserLoginPage = (next: string): string => `<!doctype html><html><body>
<form method="post" action="/login">
  <input type="hidden" name="next" value="${next}">
  <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></body></html>`;

const chooserPage = (cards: string): string => `<!doctype html><html><body><h1>Choose your workspace</h1>${cards}</body></html>`;

const APP_PAGE = `<!doctype html><html><body>
<h1>Dashboard</h1>
<label for="org">Organization</label>
<select id="org" onchange="document.cookie='org='+this.value+'; path=/'"><option>Acme</option><option>Globex</option></select>
<label for="role">Role</label>
<select id="role" onchange="document.cookie='role='+this.value+'; path=/'"><option>admin</option><option>viewer</option></select>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("email") === USER && params.get("password") === PASSWORD) res.writeHead(302, { "set-cookie": "sid=live; Path=/", location: params.get("next") ?? "/app" }).end();
        else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LOGIN_PAGE);
      });
      return;
    }
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LOGIN_PAGE);
      return;
    }
    if (url.pathname === "/login-chooser") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(chooserLoginPage(url.searchParams.get("next") ?? "/app"));
      return;
    }
    if (url.pathname === "/chooser-ambiguous") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(chooserPage(`<button>Workspace A</button><button>Workspace A</button>`));
      return;
    }
    if (url.pathname === "/chooser-missing") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(chooserPage(`<button>Workspace B</button>`));
      return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const creds = JSON.parse(body) as { username?: string; password?: string };
        if (creds.username === USER && creds.password === PASSWORD) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "tok-live" }));
        else res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid" }));
      });
      return;
    }
    if (url.pathname === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP_PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no TCP address");
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class DoneJudge implements JudgmentPort {
  async systemOne(): Promise<Record<string, Answer>> {
    return { action: { kind: "choice", value: "done", confidence: 0.9 } };
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-login-context-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A personas file with one persona whose declared context drives the login selection. */
async function writePersonas(name: string, context: { readonly organization?: string; readonly role?: string }): Promise<string> {
  const path = join(dir, `${name}.personas.json`);
  await writeFile(path, JSON.stringify({ personas: [{ name: "admin", storageState: `${name}.state.json`, context, login: { url: `${origin}/login`, userEnv: "APP_USER", passwordEnv: "APP_PASSWORD", organizationField: "#org", roleField: "#role", success: "text:Dashboard" } }] }));
  return path;
}

/** A personas file whose form login lands on a workspace chooser (cards, not a <select>). */
async function writeChooserPersonas(name: string, next: string, context: { readonly organization?: string }): Promise<string> {
  const path = join(dir, `${name}.personas.json`);
  await writeFile(path, JSON.stringify({ personas: [{ name: "admin", storageState: `${name}.state.json`, context, login: { url: `${origin}/login-chooser?next=${encodeURIComponent(next)}`, userEnv: "APP_USER", passwordEnv: "APP_PASSWORD", success: "text:Choose your workspace" } }] }));
  return path;
}

/** A personas file whose API login still declares a context to prove on the verify page. */
async function writeApiPersonas(name: string, context: { readonly organization?: string; readonly role?: string }): Promise<string> {
  const path = join(dir, `${name}.personas.json`);
  await writeFile(path, JSON.stringify({ personas: [{ name: "admin", storageState: `${name}.state.json`, context, login: { api: { url: `${origin}/api/login`, tokenPath: "token", verifyUrl: `${origin}/app` }, userEnv: "APP_USER", passwordEnv: "APP_PASSWORD" } }] }));
  return path;
}

async function run(argv: string[]): Promise<{ out: string; err: string; exitCode: number | undefined; envelope: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } }> {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: { judge: new DoneJudge(), gen: new FakeGenerationGateway({}), env: ENV, browserPortFactory: () => new PlaywrightBrowserPort() },
  } as unknown as CliDeps;
  const program = buildProgram(deps);
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  const before = process.exitCode;
  process.exitCode = undefined;
  await program.parseAsync(argv, { from: "user" });
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = before;
  const text = out.join("").trimEnd().split("\n").at(-1) ?? "{}";
  return { out: out.join(""), err: err.join(""), exitCode, envelope: JSON.parse(text) };
}

async function cookiesOf(save: string): Promise<Map<string, string>> {
  const state = JSON.parse(await readFile(save, "utf8")) as { cookies?: Array<{ name: string; value: string }> };
  return new Map((state.cookies ?? []).map((c) => [c.name, c.value]));
}

describe("#741 login context configuration", () => {
  it("a persona's login may name the organization and role selection controls", () => {
    expect(parsePersonaLogin({ url: "http://127.0.0.1:3000/login", userEnv: "APP_USER", passwordEnv: "APP_PASSWORD", organizationField: "#org", roleField: "#role" }, "p.login")).toMatchObject({ organizationField: "#org", roleField: "#role" });
  });

  it("a selection-control field beside an api login is refused", () => {
    expect(() => parsePersonaLogin({ api: "http://127.0.0.1:3000/api/login", userEnv: "APP_USER", passwordEnv: "APP_PASSWORD", organizationField: "#org" }, "p.login")).toThrow(/form keys/);
  });
});

describe("#741 login selects and asserts declared org/role", () => {
  it("an unavailable declared organization fails with E_LOGIN_CONTEXT", async () => {
    const personas = await writePersonas("unavailable-code", { organization: "Ghost" });
    const r = await run(["login", "--persona", "admin", "--personas", personas, "--save", join(dir, "unavailable-code.state.json"), "--json"]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "E_LOGIN_CONTEXT" } });
  }, 120_000);

  it("an unavailable declared organization writes no storage state", async () => {
    const save = join(dir, "unavailable-file.state.json");
    const personas = await writePersonas("unavailable-file", { organization: "Ghost" });
    await run(["login", "--persona", "admin", "--personas", personas, "--save", save, "--json"]);
    expect(existsSync(save)).toBe(false);
  }, 120_000);

  it("the selected declared organization is captured into the storage state", async () => {
    const save = join(dir, "org.state.json");
    const personas = await writePersonas("org", { organization: "Acme" });
    await run(["login", "--persona", "admin", "--personas", personas, "--save", save, "--json"]);
    expect((await cookiesOf(save)).get("org")).toBe("Acme");
  }, 120_000);

  it("the selected declared role is captured into the storage state", async () => {
    const save = join(dir, "role.state.json");
    const personas = await writePersonas("role", { organization: "Acme", role: "admin" });
    await run(["login", "--persona", "admin", "--personas", personas, "--save", save, "--json"]);
    expect((await cookiesOf(save)).get("role")).toBe("admin");
  }, 120_000);

  it("an API login selects the declared organization before capturing the state", async () => {
    const save = join(dir, "api-org.state.json");
    const personas = await writeApiPersonas("api-org", { organization: "Acme" });
    await run(["login", "--persona", "admin", "--personas", personas, "--save", save, "--json"]);
    expect((await cookiesOf(save)).get("org")).toBe("Acme");
  }, 120_000);

  it("an API login fails with E_LOGIN_CONTEXT when the declared organization is unavailable", async () => {
    const personas = await writeApiPersonas("api-unavailable", { organization: "Ghost" });
    const r = await run(["login", "--persona", "admin", "--personas", personas, "--save", join(dir, "api-unavailable.state.json"), "--json"]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "E_LOGIN_CONTEXT" } });
  }, 120_000);
});

describe("#741 workspace chooser cards", () => {
  it("the declared workspace card is clicked before the state is captured", async () => {
    const port = new PlaywrightBrowserPort();
    const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: `${origin}/` });
    try {
      await session.page.goto(`${origin}/app`);
      await session.page.setContent(`<button onclick="document.cookie='org=acme; path=/'; this.remove()">Workspace A</button><button>Workspace B</button>`);
      await selectLoginContext(session.page, { organization: "Workspace A" }, { login: {}, timeoutMs: 5_000 });
      const state = session.captureStorageState !== undefined ? await session.captureStorageState() : JSON.stringify(await session.page.context().storageState());
      expect((JSON.parse(state).cookies as Array<{ name: string; value: string }>).find((c) => c.name === "org")?.value).toBe("acme");
    } finally {
      await session.close();
    }
  }, 120_000);

  it("an ambiguous workspace card fails with E_LOGIN_CONTEXT", async () => {
    const personas = await writeChooserPersonas("chooser-ambiguous", "/chooser-ambiguous", { organization: "Workspace A" });
    const r = await run(["login", "--persona", "admin", "--personas", personas, "--save", join(dir, "chooser-ambiguous.state.json"), "--json"]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "E_LOGIN_CONTEXT" } });
  }, 120_000);

  it("a destructive card that only contains the declared role is never clicked", async () => {
    const port = new PlaywrightBrowserPort();
    const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: `${origin}/` });
    try {
      await session.page.goto(`${origin}/app`);
      await session.page.setContent(`<button onclick="this.remove()">Remove Admin</button>`);
      await expect(selectLoginContext(session.page, { role: "Admin" }, { login: {}, timeoutMs: 5_000 })).rejects.toMatchObject({ code: "E_LOGIN_CONTEXT" });
    } finally {
      await session.close();
    }
  }, 120_000);

  it("a missing workspace card writes no storage state", async () => {
    const save = join(dir, "chooser-missing.state.json");
    const personas = await writeChooserPersonas("chooser-missing", "/chooser-missing", { organization: "Workspace A" });
    await run(["login", "--persona", "admin", "--personas", personas, "--save", save, "--json"]);
    expect(existsSync(save)).toBe(false);
  }, 120_000);
});
