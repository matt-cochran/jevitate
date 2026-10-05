import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore } from "@jevitate/journey";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { GOAL_ALREADY_MET_QUESTION, GOAL_MET_QUESTION } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * #369 served e2e: a goal that needs a bound secret field (a sign-in with the operator's password)
 * authors a Journey through `explore-author-journey --secret-field` — the password is typed by code,
 * never kept: the Journey takes it as a secret param and replays with it. Without the flag the run
 * cannot sign in, and the not-reached result points at the discovery run's own artifacts on disk.
 */

const PASSWORD = "served-pw-canary-93d1";
const APP = `<!doctype html><html><head><title>Sign in</title></head><body><main>
  <h1>Sign in</h1>
  <label>Password <input id="pw" type="password" aria-label="Password"></label>
  <button type="button" id="go">Sign in</button>
  <p data-testid="status" role="status"></p>
  <script>
    document.getElementById("go").onclick = () => {
      const ok = document.getElementById("pw").value === ${JSON.stringify(PASSWORD)};
      document.querySelector("[data-testid=status]").textContent = ok ? "Welcome back" : "Wrong password";
    };
  </script></main></body></html>`;
const SUCCESS = "textIncludes:testId=status|Welcome";

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-author-served-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.JEV_SERVED_PW;
});

/** Picks, in order: type into Password, click Sign in, then done. */
function signInJudge(): JudgmentPort {
  const script = [/type into .*Password/, /click .*Sign in/];
  let at = 0;
  return {
    async systemOne({ questions }: { questions: Record<string, { kind: string; options?: string[]; descriptions?: Record<string, string> }> }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const want = script[at];
          const pick = want === undefined ? "done" : (q.options ?? []).find((id) => want.test(q.descriptions?.[id] ?? ""));
          if (pick !== undefined && want !== undefined) at += 1;
          out[key] = { kind: "choice", value: pick ?? "wait", confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: true, probability: 0.95 };
        else if (key === GOAL_ALREADY_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.05 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options?.[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  } as unknown as JudgmentPort;
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { judge: signInJudge(), gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

const author = (id: string, out: string, extra: string[] = []): string[] => [
  "explore-author-journey", "--url", `${origin}/`, "--goal", "Sign in with the password", "--success", SUCCESS,
  "--id", id, "--name", id, "--fake-ai", "--max-decisions", "6", "--out", out, "--json", ...extra,
];

describe("explore-author-journey — served (#369)", () => {
  // #304: Node and page time skip idle waits (settle windows, replay polling).
  useSkippingTime();

  it("--secret-field: the goal is reached, the password becomes a secret param, and the Journey replays with it", async () => {
    process.env.JEV_SERVED_PW = PASSWORD;
    const journeysDir = join(dir, "j-ok");
    const out = join(dir, "runs-ok");
    const r = await cli(journeysDir, author("signin", out, ["--secret-field", "label=Password=env:JEV_SERVED_PW"]));
    expect(r.out).not.toContain(PASSWORD);
    const env = JSON.parse(r.out) as { ok: boolean; data: { outcome: string; discovery?: { resultPath?: string }; takes?: unknown } };
    expect(env.data.outcome, r.out).toBe("authored");
    expect(r.exitCode ?? 0).toBe(0);
    expect(env.data.takes).toEqual({ requested: 1, run: 1, succeeded: 1 });
    expect(existsSync(env.data.discovery?.resultPath ?? "")).toBe(true);

    const journey = await new FsJourneyStore(journeysDir).get("signin");
    expect(journey?.metadata.params).toEqual(["secret1"]);
    expect(journey?.metadata.parameters).toEqual([expect.objectContaining({ name: "secret1", secret: true })]);
    expect(JSON.stringify(journey)).not.toContain(PASSWORD);

    await cli(journeysDir, ["journey", "promote", "signin", "--json"]);
    const run = await cli(journeysDir, ["journey", "run", "signin", "--param", `secret1=${PASSWORD}`, "--json"]);
    expect((JSON.parse(run.out) as { data: { outcome: string } }).data.outcome, run.out).toBe("ok");
    expect(run.out).not.toContain(PASSWORD);
  });

  it("without the binding: not-reached, with the discovery run's concrete reason and its artifacts on disk", async () => {
    const out = join(dir, "runs-miss");
    const r = await cli(join(dir, "j-miss"), author("signin-miss", out));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.out) as {
      data: { outcome: string; reason: string; discovery: { outcome: string; reason?: string; stop?: string; resultPath: string; transcriptPath: string; recordingPaths: string[]; checks: { passed: boolean }[] } };
    };
    expect(env.data.outcome).toBe("not-reached");
    expect(env.data.reason).toMatch(/^discovery mission \w+: .+/);
    expect(env.data.reason).toContain("Welcome");
    const d = env.data.discovery;
    expect(d.stop).toBeDefined();
    expect(d.checks.some((c) => !c.passed)).toBe(true);
    for (const p of [d.resultPath, d.transcriptPath, ...d.recordingPaths]) {
      expect(p.startsWith(out), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });
});
