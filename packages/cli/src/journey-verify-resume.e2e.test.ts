import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { OWNER_MARKER_SWITCH } from "@jevitate/playwright";

/**
 * #787 with real processes, a real browser and a served page: a coordinator that dies, a verifier
 * killed with SIGKILL, and a fresh process reading what is left. Needs the built CLI (`pnpm -r build`);
 * `JEVITATE_E2E_BIN` runs another bundle of it. The first test says which code ran.
 */

const BIN = process.env["JEVITATE_E2E_BIN"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const ID = "save-then-publish";
/** #809 refuses a secret parameter over MCP, so the MCP case drives a twin Journey whose parameter is not secret-shaped. */
const MCP_ID = "save-then-publish-mcp";
const MCP_PARAM = "draftTitle";
const SECRET = "hunter2-do-not-keep";
const HOOK_MARK = "hook-text-do-not-keep";
const PAGE = `<!doctype html><html><head><title>Editor</title></head><body><main><h1>Editor</h1><label for="t">Token</label><input id="t">
<button type="button" onclick="fetch('/api/save',{method:'POST'}).then(r=>{if(r.ok)document.getElementById('saved').textContent='Saved'})">Save</button><p id="saved"></p>
<button type="button" onclick="fetch('/api/publish',{method:'POST'}).then(r=>{if(r.ok)document.getElementById('published').textContent='Published'})">Publish</button><p id="published"></p>
</main></body></html>`;

function journeyOn(site: string, id: string = ID, param: string = "apiToken"): Journey {
  return {
    metadata: { id, name: "Save then publish", promoted: false, params: [param], createdAtIso: "2026-10-07T00:00:00.000Z" },
    recording: {
      version: "1",
      site,
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
            { step: { kind: "fill", target: { label: "Token" }, value: { var: param }, expect: { kind: "count", target: { label: "Token" }, min: 0 } } },
            {
              step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { text: "Saved" } } },
              delta: { verdict: "relevant-change", why: "saved", changes: ["saved"], requests: ["POST /api/save → 200"], overheadMs: 1 },
            },
            {
              step: { kind: "click", target: { role: "button", name: "Publish" }, expect: { kind: "visible", target: { text: "Published" } } },
              delta: { verdict: "relevant-change", why: "published", changes: ["published"], requests: ["POST /api/publish → 200"], overheadMs: 1 },
            },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

interface Status {
  receipt: string;
  verifier: string;
  resume: { possible: boolean; refusal?: string };
  path: string;
  progress?: { state: string; verdict?: string; completed: number; total: number; currentPair: string | null; verifierPid: number; verifierStartToken: string; phase: string };
}
interface Report {
  verdict: string;
  reusedPairs: number;
  summary: unknown;
  assertions: unknown;
  mutations: { id: string; reused?: true }[];
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, withinMs: number, what: string): Promise<void> {
  const deadline = performance.now() + withinMs;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(100);
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
  } catch {
    return false;
  }
}
/** Live browsers a process launched. A killed verifier cannot close its own. */
function killMarkedBrowsers(pid: number): void {
  const marker = `${OWNER_MARKER_SWITCH}=${pid}@`;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let argv = "";
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!argv.includes(marker)) continue;
    try {
      process.kill(Number(entry), "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}

describe("[realtime] a mutation proof that loses its observer or its verifier", () => {
  let dir: string;
  let server: ChildProcess;
  let env: NodeJS.ProcessEnv;
  let site: string;
  const started: number[] = [];
  const coordinators: ChildProcess[] = [];

  const proofArgs = (...more: string[]): string[] => ["journey", "verify", ID, "--mutate", "--json", "--param", `apiToken=${SECRET}`, "--allow-shell-hooks", "--before", `true ${HOOK_MARK}`, ...more];
  const cli = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const status = (): Status => (JSON.parse(cli("journey", "verify", ID, "--status", "--json").stdout) as { data: Status }).data;
  /** Starts the verifier detached, the way a coordinator leaves one behind, with its output in files nobody reads until it ends. */
  function verifier(extraEnv: NodeJS.ProcessEnv = {}, ...more: string[]): { pid: number; closed: Promise<number | null>; stdout: () => string } {
    let stdout = "";
    const child = spawn(process.execPath, [BIN, ...proofArgs(...more)], { cwd: dir, env: { ...env, JEVITATE_PARENT_WATCHDOG: "off", ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString("utf8")));
    child.on("error", (err) => void (stdout += String(err)));
    started.push(child.pid as number);
    return { pid: child.pid as number, closed: new Promise((resolve) => child.once("close", (code) => resolve(code))), stdout: () => stdout };
  }
  /** A first finished pair of this verifier. It ends at once if the verifier does: a run refused for its flags would otherwise read as a long timeout. */
  async function firstPairOf(pid: number, output: () => string = () => ""): Promise<void> {
    await until(
      () => {
        if ((status().progress?.completed ?? 0) >= 1) return true;
        if (!isAlive(pid)) throw new Error(`verifier ${pid} ended before a first finished pair: ${output().slice(0, 400)}`);
        return false;
      },
      120_000,
      "a first finished pair",
    );
  }
  const reportOf = (stdout: string): Report => {
    const envelope = JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; data: Report };
    if (!envelope.ok) throw new Error(`no report, the command refused: ${stdout}`);
    return envelope.data;
  };
  const reset = (): void => {
    rmSync(join(dir, ".jevitate", "logs"), { recursive: true, force: true });
    rmSync(join(dir, ".jevitate", "journeys", ".verify"), { recursive: true, force: true });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "jevitate-verify-resume-"));
    mkdirSync(join(dir, ".jevitate", "journeys"), { recursive: true });
    mkdirSync(join(dir, "home", ".jevitate"), { recursive: true });
    // Its own process: `cli` and `status` block this one in spawnSync, and a page served from here would time out behind them.
    const serve = `const s=require("node:http").createServer((q,r)=>{if(q.method==="GET")return void r.writeHead(200,{"content-type":"text/html; charset=utf-8"}).end(${JSON.stringify(PAGE)});r.writeHead(200,{"content-type":"application/json"}).end("{}")});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))`;
    server = spawn(process.execPath, ["-e", serve], { stdio: ["ignore", "pipe", "ignore"] });
    let port = "";
    server.stdout!.on("data", (chunk: Buffer) => void (port += chunk.toString("utf8")));
    await until(() => port.includes("\n"), 20_000, "the page server to listen");
    site = `http://127.0.0.1:${port.trim()}`;
    // 0.30.0 §5: a draft is proved over MCP only on a test-mode target, which a person declares (here, the operator's file).
    writeFileSync(join(dir, "home", ".jevitate", "targets.json"), JSON.stringify({ [site]: { trust: "test" } }));
    await new FsJourneyStore(join(dir, ".jevitate", "journeys")).put(journeyOn(site));
    await new FsJourneyStore(join(dir, ".jevitate", "journeys")).put(journeyOn(site, MCP_ID, MCP_PARAM));
    env = { ...process.env, HOME: join(dir, "home"), PLAYWRIGHT_BROWSERS_PATH: process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? join(homedir(), ".cache", "ms-playwright") };
    delete env["JEVITATE_PARENT_WATCHDOG"];
  });

  afterAll(async () => {
    for (const coordinator of coordinators) if (coordinator.exitCode === null && coordinator.signalCode === null) coordinator.kill("SIGKILL");
    for (const pid of started) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
      killMarkedBrowsers(pid);
    }
    server.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns the code under test", () => {
    const help = cli("journey", "verify", "--help").stdout;
    expect(help).toContain("--resume");
    expect(help).toContain("--status");
    const version = cli("--version");
    expect(version.status).toBe(0);
    // A resume refuses a build that cannot name itself, so the rest needs one that can.
    expect(version.stdout).toContain("commit ");
    console.info(`#787 e2e spawned ${BIN}: ${version.stdout.trim()}`);
  });

  let whole: Report;

  it("a coordinator's death leaves a detached verifier going, a fresh status reads it, and a live verifier refuses a resume", async () => {
    // The coordinator is a real process, and it is the one killed: only its pipes and its pid go away.
    const coordinator = spawn(
      process.execPath,
      [
        "-e",
        `const c=require("node:child_process").spawn(process.execPath,${JSON.stringify([BIN, ...proofArgs()])},{cwd:${JSON.stringify(dir)},env:{...process.env,JEVITATE_PARENT_WATCHDOG:"off"},detached:true,stdio:["ignore","pipe","pipe"]});console.log(c.pid);setInterval(()=>{},1000)`,
      ],
      { env, stdio: ["ignore", "pipe", "ignore"] },
    );
    coordinators.push(coordinator);
    let out = "";
    coordinator.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
    await until(() => out.includes("\n"), 20_000, "the coordinator to start the verifier");
    const pid = Number(out.trim());
    started.push(pid);
    await firstPairOf(pid);
    coordinator.kill("SIGKILL");
    await new Promise((resolve) => coordinator.once("close", resolve));

    const seen = status();
    expect(seen).toMatchObject({ receipt: "valid", verifier: "live", resume: { possible: false, refusal: "live-verifier" }, progress: { verifierPid: pid, state: "running" } });
    expect(seen.path.startsWith(join(dir, ".jevitate", "logs", "verify-progress"))).toBe(true);
    expect(seen.progress!.total).toBeGreaterThanOrEqual(2);
    expect(isAlive(pid)).toBe(true);

    const refused = cli(...proofArgs("--resume"));
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_VERIFY_RESUME_REFUSED" }, data: { reason: "live-verifier" } });
    expect(status().progress?.verifierPid).toBe(pid);

    await until(() => !isAlive(pid), 240_000, "the verifier to finish");
    const after = status();
    expect(after).toMatchObject({ verifier: "exited", progress: { state: "finished", completed: seen.progress!.total } });
    expect(after.progress?.verdict).toBeDefined();
    expect(existsSync(join(dir, ".jevitate", "journeys", ".verify", `${ID}.json`))).toBe(true);
  }, 420_000);

  it("runs the same proof whole, for the verdict a resume must match, and never stores the secret or the hook", async () => {
    const raw = readFileSync(status().path, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(HOOK_MARK);
    expect(raw).not.toContain("/api/");
    expect(statSync(status().path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "home", ".jevitate", "verify-checkpoint.key")).mode & 0o777).toBe(0o600);
    reset();
    const run = verifier();
    await run.closed;
    whole = reportOf(run.stdout());
    expect(whole.reusedPairs).toBe(0);
    expect(whole.verdict).toBe("proven");
  }, 240_000);

  it("a verifier killed with SIGKILL is reported as gone, and a resume reuses its finished pairs and reaches the same verdict", async () => {
    reset();
    const run = verifier();
    await firstPairOf(run.pid, run.stdout);
    process.kill(run.pid, "SIGKILL");
    await run.closed;
    killMarkedBrowsers(run.pid);

    const dead = status();
    expect(dead).toMatchObject({ receipt: "valid", verifier: "exited", resume: { possible: true }, progress: { state: "running" } });
    const finished = dead.progress!.completed;
    expect(finished).toBeGreaterThanOrEqual(1);

    const resumed = cli(...proofArgs("--resume"));
    const report = reportOf(resumed.stdout);
    expect(report.reusedPairs).toBeGreaterThanOrEqual(finished);
    expect(report.mutations.filter((m) => m.reused === true)).toHaveLength(report.reusedPairs);
    expect({ verdict: report.verdict, summary: report.summary, assertions: report.assertions }).toEqual({ verdict: whole.verdict, summary: whole.summary, assertions: whole.assertions });
    expect(resumed.status).toBe(0);
    expect(status()).toMatchObject({ verifier: "exited", progress: { state: "finished", verdict: whole.verdict } });
    const receipt = JSON.parse(readFileSync(join(dir, ".jevitate", "journeys", ".verify", `${ID}.json`), "utf8")) as { reusedPairs?: number };
    expect(receipt.reusedPairs).toBe(report.reusedPairs);
  }, 420_000);

  it("resume against a damaged checkpoint, or another hook, refuses and leaves the file alone", async () => {
    reset();
    const run = verifier();
    await firstPairOf(run.pid, run.stdout);
    process.kill(run.pid, "SIGKILL");
    await run.closed;
    killMarkedBrowsers(run.pid);
    const path = status().path;
    const before = readFileSync(path, "utf8");
    const otherHook = cli("journey", "verify", ID, "--mutate", "--json", "--resume", "--param", `apiToken=${SECRET}`, "--allow-shell-hooks", "--before", "true another-hook");
    expect(otherHook.status).toBe(2);
    expect(JSON.parse(otherHook.stdout)).toMatchObject({ data: { reason: "hook" } });
    const otherParam = cli("journey", "verify", ID, "--mutate", "--json", "--resume", "--param", "apiToken=other", "--allow-shell-hooks", "--before", `true ${HOOK_MARK}`);
    expect(JSON.parse(otherParam.stdout)).toMatchObject({ data: { reason: "params" } });
    const otherOrigin = cli(...proofArgs("--resume", "--base-url", "http://127.0.0.1:9"));
    expect(JSON.parse(otherOrigin.stdout)).toMatchObject({ data: { reason: "origin" } });
    expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, before.slice(0, Math.floor(before.length / 2)));
    expect(status()).toMatchObject({ receipt: "corrupt", resume: { possible: false, refusal: "corrupt" } });
    expect(JSON.parse(cli(...proofArgs("--resume")).stdout)).toMatchObject({ data: { reason: "corrupt" } });
    writeFileSync(path, before.replace('"completed":[{', '"completed":[{"forged":true,'));
    expect(JSON.parse(cli(...proofArgs("--resume")).stdout)).toMatchObject({ data: { reason: "corrupt" } });
  }, 240_000);

  /** A real `jevitate mcp` over stdio, as a client drives one. */
  function mcpServer(): { pid: number; call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>; tools: () => Promise<string[]>; kill: () => Promise<void> } {
    const child = spawn(process.execPath, [BIN, "mcp"], { cwd: dir, env: { ...env, JEVITATE_PARENT_WATCHDOG: "off" }, stdio: ["pipe", "pipe", "ignore"] });
    started.push(child.pid as number);
    let nextId = 1;
    let buffered = "";
    const waiting = new Map<number, (result: unknown) => void>();
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, at)) as { id?: number; result?: unknown; error?: unknown };
        buffered = buffered.slice(at + 1);
        if (message.id !== undefined) waiting.get(message.id)?.(message.result ?? message.error);
      }
    });
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const ready = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }).then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`));
    return {
      pid: child.pid as number,
      tools: async () => {
        await ready;
        return ((await request("tools/list", {})) as { tools: { name: string }[] }).tools.map((t) => t.name);
      },
      call: async (name, args) => {
        await ready;
        const result = (await request("tools/call", { name, arguments: args })) as { content: { text: string }[] };
        return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      },
      kill: async () => {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("close", resolve));
      },
    };
  }

  it("over a real `jevitate mcp`: no new tool, status answers during that server's own proof, and a new server resumes it after a SIGKILL", async () => {
    reset();
    const params = { [MCP_PARAM]: "Spring launch" };
    // The verdict a resume must match, for this Journey and these params, with no hook: MCP takes none.
    const baseline = cli("journey", "verify", MCP_ID, "--mutate", "--json", "--param", `${MCP_PARAM}=${params[MCP_PARAM]}`);
    const mcpWhole = reportOf(baseline.stdout);
    reset();
    const first = mcpServer();
    expect((await first.tools()).sort()).toEqual([...ALLOWED_TOOLS].sort());
    // #809: the secret-param Journey is refused over MCP before anything runs.
    expect(await first.call("verify_journey", { id: ID, mutate: true, params: { apiToken: SECRET } })).toMatchObject({ code: "E_SECRET_PARAM_OVER_MCP" });
    // The proof call answers only when it ends. One that answers before a first pair was refused,
    // so it fails here with its answer rather than as a timeout (#809 turned the old secret-param call into one).
    let early: Record<string, unknown> | undefined;
    void first.call("verify_journey", { id: MCP_ID, mutate: true, params }).then(
      (r) => void (early = r),
      (e: unknown) => void (early = { error: String(e) }),
    );
    type Seen = { data: Status };
    const statusOf = async (server: ReturnType<typeof mcpServer>): Promise<Status> => ((await server.call("verify_journey", { id: MCP_ID, status: true })) as unknown as Seen).data;
    let seen = await statusOf(first);
    const deadline = performance.now() + 120_000;
    while ((seen.progress?.completed ?? 0) < 1) {
      if (early !== undefined) throw new Error(`the proof over MCP ended before a first finished pair: ${JSON.stringify(early).slice(0, 400)}`);
      if (performance.now() > deadline) throw new Error("timed out waiting for a first finished pair over MCP");
      await pause(200);
      seen = await statusOf(first);
    }
    expect(seen).toMatchObject({ receipt: "valid", verifier: "live", progress: { verifierPid: first.pid, state: "running" } });
    await first.kill();
    killMarkedBrowsers(first.pid);

    const second = mcpServer();
    const dead = await statusOf(second);
    expect(dead).toMatchObject({ verifier: "exited", resume: { possible: true } });
    const resumed = (await second.call("verify_journey", { id: MCP_ID, mutate: true, resume: true, params })) as unknown as { exitCode: number; data: Report };
    expect(resumed.data.reusedPairs).toBeGreaterThanOrEqual(dead.progress!.completed);
    expect({ verdict: resumed.data.verdict, summary: resumed.data.summary, assertions: resumed.data.assertions }).toEqual({ verdict: mcpWhole.verdict, summary: mcpWhole.summary, assertions: mcpWhole.assertions });
    await second.kill();
  }, 420_000);

  it("with the parent watchdog on, a dead parent ends the verifier, and what it finished is still there", async () => {
    reset();
    const coordinator = spawn(process.execPath, ["-e", `const c=require("node:child_process").spawn(process.execPath,${JSON.stringify([BIN, ...proofArgs()])},{cwd:${JSON.stringify(dir)},stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)`], { env, stdio: ["ignore", "pipe", "ignore"] });
    coordinators.push(coordinator);
    let out = "";
    coordinator.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
    await until(() => out.includes("\n"), 20_000, "the coordinator to start the verifier");
    const pid = Number(out.trim());
    started.push(pid);
    await firstPairOf(pid);
    coordinator.kill("SIGKILL");
    await until(() => !isAlive(pid), 30_000, "the watchdog to end the verifier");
    const after = status();
    expect(after).toMatchObject({ verifier: "exited", resume: { possible: true } });
    expect(after.progress!.completed).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
