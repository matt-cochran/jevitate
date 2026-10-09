import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { MissionTarget, QueuedMission } from "@jevitate/missions";
import { buildProgram } from "./program.js";
import { realQueuedMissionExecutor } from "./mission-queue-runner.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #427 end to end, REAL Chromium against a served app with a cookie session:
 *  - `jevitate login` signs in with credentials from env variables and saves a working storage state (0600);
 *  - the pre-flight auth check ends a run on an expired session fast (`auth-expired`, the persona named);
 *  - a persona with login parameters is re-minted once and the run goes on;
 *  - neither credential ever reaches stdout, stderr or any file the runs wrote.
 */

const USER = `alice-${randomUUID().slice(0, 8)}@example.test`;
const PASSWORD = `pw-${randomUUID()}-Zq9`;
const sessions = new Set<string>();
const pendingEmails = new Map<string, string>();
let server: Server;
let origin: string;

const sidOf = (req: IncomingMessage): string | undefined =>
  (req.headers.cookie ?? "")
    .split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === "sid")?.[1];

const loginPage = (error: string): string =>
  `<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1>${error === "" ? "" : `<p role="alert">${error}</p>`}
  <form method="post" action="/login">
    <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username">
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form></body></html>`;

// The same form as `loginPage`, but inserted by an inline script ~1.5 s after load (a client-rendered form).
const lazyLoginPage = (): string =>
  `<!doctype html><html><head><title>Sign in</title></head><body><div id="root"></div>
  <script>
    setTimeout(function () {
      document.getElementById("root").innerHTML = ${JSON.stringify(
        `<h1>Sign in</h1>
  <form method="post" action="/login">
    <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username">
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>`,
      )};
    }, 1500);
  </script></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(loginPage(""));
      return;
    }
    if (url.pathname === "/login-lazy" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(lazyLoginPage());
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("email") === USER && form.get("password") === PASSWORD) {
          const sid = randomUUID();
          sessions.add(sid);
          res.writeHead(303, { location: "/dashboard", "set-cookie": `sid=${sid}; Path=/; HttpOnly` }).end();
        } else {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" }).end(loginPage("Wrong email or password"));
        }
      });
      return;
    }
    // A two-step sign-in: the email first (a pending cookie), then a password page.
    if (url.pathname === "/signin" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><html><body><form method="post" action="/signin"><label for="e">Email address</label><input id="e" name="email" type="email"><button type="submit">Next</button></form></body></html>`,
      );
      return;
    }
    if (url.pathname.startsWith("/signin") && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (url.pathname === "/signin") {
          const pending = randomUUID();
          pendingEmails.set(pending, form.get("email") ?? "");
          res.writeHead(303, { location: "/signin/password", "set-cookie": `pending=${pending}; Path=/` }).end();
          return;
        }
        const pending = (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === "pending")?.[1] ?? "";
        if (pendingEmails.get(pending) === USER && form.get("password") === PASSWORD) {
          const sid = randomUUID();
          sessions.add(sid);
          res.writeHead(303, { location: "/dashboard", "set-cookie": `sid=${sid}; Path=/; HttpOnly` }).end();
        } else {
          res.writeHead(401).end("no");
        }
      });
      return;
    }
    if (url.pathname === "/signin/password") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><html><body><form method="post" action="/signin/password"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form></body></html>`,
      );
      return;
    }
    if (url.pathname === "/dashboard") {
      const sid = sidOf(req);
      if (sid === undefined || !sessions.has(sid)) {
        res.writeHead(302, { location: "/login?next=/dashboard" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Dashboard</title></head><body><h1>Dashboard</h1><button type="button">New report</button></body></html>`);
      return;
    }
    if (url.pathname === "/credentials") {
      const sid = sidOf(req);
      if (sid === undefined || !sessions.has(sid)) {
        res.writeHead(302, { location: "/login?next=/credentials" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><html><head><title>API credentials</title></head><body><nav>Signed in as a@b.c</nav><h1>API credentials</h1><label>App secret <input type="password"></label><button type="button">Save</button></body></html>`,
      );
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
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

class DoneJudge implements JudgmentPort {
  async systemOne(): Promise<Record<string, Answer>> {
    return { action: { kind: "choice", value: "done", confidence: 0.9 } };
  }
}

const ENV = { JEV_T_USER: USER, JEV_T_PASSWORD: PASSWORD, JEV_T_WRONG: "not-the-password" };

async function run(argv: string[]): Promise<{ out: string; err: string; exitCode: number | undefined; envelope: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    explore: { judge: new DoneJudge(), gen: new FakeGenerationGateway({}), env: ENV, browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  const before = process.exitCode;
  process.exitCode = undefined;
  await program.parseAsync(argv, { from: "user" });
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = before;
  const text = out.join("");
  const last = text.trimEnd().split("\n").at(-1) ?? "{}";
  return { out: text, err: err.join(""), exitCode, envelope: JSON.parse(last) };
}

async function allFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await allFiles(p)));
    else files.push(p);
  }
  return files;
}

describe("#427 persona login + pre-flight auth check (served, real browser)", () => {
  let dir: string;
  const transcript: string[] = [];
  const record = (r: { out: string; err: string }): void => {
    transcript.push(r.out, r.err);
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-login-served-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("login mints a working storage state (mode 0600) from env credentials", async () => {
    const save = join(dir, "states", "alice.json");
    const r = await run(["login", "--persona", "alice", "--url", `${origin}/login`, "--user-env", "JEV_T_USER", "--password-env", "JEV_T_PASSWORD", "--save", save, "--json"]);
    record(r);
    expect(r.envelope.ok, r.out + r.err).toBe(true);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.envelope.data).toMatchObject({ persona: "alice", saved: save, userEnv: "JEV_T_USER", passwordEnv: "JEV_T_PASSWORD" });
    expect(String(r.envelope.data?.landedUrl)).toContain("/dashboard");
    expect(statSync(save).mode & 0o777).toBe(0o600);
    const state = JSON.parse(await readFile(save, "utf8")) as { cookies: Array<{ name: string; value: string }> };
    const sid = state.cookies.find((c) => c.name === "sid")?.value;
    expect(sid !== undefined && sessions.has(sid)).toBe(true);

    // The minted state passes the pre-flight: the run starts (a goal run on the dashboard succeeds).
    const ok = await run([
      "explore", "--url", `${origin}/dashboard`, "--goal", "see the dashboard", "--success", "textIncludes:css=h1|Dashboard",
      "--allow-vacuous-checks", "--storage-state", save, "--out", join(dir, "out-ok"), "--json",
    ]);
    record(ok);
    expect(ok.envelope.ok, ok.out + ok.err).toBe(true);
    expect((ok.envelope.data?.failure as { kind?: string } | undefined)?.kind).not.toBe("auth-expired");
    expect(ok.envelope.data?.missionOutcome).toBe("clean");
  }, 120_000);

  it("login waits for a form the page renders client-side after a delay", async () => {
    const save = join(dir, "states", "lazy.json");
    const r = await run(["login", "--url", `${origin}/login-lazy`, "--user-env", "JEV_T_USER", "--password-env", "JEV_T_PASSWORD", "--save", save, "--json"]);
    record(r);
    const state = existsSync(save) ? (JSON.parse(await readFile(save, "utf8")) as { cookies: Array<{ name: string; value: string }> }) : undefined;
    expect(r.envelope.ok && sessions.has(state?.cookies.find((c) => c.name === "sid")?.value ?? ""), r.out + r.err).toBe(true);
  }, 120_000);

  it("an authenticated API-credentials page with only a password field is not judged signed out", async () => {
    const save = join(dir, "states", "credentials.json");
    const minted = await run(["login", "--url", `${origin}/login`, "--user-env", "JEV_T_USER", "--password-env", "JEV_T_PASSWORD", "--save", save, "--json"]);
    record(minted);
    expect(minted.envelope.ok, minted.out + minted.err).toBe(true);

    const r = await run([
      "explore", "--url", `${origin}/credentials`, "--goal", "read the API credentials", "--success", "textIncludes:css=h1|API credentials",
      "--allow-vacuous-checks", "--storage-state", save, "--out", join(dir, "out-credentials"), "--json",
    ]);
    record(r);
    expect(r.envelope.data?.failure as { kind?: string } | undefined, r.out + r.err).not.toMatchObject({ kind: "auth-expired" });
  }, 120_000);

  it("a two-step sign-in (email, then a password page) mints a working state too", async () => {
    const save = join(dir, "states", "two-step.json");
    const r = await run(["login", "--url", `${origin}/signin`, "--user-env", "JEV_T_USER", "--password-env", "JEV_T_PASSWORD", "--success", "text:Dashboard", "--save", save, "--json"]);
    record(r);
    expect(r.envelope.ok, r.out + r.err).toBe(true);
    const state = JSON.parse(await readFile(save, "utf8")) as { cookies: Array<{ name: string; value: string }> };
    expect(sessions.has(state.cookies.find((c) => c.name === "sid")?.value ?? "")).toBe(true);
  });

  it("wrong credentials: E_LOGIN_FAILED (exit 2), nothing saved, no credential in the message", async () => {
    const save = join(dir, "states", "wrong.json");
    const r = await run(["login", "--url", `${origin}/login`, "--user-env", "JEV_T_USER", "--password-env", "JEV_T_WRONG", "--save", save, "--timeout", "20", "--json"]);
    record(r);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "E_LOGIN_FAILED" } });
    expect(r.exitCode).toBe(2);
    expect(existsSync(save)).toBe(false);
    expect(r.out + r.err).not.toContain(ENV.JEV_T_WRONG);
  });

  it("an expired session ends the run fast: inconclusive, failure.kind auth-expired, the login page never explored", async () => {
    const save = join(dir, "states", "alice.json");
    sessions.clear(); // the backend forgot every session (expired / rebuilt)
    const r = await run([
      "explore", "--url", `${origin}/dashboard`, "--goal", "see the dashboard", "--success", "textIncludes:css=h1|Dashboard",
      "--allow-vacuous-checks", "--storage-state", save, "--out", join(dir, "out-expired"), "--json",
    ]);
    record(r);
    expect(r.envelope.ok, r.out + r.err).toBe(true);
    expect(r.exitCode).toBe(2);
    expect(r.envelope.data).toMatchObject({ missionOutcome: "inconclusive", failure: { kind: "auth-expired" } });
    expect(String(r.envelope.data?.reason)).toMatch(/sign-in page \/login/);
    // Nothing ran: no mission artifacts were written.
    expect(existsSync(join(dir, "out-expired"))).toBe(false);
  });

  it("a queued mission on an expired persona session ends auth-expired, with a result get_mission_result reads", async () => {
    const save = join(dir, "states", "alice.json");
    sessions.clear();
    const outDir = join(dir, "queue-out");
    const target: MissionTarget = { id: "app", name: "App", authorizedOrigin: origin, apiOrigins: [], baseUrl: `${origin}/dashboard`, promoted: true, createdAtIso: "2026-10-08T00:00:00Z" };
    const mission = { id: "0b0f5b7e-2f7a-4d0e-9d55-4f3f2b1c0a99", target: "app", strategy: "coverage", persona: "alice", budget: { maxActions: 5, maxDecisions: 10, maxCandidates: 50 }, status: "running", enqueuedAtIso: "2026-10-08T00:00:00Z" } as unknown as QueuedMission;
    const execute = realQueuedMissionExecutor({
      outDir,
      gateways: async () => {
        throw new Error("the mission must not start");
      },
      browserPortFactory: () => new PlaywrightBrowserPort(),
      targets: { [origin]: { personas: { alice: { storageState: save } } } } as never,
      env: ENV,
    });
    const r = await execute({ mission, target, allowlist: [origin] });
    expect(r).toMatchObject({ missionOutcome: "inconclusive", exitCode: 2 });
    const written = JSON.parse(await readFile(r.resultPath, "utf8")) as { missionOutcome: string; result: Record<string, unknown> };
    expect(written).toMatchObject({ missionOutcome: "inconclusive", result: { failure: { kind: "auth-expired", persona: "alice" }, persona: "alice" } });
  });

  it("a persona's expired session is re-minted once from its login parameters, and the run goes on", async () => {
    const save = join(dir, "states", "alice.json");
    sessions.clear();
    const personas = join(dir, "personas.json");
    const login = { url: `${origin}/login`, userEnv: "JEV_T_USER", passwordEnv: "JEV_T_PASSWORD", success: "urlIncludes:/dashboard" };
    await writeFile(personas, JSON.stringify({ personas: [{ name: "alice", storageState: save, login }] }));
    const r = await run([
      "explore", "--url", `${origin}/dashboard`, "--goal", "see the dashboard", "--success", "textIncludes:css=h1|Dashboard",
      "--allow-vacuous-checks", "--personas", personas, "--out", join(dir, "out-refresh"), "--json",
    ]);
    record(r);
    expect(r.envelope.ok, r.out + r.err).toBe(true);
    expect(r.err).toMatch(/persona alice: .*signed in again/);
    const cells = r.envelope.data?.cells as Array<{ persona: string; missionOutcome: string; runs: Array<{ failureKind?: string }> }>;
    expect(cells[0]).toMatchObject({ persona: "alice", missionOutcome: "clean" });
    expect(cells[0]?.runs[0]?.failureKind).toBeUndefined();
    const state = JSON.parse(await readFile(save, "utf8")) as { cookies: Array<{ name: string; value: string }> };
    expect(sessions.has(state.cookies.find((c) => c.name === "sid")?.value ?? "")).toBe(true);
    expect(statSync(save).mode & 0o777).toBe(0o600);

    // A refresh that cannot sign in (wrong password) ends the persona's run auth-expired, persona named.
    sessions.clear();
    await writeFile(personas, JSON.stringify({ personas: [{ name: "alice", storageState: save, login: { ...login, passwordEnv: "JEV_T_WRONG" } }] }));
    const bad = await run([
      "explore", "--url", `${origin}/dashboard`, "--goal", "see the dashboard", "--success", "textIncludes:css=h1|Dashboard",
      "--allow-vacuous-checks", "--personas", personas, "--out", join(dir, "out-refresh-bad"), "--json",
    ]);
    record(bad);
    expect(bad.envelope.ok, bad.out + bad.err).toBe(true);
    const badCells = bad.envelope.data?.cells as Array<{ persona: string; missionOutcome: string; runs: Array<{ failureKind?: string; reason?: string }> }>;
    expect(badCells[0]).toMatchObject({ persona: "alice", missionOutcome: "inconclusive" });
    expect(badCells[0]?.runs[0]?.failureKind).toBe("auth-expired");
    expect(badCells[0]?.runs[0]?.reason).toMatch(/persona alice: .*re-signing in persona alice failed/);
  }, 120_000);

  it("neither credential appears in any stdout/stderr or any file the runs wrote", async () => {
    expect(transcript.length).toBeGreaterThan(0);
    for (const t of transcript) {
      expect(t).not.toContain(PASSWORD);
      expect(t).not.toContain(USER);
      expect(t).not.toContain(ENV.JEV_T_WRONG);
    }
    for (const f of await allFiles(dir)) {
      const bytes = await readFile(f);
      for (const secret of [PASSWORD, USER, ENV.JEV_T_WRONG, encodeURIComponent(PASSWORD), encodeURIComponent(USER)]) {
        expect(bytes.includes(Buffer.from(secret)), `${f} holds a credential`).toBe(false);
      }
    }
  });
});
