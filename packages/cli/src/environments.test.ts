import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import type { Recording } from "@jevitate/recording";
import { buildProgram } from "./program.js";
import { runCheck, type CheckRunners } from "./check-api.js";
import { parseSuite } from "./check-suite.js";
import { initProjectDir } from "./project-dir.js";
import {
  EnvironmentConfigError,
  EnvironmentOriginRefusedError,
  ENVIRONMENTS_SCAFFOLD,
  UnknownEnvironmentError,
  applyJourneyEnvironment,
  environmentsFilePath,
  loadEnvironmentsFile,
  parseEnvironments,
  rebaseRecording,
  resolveJourneyEnvironment,
} from "./environments.js";

/**
 * #247 — Journeys are environment-free; `.jevitate/environments.json` names the environments and
 * `--env`/`--base-url` choose one at run time. The served (real-Chromium) half is in
 * environments-served.test.ts; here: the file's schema, the resolver, the rebase, `init`'s scaffold,
 * and the CLI refusals (exit 64, no browser opened) and back-compat, with a capturing port.
 */

const RECORDED = "https://recorded.example.test";

const recording = (extra: Recording["pages"] = []): Recording => ({
  version: "1",
  site: RECORDED,
  pages: [
    {
      url: "/login",
      steps: [
        { step: { kind: "navigate", url: "/login", expect: { kind: "urlIncludes", text: "/login" } } },
        { step: { kind: "navigate", url: `${RECORDED}/account?tab=1#top`, expect: { kind: "urlIncludes", text: `${RECORDED}/account` } } },
      ],
    },
    ...extra,
  ],
});

const journey = (rec: Recording = recording()): Journey => ({
  metadata: { id: "login", name: "login", promoted: true, params: [], createdAtIso: "2026-09-28T00:00:00Z" },
  recording: rec,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-env-"));
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

function envFile(content: unknown): string {
  const p = join(root, "environments.json");
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

describe(".jevitate/environments.json", () => {
  it("parses environments, normalizing origins and resolving fixtures against the file", () => {
    const envs = loadEnvironmentsFile(
      envFile({
        $comment: "docs",
        local: { baseUrl: "http://localhost:3000/", allow: ["https://auth.example.test", "http://localhost:3000"] },
        staging: { baseUrl: "https://staging.example.test", fixtures: "fx/staging.json", hooks: { before: "./seed.sh" } },
      }),
    );
    expect(envs.local).toEqual({ baseUrl: "http://localhost:3000", allow: ["https://auth.example.test"] });
    expect(envs.staging).toEqual({ baseUrl: "https://staging.example.test", allow: [], fixtures: join(root, "fx/staging.json"), hooks: { before: "./seed.sh" } });
    expect(Object.keys(envs)).toEqual(["local", "staging"]);
  });

  it("a missing file is no environments; invalid ones fail with a path-precise error", () => {
    expect(loadEnvironmentsFile(join(root, "absent.json"))).toEqual({});
    const bad = (content: unknown, msg: RegExp) => expect(() => loadEnvironmentsFile(envFile(content))).toThrow(msg);
    bad("{not json", /is not valid JSON/);
    bad([], /must be an object keyed by environment name/);
    bad({ local: {} }, /\[local\]\.baseUrl is required/);
    bad({ local: { baseUrl: "ftp://x" } }, /\[local\]\.baseUrl must be an http\(s\) origin/);
    bad({ local: { baseUrl: "http://x.test/app" } }, /\[local\]\.baseUrl must be an origin with no path/);
    bad({ local: { baseUrl: "http://x.test", allow: ["nope"] } }, /\[local\]\.allow\[0\] must be an http\(s\) origin/);
    bad({ local: { baseUrl: "http://x.test", extra: 1 } }, /\[local\]\.extra: unknown key/);
    bad({ local: { baseUrl: "http://x.test", hooks: { during: "x" } } }, /\[local\]\.hooks\.during: unknown key/);
    bad({ "../x": { baseUrl: "http://x.test" } }, /an environment name is letters/);
    bad({ prod: { baseUrl: "http://x.test", production: "yes" } }, /\[prod\]\.production must be true or false/);
  });

  it("#249: `production: true` is carried to the resolved environment (demo refuses it); absent or false is not", () => {
    const file = envFile({ prod: { baseUrl: "https://app.test", production: true }, staging: { baseUrl: "https://s.test", production: false } });
    expect(loadEnvironmentsFile(file).prod?.production).toBe(true);
    expect(resolveJourneyEnvironment({ env: "prod", environmentsFile: file, targets: {} })?.production).toBe(true);
    expect(resolveJourneyEnvironment({ env: "staging", environmentsFile: file, targets: {} })).not.toHaveProperty("production");
  });

  it("NEVER holds secrets or sessions: such keys are refused, pointing at ~/.jevitate", () => {
    for (const key of ["storageState", "secretFields", "password", "apiKey", "token", "cookies", "credentials"]) {
      expect(() => parseEnvironments({ staging: { baseUrl: "https://s.test", [key]: "x" } }, "environments.json", root)).toThrow(EnvironmentConfigError);
    }
    expect(() => parseEnvironments({ staging: { baseUrl: "https://s.test", hooks: { before: "x", secret: "y" } } }, "environments.json", root)).toThrow(
      /environments\.json\[staging\]\.hooks\.secret: environments\.json is committed .* never holds secrets or sessions .*~\/\.jevitate\/targets\.json/,
    );
    expect(() => parseEnvironments({ staging: { baseUrl: "https://user:pw@s.test" } }, "f", root)).toThrow(/must not carry credentials/);
  });

  it("is found in the repo's .jevitate/ (as journeys are), never in ~/.jevitate", () => {
    const repo = join(root, "app");
    mkdirSync(join(repo, ".jevitate"), { recursive: true });
    mkdirSync(join(repo, "web"), { recursive: true });
    expect(environmentsFilePath({ cwd: () => join(repo, "web"), homedir: () => join(root, "home") })).toBe(join(repo, ".jevitate", "environments.json"));
    expect(environmentsFilePath({ cwd: () => root, homedir: () => join(root, "home") })).toBeNull();
  });

  it("`init` scaffolds a valid, documented example once and never overwrites it", () => {
    const repo = join(root, "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const first = initProjectDir(repo);
    const file = join(repo, ".jevitate", "environments.json");
    expect(first.created).toContain(file);
    const scaffold = readFileSync(file, "utf8");
    expect(JSON.parse(scaffold)).toEqual(ENVIRONMENTS_SCAFFOLD);
    expect(scaffold).toMatch(/NEVER put secrets or sessions here/);
    expect(loadEnvironmentsFile(file)).toEqual({ local: { baseUrl: "http://localhost:3000", allow: [] } });
    expect(initProjectDir(repo).created).toEqual([]);
    writeFileSync(file, JSON.stringify({ mine: { baseUrl: "http://127.0.0.1:1" } }));
    expect(initProjectDir(repo).created).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mine: { baseUrl: "http://127.0.0.1:1" } });
    // --dry-run reports it and writes nothing.
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    expect(initProjectDir(other, { dryRun: true }).created).toContain(join(other, ".jevitate", "environments.json"));
    expect(existsSync(join(other, ".jevitate"))).toBe(false);
  });
});

describe("resolveJourneyEnvironment", () => {
  const targetsFile = () => {
    const p = join(root, "targets.json");
    writeFileSync(
      p,
      JSON.stringify({
        "https://staging.example.test": {
          storageState: "staging.state.json",
          secretFields: ["label=Password=env:STAGING_PASSWORD"],
          personas: { admin: { storageState: "admin.state.json" } },
        },
      }),
    );
    return p;
  };
  const file = () => envFile({ staging: { baseUrl: "https://staging.example.test", allow: ["https://auth.example.test"] }, local: { baseUrl: "http://localhost:3000" } });

  it("no --env and no --base-url: undefined (the recorded site, as before)", () => {
    expect(resolveJourneyEnvironment({ environmentsFile: file() })).toBeUndefined();
  });

  it("--env: the environment's origin and allowlist, with its session from ~/.jevitate/targets.json", () => {
    expect(resolveJourneyEnvironment({ env: "staging", environmentsFile: file(), targetsFile: targetsFile() })).toEqual({
      name: "staging",
      baseUrl: "https://staging.example.test",
      allowedOrigins: ["https://staging.example.test", "https://auth.example.test"],
      storageState: join(root, "staging.state.json"),
      secretFields: ["label=Password=env:STAGING_PASSWORD"],
      source: `${join(root, "environments.json")}[staging]`,
    });
    expect(resolveJourneyEnvironment({ env: "staging", persona: "admin", environmentsFile: file(), targetsFile: targetsFile() })?.storageState).toBe(join(root, "admin.state.json"));
    expect(() => resolveJourneyEnvironment({ env: "staging", persona: "ghost", environmentsFile: file(), targetsFile: targetsFile() })).toThrow(/persona "ghost" .*known personas: admin/);
  });

  it("--base-url alone is an ad-hoc environment; with --env it replaces the baseUrl", () => {
    const t = targetsFile();
    expect(resolveJourneyEnvironment({ baseUrl: "http://127.0.0.1:4000/", targetsFile: t })).toEqual({ baseUrl: "http://127.0.0.1:4000", allowedOrigins: ["http://127.0.0.1:4000"], source: "--base-url" });
    expect(resolveJourneyEnvironment({ env: "staging", baseUrl: "http://127.0.0.1:4000", environmentsFile: file(), targetsFile: t })?.allowedOrigins).toEqual(["http://127.0.0.1:4000", "https://auth.example.test"]);
    expect(() => resolveJourneyEnvironment({ baseUrl: "http://127.0.0.1:4000/app", targetsFile: t })).toThrow(/--base-url must be an origin/);
  });

  it("an unknown --env lists the known ones", () => {
    const err = (() => {
      try {
        resolveJourneyEnvironment({ env: "prod", environmentsFile: file(), targetsFile: targetsFile() });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(UnknownEnvironmentError);
    expect((err as Error).message).toMatch(/unknown environment "prod": known environments: local, staging/);
  });
});

describe("rebasing a Journey onto an environment", () => {
  const staging = { name: "staging", baseUrl: "https://staging.example.test", allowedOrigins: ["https://staging.example.test", "https://auth.example.test"], source: "t" };

  it("moves recorded same-origin URLs onto the baseUrl and keeps app-relative paths", () => {
    const out = rebaseRecording(recording(), staging);
    expect(out.site).toBe("https://staging.example.test");
    expect(out.pages[0]!.url).toBe("/login");
    expect(out.pages[0]!.steps[0]!.step).toEqual({ kind: "navigate", url: "/login", expect: { kind: "urlIncludes", text: "/login" } });
    expect(out.pages[0]!.steps[1]!.step).toEqual({
      kind: "navigate",
      url: "https://staging.example.test/account?tab=1#top",
      expect: { kind: "urlIncludes", text: "https://staging.example.test/account" },
    });
    // Never mutates the stored Journey; no environment is the identity.
    expect(recording().site).toBe(RECORDED);
    const j = journey();
    expect(applyJourneyEnvironment(j, undefined)).toBe(j);
  });

  it("a step on another origin is allowed only when the environment allows it — never guessed", () => {
    const auth = recording([{ url: "https://auth.example.test/sso", steps: [{ step: { kind: "navigate", url: "https://auth.example.test/sso", expect: { kind: "urlIncludes", text: "/sso" } } }] }]);
    expect(rebaseRecording(auth, staging).pages[1]!.url).toBe("https://auth.example.test/sso");
    const evil = recording([{ url: "/x", steps: [{ step: { kind: "navigate", url: "https://evil.example.test/x", expect: { kind: "urlIncludes", text: "/x" } } }] }]);
    expect(() => rebaseRecording(evil, staging)).toThrow(EnvironmentOriginRefusedError);
    expect(() => rebaseRecording(evil, staging)).toThrow(/is on https:\/\/evil\.example\.test — not allowed by the environment 'staging'/);
  });
});

describe("rebasing a navigate URL with ${param} placeholders (#399)", () => {
  const staging = { name: "staging", baseUrl: "https://staging.example.test", allowedOrigins: ["https://staging.example.test"], source: "t" };

  it("keeps each placeholder verbatim on the new origin (never percent-encoded by URL parsing)", () => {
    const rec = recording([{ url: "/teams", steps: [{ step: { kind: "navigate", url: `${RECORDED}/teams/\${team}/accept?token=\${inviteToken}`, expect: { kind: "urlIncludes", text: "/accept" } } }] }]);
    const step = rebaseRecording(rec, staging).pages[1]!.steps[0]!.step;
    expect(step).toMatchObject({ kind: "navigate", url: "https://staging.example.test/teams/${team}/accept?token=${inviteToken}" });
  });
});

describe("journey run --env / --base-url (CLI)", () => {
  function harness(opts: { environmentsFile?: string } = {}) {
    const opens: OpenOptions[] = [];
    const port: BrowserPort = {
      async open(o) {
        opens.push(o);
        return { page: { url: () => "about:blank" } as never, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
      },
    };
    const lines: string[] = [];
    const targetsConfigPath = join(root, "targets.json");
    const program = buildProgram({
      profiles: new ProfileManager("/unused"),
      dbPath: join(root, "db.sqlite"),
      ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }),
      explore: { browserPortFactory: () => port, targetsConfigPath },
    });
    program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
    program.exitOverride();
    const run = async (argv: string[]) => {
      lines.length = 0;
      process.exitCode = undefined;
      await program.parseAsync(argv, { from: "user" });
      return { out: JSON.parse(lines.join("")) as { ok: boolean; data?: unknown; error?: { code: string; message: string } }, code: process.exitCode };
    };
    return { run, opens };
  }

  async function seed(j: Journey = { ...journey(), recording: { version: "1", site: RECORDED, pages: [] } }): Promise<string> {
    const dir = join(root, "journeys");
    await new JourneyRegistry(new FsJourneyStore(dir)).put(j);
    return dir;
  }

  it("back-compat golden: no --env opens exactly what it did before (the recorded site), same result", async () => {
    const dir = await seed();
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000" } }) });
    const r = await h.run(["journey", "run", "login", "--dir", dir, "--json"]);
    expect(r.out.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(h.opens).toEqual([{ headless: true, allowedOrigins: [RECORDED], baseUrl: RECORDED }]);
    expect(r.out.data).toMatchObject({ outcome: "ok" });
  });

  it("--env runs on the environment's baseUrl with its allowlist", async () => {
    const dir = await seed();
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000", allow: ["http://127.0.0.1:9"] } }) });
    const r = await h.run(["journey", "run", "login", "--dir", dir, "--env", "local", "--json"]);
    expect(r.out.ok).toBe(true);
    expect(h.opens).toEqual([{ headless: true, allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:9"], baseUrl: "http://localhost:3000" }]);
    // (a fresh program: commander keeps option values across parses of one program)
    const h2 = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000", allow: ["http://127.0.0.1:9"] } }) });
    const b = await h2.run(["journey", "run", "login", "--dir", dir, "--base-url", "http://127.0.0.1:4321", "--json"]);
    expect(b.out.ok).toBe(true);
    expect(h2.opens[0]).toEqual({ headless: true, allowedOrigins: ["http://127.0.0.1:4321"], baseUrl: "http://127.0.0.1:4321" });
  });

  it("an unknown --env is exit 64 listing the known ones; nothing opened", async () => {
    const dir = await seed();
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000" }, staging: { baseUrl: "https://s.test" } }) });
    const r = await h.run(["journey", "run", "login", "--dir", dir, "--env", "prod", "--json"]);
    expect(r.out.error?.code).toBe("E_ENV_UNKNOWN");
    expect(r.out.error?.message).toMatch(/known environments: local, staging/);
    expect(r.code).toBe(64);
    expect(h.opens).toHaveLength(0);
    // No environments file at all: still 64, and it says how to get one.
    const none = harness({ environmentsFile: join(root, "missing.json") });
    const n = await none.run(["journey", "run", "login", "--dir", dir, "--env", "local", "--json"]);
    expect(n.code).toBe(64);
    expect(n.out.error?.message).toMatch(/no environments are declared/);
  });

  it("a secret in environments.json refuses the run (exit 64), pointing at ~/.jevitate", async () => {
    const dir = await seed();
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000", storageState: "s.json" } }) });
    const r = await h.run(["journey", "run", "login", "--dir", dir, "--env", "local", "--json"]);
    expect(r.out.error?.code).toBe("E_ENV_CONFIG");
    expect(r.out.error?.message).toMatch(/\[local\]\.storageState: .*never holds secrets or sessions/);
    expect(r.code).toBe(64);
    expect(h.opens).toHaveLength(0);
  });

  it("a cross-origin step the environment does not allow is exit 64, before any browser opens", async () => {
    const dir = await seed(journey(recording([{ url: "/x", steps: [{ step: { kind: "navigate", url: "https://evil.example.test/x", expect: { kind: "urlIncludes", text: "/x" } } }] }])));
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000" } }) });
    const r = await h.run(["journey", "run", "login", "--dir", dir, "--env", "local", "--json"]);
    expect(r.out.error?.code).toBe("E_ENV_ORIGIN_REFUSED");
    expect(r.code).toBe(64);
    expect(h.opens).toHaveLength(0);
  });

  it("the environment's session (~/.jevitate/targets.json[origin]) is used when --storage-state is absent", async () => {
    const dir = await seed();
    const state = join(root, "local.state.json");
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    writeFileSync(join(root, "targets.json"), JSON.stringify({ "http://localhost:3000": { storageState: state } }));
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000" } }) });
    const r = await h.run(["journey", "run", "login", "--dir", dir, "--env", "local", "--json"]);
    expect(r.out.ok).toBe(true);
    expect(h.opens[0]?.storageState).toBe(state);
  });

  it("journey annotate takes --env through the same resolver: rebased replay, unknown env 64, never with --approve", async () => {
    const dir = await seed();
    const environmentsFile = envFile({ local: { baseUrl: "http://localhost:3000" } });
    const h = harness({ environmentsFile });
    const r = await h.run(["journey", "annotate", "login", "--dir", dir, "--env", "local", "--fake-ai", "--json"]);
    expect(r.out.ok, JSON.stringify(r.out)).toBe(true);
    expect(h.opens[0]).toMatchObject({ allowedOrigins: ["http://localhost:3000"], baseUrl: "http://localhost:3000" });
    const unknown = await harness({ environmentsFile }).run(["journey", "annotate", "login", "--dir", dir, "--env", "prod", "--fake-ai", "--json"]);
    expect(unknown.out.error?.code).toBe("E_ENV_UNKNOWN");
    expect(unknown.code).toBe(64);
    const approve = await harness({ environmentsFile }).run(["journey", "annotate", "login", "--dir", dir, "--env", "local", "--approve", "--json"]);
    expect(approve.out.error?.code).toBe("E_JOURNEY_ANNOTATE_ARGS");
    expect(approve.code).toBe(64);
  });

  it("regression run and load run refuse an unknown --env the same way (exit 64)", async () => {
    const regressions = join(root, "regressions");
    mkdirSync(regressions);
    writeFileSync(join(regressions, "r1.recording.json"), JSON.stringify(recording()));
    writeFileSync(join(regressions, "r1.meta.json"), JSON.stringify({ id: "r1" }));
    const h = harness({ environmentsFile: envFile({ local: { baseUrl: "http://localhost:3000" } }) });
    const reg = await h.run(["regression", "run", "r1", "--dir", regressions, "--env", "nope", "--json"]);
    expect(reg.out.error?.code).toBe("E_ENV_UNKNOWN");
    expect(reg.code).toBe(64);
    const dir = await seed();
    const load = await h.run(["load", "run", "login", "--dir", dir, "--authorized-origin", "http://localhost:3000", "--env", "nope", "--json"]);
    expect(load.out.error?.code).toBe("E_ENV_UNKNOWN");
    expect(load.code).toBe(64);
    expect(h.opens).toHaveLength(0);
  });
});

describe("check-suite Journey items take env / baseUrl", () => {
  async function setup(item: Record<string, unknown>, allow: string[] = ["http://localhost:3000"]) {
    const dir = join(root, "journeys");
    await new JourneyRegistry(new FsJourneyStore(dir)).put(journey());
    const suite = parseSuite(
      { version: 1, name: "ci", targets: [{ name: "app", url: "http://localhost:3000/", allow, journeys: [{ id: "login", ...item }] }] },
      join(root, "suite.json"),
    );
    const calls: Array<Record<string, unknown>> = [];
    const runner = (async (o: Record<string, unknown>) => {
      calls.push(o);
      return { outcome: "ok" };
    }) as unknown as CheckRunners["journey"];
    return { dir, suite, calls, runner };
  }

  it("an item's env is resolved at preflight and handed to the Journey run", async () => {
    const { dir, suite, calls, runner } = await setup({ env: "local" });
    const environmentsFile = envFile({ local: { baseUrl: "http://localhost:3000" } });
    const r = await runCheck({ suite, outDir: join(root, "out"), journeysDir: dir, runners: { journey: runner }, environmentsFile, targetsConfig: {} });
    expect(r.items.map((i) => i.verdict)).toEqual(["passed"]);
    expect(calls[0]?.environment).toMatchObject({ name: "local", baseUrl: "http://localhost:3000", allowedOrigins: ["http://localhost:3000"] });
    const result = JSON.parse(readFileSync(r.results[0]!, "utf8")) as { result: { target: { seedUrl: string } } };
    expect(result.result.target.seedUrl).toBe("http://localhost:3000");
  });

  it("an unknown env, or one off the target's allowlist, refuses the suite before anything runs", async () => {
    const environmentsFile = envFile({ local: { baseUrl: "http://localhost:3000" }, staging: { baseUrl: "https://staging.example.test" } });
    const unknown = await setup({ env: "prod" });
    await expect(runCheck({ suite: unknown.suite, outDir: join(root, "out"), journeysDir: unknown.dir, runners: { journey: unknown.runner }, environmentsFile, targetsConfig: {} })).rejects.toThrow(
      /Journey login: unknown environment "prod": known environments: local, staging/,
    );
    expect(unknown.calls).toEqual([]);
    const off = await setup({ env: "staging" });
    await expect(runCheck({ suite: off.suite, outDir: join(root, "out2"), journeysDir: off.dir, runners: { journey: off.runner }, environmentsFile, targetsConfig: {} })).rejects.toThrow(
      /runs on https:\/\/staging\.example\.test, which is not on the target's allowlist/,
    );
  });
});
