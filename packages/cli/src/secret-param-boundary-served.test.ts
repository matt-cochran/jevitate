import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, isSecretName, type Journey } from "@jevitate/journey";
import { buildMcpTools, type McpTool } from "./mcp-api.js";
import { CLI_TOOL_SPECS, type CliCommandSpec } from "./mcp-cli-tools.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import type { CliDeps } from "./cli-shared.js";
import { SECRET_PARAM_OVER_MCP } from "./secret-params.js";
import { prefixFromBranch, type RecordedBranch } from "./journey-prefix.js";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { safeRunPolicy } from "@jevitate/domain";
import { runJourneyProgrammatically } from "./journey-api.js";
import { makeEvidenceSelfHealer } from "./self-heal-adapter.js";
import { annotateJourney, annotationDraftPath, SecretBoundJourneyError } from "./journey-annotate-api.js";
import { refusalOf } from "./demo-aspect-cli.js";
import { OpenRouterGenerationGateway, envCredentialStore, type GenerationPort } from "@jevitate/ai-core";
import { readJourneyChangeScope } from "./journey-heal.js";
import { MissionFixtures } from "./mission-fixtures.js";

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
let leavesFor: string | undefined;
let showsSecrets = "";
const typedWho: string[] = [];

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
    if ((req.url ?? "").startsWith("/who?")) {
      typedWho.push(new URL(req.url ?? "", "http://x").searchParams.get("v") ?? "");
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/mint") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tok: MINTED, sec: "SecOutVal9Kx2", order: "ord-1" }));
      return;
    }
    if (req.url === "/go" && redirectTo !== undefined) {
      res.writeHead(302, { location: redirectTo }).end();
      return;
    }
    if (leavesFor !== undefined && (req.url ?? "").startsWith("/edit-")) {
      const leave = `location.href=${JSON.stringify(`${leavesFor}/`)}`;
      const on = req.url === "/edit-keydown" ? `onkeydown='${leave}' onbeforeinput='${leave}'` : req.url === "/edit-plain" ? `onkeydown='this.dataset.k=+(this.dataset.k||0)+1;document.querySelector("[data-testid=keys]").textContent="keys="+this.dataset.k'` : "";
      const modelEvent = /^\/edit-model-(\w+)$/.exec(req.url ?? "")?.[1];
      if (modelEvent !== undefined) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<label>Password <input type=password></label><div data-testid=ed contenteditable>x</div><p data-testid=keys></p><script>let n=0;document.querySelector("[data-testid=ed]").addEventListener(${JSON.stringify(modelEvent)},(e)=>{if(${JSON.stringify(modelEvent)}!=="keydown"||e.key.length===1){n+=1;document.querySelector("[data-testid=keys]").textContent="model="+n}})</script>`);
        return;
      }
      const script = req.url === "/edit-select" ? `<script>document.addEventListener("selectionchange",()=>{if(document.activeElement&&document.activeElement.isContentEditable)${leave}})</script>` : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<label>Password <input type=password></label><div data-testid=ed contenteditable ${on}>x</div><p data-testid=keys></p>${script}`);
      return;
    }
    if (leavesFor !== undefined && (req.url ?? "").startsWith("/moves-")) {
      const field = req.url === "/moves-disabled" ? "disabled" : req.url === "/moves-hidden" ? 'style="visibility:hidden"' : "";
      const select = req.url === "/moves-select" ? `<label>Plan <select data-testid=plan disabled><option>none</option></select></label>` : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<label>Password <input type=password ${field}></label>${select}<script>setTimeout(()=>{location.href=${JSON.stringify(`${leavesFor}/`)}},${select === "" ? 600 : 1500})</script>`);
      return;
    }
    pageLoads += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      showsSecrets +
      `<h1>Sign in</h1><label>Password <input id=pw data-testid=pw type=password></label><input data-testid=who oninput="fetch('/who?v='+encodeURIComponent(this.value),{method:'HEAD'})">` +
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
    expect(String(r.body["message"])).toContain("--secret-field");
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

  it.each([[{ env: "local" }], [{}]])("a Journey that needs a secret doesn't run, even with none in the request and targets.json binding it (%j)", async (extra) => {
    const r = await call("run_journey", { id: "login", ...extra });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["secret1"] });
    expect(String(r.body["message"])).toContain("--secret-field");
    expect(pageLoads).toBe(0);
    expect(r.text).not.toContain(VALUE);
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

/** Approved by this channel: `tty` is a person's, `mcp` an agent's. No channel: an approval older than provenance. */
function approved(j: Journey, channel?: string): Journey {
  j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z", ...(channel === undefined ? {} : { provenance: { channel, agentSignals: [] } }) } as never;
  return j;
}

function fillNamed(name: string, secret?: boolean, channel?: string, id = `named-${name}`): Journey {
  const j = journey(id, name);
  j.metadata.parameters = [{ name, ...(secret === undefined ? {} : { secret }) }];
  j.recording.pages[0]!.steps = [
    { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "who" } } } },
    { step: { kind: "fill", target: { testId: "who" }, value: { var: name }, expect: { kind: "visible", target: { testId: "who" } } } },
  ] as never;
  approved(j, channel);
  writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
  return j;
}

describe("which names count (H3, R5, M3)", { timeout: 120_000 }, () => {
  useSkippingTime();

  it.each(["pwd", "jwt", "bearer", "authorization", "auth", "pin_code", "pinCode", "privateKey", "access_key", "mfa_code", "ssn", "cvv", "sess", "usertoken", "mysecret", "otpcode", "csrftoken", "passwort", "pincode"])("%s is refused when undeclared", async (name) => {
    fillNamed(name);
    const r = await call("run_journey", { id: `named-${name}`, params: { [name]: VALUE } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: [name] });
    expect(r.text).not.toContain(VALUE);
  });

  it.each(["author", "authorName", "shipping_method", "sku", "orderId"])("%s runs without declaring anything", async (name) => {
    fillNamed(name);
    const r = await call("run_journey", { id: `named-${name}`, params: { [name]: "3" } });
    expect(r.body["outcome"], r.text).toBe("ok");
  });

  it.each(["passengers", "footprint", "compass", "bypass_cache", "passport_country", "token_count", "tokenCount", "session_name", "cookie_banner", "otp_channel"])("%s: refused until it declares secret: false and a person approves", async (name) => {
    fillNamed(name);
    const refused = await call("run_journey", { id: `named-${name}`, params: { [name]: "3" } });
    expect(refused.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP });
    expect(String(refused.body["message"])).toContain("jevitate journey promote");
    fillNamed(name, false, "tty");
    const r = await call("run_journey", { id: `named-${name}`, params: { [name]: "3" } });
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(r.body["output"]).toMatchObject({ [name]: "3" }); // and it is not redacted
  });
});

describe("the broad name list doesn't decide whether a Journey loads", { timeout: 120_000 }, () => {
  useSkippingTime();
  const loadsFrom = (j: Journey): Journey => {
    approved(j);
    writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
    return j;
  };

  it("an assertion on ${key} loads and runs on the CLI, the value redacted; over MCP the value is refused", async () => {
    const j = journey("asserts-key", "key");
    j.metadata.parameters = [{ name: "key" }];
    j.recording.pages[0]!.steps = [
      { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "who" } } } },
      { step: { kind: "fill", target: { testId: "who" }, value: { var: "key" }, expect: { kind: "valueEquals", target: { testId: "who" }, value: { var: "key" } } } },
    ] as never;
    loadsFrom(j);
    const r = await cli(["journey", "run", "asserts-key", "--param", "key=kEy-VaLuE-77", "--json"]);
    expect(JSON.parse(r.out), r.out).toMatchObject({ ok: true, data: { outcome: "ok" } });
    expect(r.out).not.toContain("kEy-VaLuE-77");
    const over = await call("run_journey", { id: "asserts-key", params: { key: "kEy-VaLuE-77" } });
    expect(over.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["key"] });
    expect(over.text).not.toContain("kEy-VaLuE-77");
  });

  it.each(["key", "signature", "nonce"])("a body-shape field named %s loads", async (field) => {
    const j = journey(`shape-${field}`, "who");
    j.metadata.parameters = [{ name: "who" }];
    j.recording.pages[0]!.steps = [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "who" } } } }, { step: { kind: "fill", target: { testId: "who" }, value: { var: "who" }, expect: { kind: "visible", target: { testId: "who" } } }, }] as never;
    j.metadata.endState = [{ kind: "requestMade", method: "POST", pathGlob: "/x", bodyShape: { fields: [{ name: field, predicate: "string" }] } }] as never;
    loadsFrom(j);
    const stored = await new FsJourneyStore(journeysDir).get(j.metadata.id);
    expect(stored?.metadata.id).toBe(j.metadata.id);
    expect(isSecretName(field)).toBe(true); // ...and the broad list still reads it as a credential
  });

  it("a word from the old rule still refuses to load, as it did", async () => {
    const j = journey("shape-password", "who");
    j.metadata.endState = [{ kind: "requestMade", method: "POST", pathGlob: "/x", bodyShape: { fields: [{ name: "password", predicate: "string" }] } }] as never;
    loadsFrom(j);
    await expect(new FsJourneyStore(journeysDir).get("shape-password")).rejects.toThrow(/names a credential/);
    rmSync(join(journeysDir, "shape-password.json"));
  });
});

describe("who may use secret: false (R4, R6)", { timeout: 120_000 }, () => {
  useSkippingTime();
  it.each([["mcp"], ["non-interactive"], ["ci"], [undefined]])("an approval by %s lifts nothing on password", async (channel) => {
    fillNamed("password", false, channel, "sf-password");
    const r = await call("run_journey", { id: "sf-password", env: "local", params: { password: VALUE } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["password"] });
    expect(String(r.body["message"])).toContain("jevitate journey promote");
    expect(r.text).not.toContain(VALUE);
    expect(pageLoads).toBe(0);
  });

  it("a person's approval lifts it, and only while it matches the Journey", async () => {
    const j = fillNamed("token_count", false, "tty", "sf-person");
    expect((await call("run_journey", { id: "sf-person", params: { token_count: "3" } })).body["outcome"]).toBe("ok");
    // Edited after the person approved: a verify, which doesn't refuse a stale Journey, reads the same.
    j.metadata.name = "edited";
    writeFileSync(join(journeysDir, "sf-person.json"), JSON.stringify(j));
    expect((await call("verify_journey", { id: "sf-person", plan: true, params: { token_count: "3" } })).body).toMatchObject({ code: SECRET_PARAM_OVER_MCP });
  });

  it("the CLI redacts it the same way until a person approved", async () => {
    fillNamed("token_count", false, "mcp", "sf-cli");
    const r = await cli(["journey", "run", "sf-cli", "--param", "token_count=tok3val", "--json"]);
    expect(r.out).not.toContain("tok3val");
    expect(r.err).toContain("token_count");
  });

  it("per Journey: another Journey's declaration lifts nothing, in a chain and in a pair", async () => {
    fillNamed("password", undefined, undefined, "sf-nameonly");
    fillNamed("password", false, "tty", "sf-falsey");
    const requests = join(root, "requests.jsonl");
    for (const args of [{ from: "sf-nameonly", to: "sf-falsey" }, { from: "sf-falsey", to: "sf-nameonly" }]) {
      const r = await call("chain_journeys", { ...args, requests, params: { password: VALUE } });
      expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["password"] });
    }
    const pair = await call("journey_readiness", { id: "sf-nameonly", with: "sf-falsey", params: { password: VALUE } });
    expect(pair.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP });
    expect(pageLoads).toBe(0);
  });

  it("a source's Journey never lifts it: the name alone refuses", async () => {
    const r = await call("sources", { action: "run", name: "nosuch", journeyId: "x", params: { token_count: "3" } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP });
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

  it("targets.json on the CLI: the step fails, and the other origin receives nothing", async () => {
    const r = await cli(["journey", "run", "redirected", "--env", "local", "--json"]);
    expect(r.out).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.out).toContain(otherOrigin);
    expect(r.out).toContain("--secret-field and --allow"); // what to do, for a sign-in on another origin
    expect(r.out + r.err).not.toContain(VALUE);
    noLeak();
  });

  it("--secret-field on the CLI: the same", async () => {
    const r = await cli(["journey", "run", "redirected", "--secret-field", `label=Password=env:${VAR}`, "--json"]);
    expect(r.out).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.out + r.err).not.toContain(VALUE);
    noLeak();
  });

  it("the page's own origin still gets it", async () => {
    const r = await cli(["journey", "run", "login", "--env", "local", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, data: { outcome: "ok" } });
  });
});

// Real time: the page's own timer has to move it while the step waits for the field.
describe("[realtime] the page moves while the step waits (R1, R2)", { timeout: 120_000 }, () => {
  let other: Server;
  let leaks: string[] = [];
  let hits: string[] = [];
  const sec = (id: string, url: string, steps: unknown[]): void => {
    const j = journey(id);
    j.recording.pages[0]!.steps = [{ step: { kind: "navigate", url, expect: { kind: "visible", target: { css: "body" } } } }, ...steps] as never;
    approved(j);
    writeFileSync(join(journeysDir, `${id}.json`), JSON.stringify(j));
  };
  const fillStep = { step: { kind: "fill", target: { label: "Password" }, value: { var: "secret1" }, expect: { kind: "visible", target: { css: "body" } } } };

  beforeAll(async () => {
    other = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/leak")) leaks.push(req.url ?? "");
      if ((req.url ?? "").startsWith("/check")) hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<label>Password <input type=password autofocus oninput="fetch('/leak?v='+encodeURIComponent(this.value))"></label>` +
          `<div data-testid=ed contenteditable oninput="fetch('/leak?v='+encodeURIComponent(this.textContent))">x</div>` +
          `<label>Plan <select data-testid=plan onchange="fetch('/leak?v='+encodeURIComponent(this.value))"><option>none</option><option value="${VALUE}">p</option></select></label>`,
      );
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
    redirectTo = `${b}/`;
    leavesFor = b;
    sec("moves-disabled", "/moves-disabled", [fillStep]);
    sec("moves-hidden", "/moves-hidden", [fillStep]);
    // select binds nothing by itself: a fill on A binds the value, then the page leaves for B before the select.
    sec("moves-select", "/moves-select", [fillStep, { step: { kind: "select", target: { testId: "plan" }, value: { var: "secret1" }, expect: { kind: "visible", target: { css: "body" } } } }]);
    sec("edit-on-b", "/", [fillStep, { step: { kind: "navigate", url: "/go", expect: { kind: "visible", target: { testId: "ed" } } } }, { step: { kind: "editText", target: { testId: "ed" }, anchor: { at: "end" }, action: "insertAfter", value: { var: "secret1" }, expect: { kind: "visible", target: { testId: "ed" } } } }]);
    const editStep = (name: string, expect: unknown): unknown => ({ step: { kind: "editText", target: { testId: "ed" }, anchor: { at: "end" }, action: "insertAfter", value: { var: name }, expect } });
    const vis = { kind: "visible", target: { css: "body" } };
    sec("edit-keydown", "/edit-keydown", [fillStep, editStep("secret1", vis)]);
    sec("edit-select", "/edit-select", [fillStep, editStep("secret1", vis)]);
    const plain = journey("edit-plain", "who");
    plain.metadata.parameters = [{ name: "who" }];
    plain.recording.pages[0]!.steps = [{ step: { kind: "navigate", url: "/edit-plain", expect: vis } }, editStep("who", { kind: "textIncludes", target: { testId: "keys" }, text: "keys=3" })] as never;
    approved(plain);
    writeFileSync(join(journeysDir, "edit-plain.json"), JSON.stringify(plain));
    sec("bound-navigate", "/", [fillStep, { step: { kind: "navigate", url: `${b}/check?t=\${secret1}`, expect: vis } }]);
    const http = (id: string, name: string): void => {
      const j = journey(id, name);
      j.metadata.parameters = [{ name, secret: name === "secret1" ? true : undefined }] as never;
      j.metadata.endState = [{ kind: "http", method: "GET", url: `${b}/check?t=\${${name}}`, status: { class: 2 } }] as never;
      approved(j);
      writeFileSync(join(journeysDir, `${id}.json`), JSON.stringify(j));
    };
    http("bound-http", "secret1");
    http("bound-http-pwd", "pwd");
    writeFileSync(join(root, "environments.json"), JSON.stringify({ local: { baseUrl: origin }, sso: { baseUrl: origin, allow: [b] } }));
  });
  afterAll(() => {
    redirectTo = undefined;
    leavesFor = undefined;
    other.closeAllConnections();
    other.close();
    writeFileSync(join(root, "environments.json"), JSON.stringify({ local: { baseUrl: origin } }));
  });
  beforeEach(() => {
    leaks = [];
    hits = [];
  });

  it.each([
    ["fill, field disabled on A", "moves-disabled", "local"],
    ["fill, field hidden on A", "moves-hidden", "local"],
    ["select after a fill, page leaves for B first", "moves-select", "local"],
    ["editText after a 302, B off the allowlist", "edit-on-b", "local"],
    ["editText after a 302, B on the allowlist: the binding is still A's", "edit-on-b", "sso"],
  ])("%s: refused by name, nothing at B", async (_why, id, env) => {
    const r = await cli(["journey", "run", id, "--env", env, "--json"]);
    expect(r.out).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.out + r.err).not.toContain(VALUE);
    expect(leaks).toEqual([]);
  });

  it.each([["the first character", "edit-keydown"], ["placing the selection", "edit-select"]])("editText, the page moves on %s: none of it at B (D1)", async (_when, id) => {
    const r = await cli(["journey", "run", id, "--env", "local", "--json"]);
    expect(r.out + r.err).not.toContain(VALUE);
    expect(leaks).toEqual([]);
  });

  it.each(["keydown", "beforeinput", "textInput"])("a bound editText reaches an editor whose model reads %s, with real keys (E3)", async (event) => {
    sec(`edit-model-${event}`, `/edit-model-${event}`, [fillStep, { step: { kind: "editText", target: { testId: "ed" }, anchor: { at: "end" }, action: "insertAfter", value: { var: "secret1" }, expect: { kind: "textIncludes", target: { testId: "keys" }, text: `model=${VALUE.length}` } } }]);
    const r = await cli(["journey", "run", `edit-model-${event}`, "--env", "local", "--json"]);
    expect(JSON.parse(r.out), r.out).toMatchObject({ ok: true, data: { outcome: "ok" } });
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it("a plain value keeps typing key by key: key events still reach an editor", async () => {
    const r = await cli(["journey", "run", "edit-plain", "--param", "who=abc", "--json"]);
    expect(JSON.parse(r.out), r.out).toMatchObject({ ok: true, data: { outcome: "ok" } });
  });

  it.each([["navigate", "bound-navigate"], ["http check", "bound-http"], ["http check, a name only the broad list reads", "bound-http-pwd"]])("a %s holding a bound secret refuses before anything runs (D2, D3)", async (_w, id) => {
    const r = await cli(["journey", "run", id, "--env", "sso", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_SECRET_ORIGIN_REFUSED" } });
    expect(r.out + r.err).not.toContain(VALUE);
    expect(leaks).toEqual([]);
    expect(hits).toEqual([]);
  });
});

/** The real gateway with a recording model behind it: what a provider would receive. */
function gatewayRecording(sent: unknown[], answer: (task: string) => unknown): GenerationPort {
  return new OpenRouterGenerationGateway({
    store: envCredentialStore({ OPENROUTER_API_KEY: "sk-or-test" }, {}),
    catalog: [{ id: "m", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["US"], latencyClass: "fast", capabilities: [] }] as never,
      constraints: { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [] } as never,
    call: (async (args: { body: unknown; task?: string }) => {
      sent.push(args.body);
      return { object: answer(args.task ?? ""), latencyMs: 1 };
    }) as never,
  });
}

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

  it("targets.json with one binding on the CLI: refused by name, nothing typed", async () => {
    const r = await cli(["journey", "run", "two-on-one", "--env", "local", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.out).toContain("cannot say which value");
    expect(r.out).toContain("secret2");
    expect(pageLoads).toBe(0);
    expect(r.out + r.err).not.toContain(VALUE);
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

describe("nothing secret-bound goes to a model: self-heal", { timeout: 120_000 }, () => {
  useSkippingTime();
  const steps = (extra: unknown[] = []): never => [
    { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "pw" } } } },
    ...extra,
    { step: { kind: "click", target: { role: "button", name: "Nowhere" }, expect: { kind: "visible", target: { testId: "pw" } } } },
  ] as never;
  const fillSecret = { step: { kind: "fill", target: { label: "Password" }, value: { var: "secret1" }, expect: { kind: "visible", target: { testId: "pw" } } } };
  const extractKey = { step: { kind: "extract", target: { css: "#minted" }, as: "apiKey", attr: "data-v", expect: { kind: "visible", target: { testId: "pw" } } } };
  const fixtureOf = (outputs: Record<string, string>, secretOutputs: string[] = []) => (): never =>
    new MissionFixtures({ spec: { setup: [{ method: "POST", url: `${origin}/mint`, outputs, secretOutputs }] }, auth: {}, allowlist: [origin], baseUrl: origin } as never) as never;
  const heal = async (id: string, j: Journey, params: Record<string, string>, extra: Record<string, unknown> = {}): Promise<{ sent: unknown[]; text: string }> => {
    const { keepApproval, ...rest } = extra as { keepApproval?: boolean };
    extra = rest;
    if (keepApproval !== true) approved(j);
    writeFileSync(join(journeysDir, `${id}.json`), JSON.stringify(j));
    const sent: unknown[] = [];
    const gen = gatewayRecording(sent, () => ({ order: [], control: null }));
    const scope = await readJourneyChangeScope({ selfHeal: "hybrid", changeNotes: ["renamed Nowhere to Elsewhere"] } as never, journeysDir);
    const { marked = "", ...runExtra } = extra as { marked?: string };
    showsSecrets = `<button id=minted data-v="ExtractVal5Rt1">Minted</button>${marked}`;
    const result = await runJourneyProgrammatically({ dir: journeysDir, id, params, policy: { ...safeRunPolicy(), selfHeal: { mode: "hybrid" } } as never, selfHealer: makeEvidenceSelfHealer(gen), heal: { scope }, ...runExtra } as never).finally(() => {
      showsSecrets = "";
    });
    return { sent, text: JSON.stringify(result) };
  };
  const noSecretJourney = (id: string, extra: unknown[] = []): Journey => {
    const j = journey(id, "who");
    j.metadata.params = [];
    j.metadata.parameters = [];
    j.recording.pages[0]!.steps = steps(extra);
    return j;
  };

  it.each([
    ["a secret parameter", (id: string) => { const j = journey(id); j.recording.pages[0]!.steps = steps([fillSecret]); return j; }, { secret1: VALUE }, {}],
    ["an extracted credential", (id: string) => noSecretJourney(id, [extractKey]), {}, {}],
    ["a secretOutputs value", (id: string) => noSecretJourney(id), {}, { fixtures: fixtureOf({ minted: "$.sec" }, ["minted"]) }],
    ["a credential-named fixture output", (id: string) => noSecretJourney(id), {}, { fixtures: fixtureOf({ authToken: "$.tok" }) }],
  ])("holding %s: no model call, the step fails as without a heal, and says why", async (_what, make, params, extra) => {
    const id = `heal-off-${_what.replace(/\W+/g, "-")}`;
    const r = await heal(id, make(id), params as Record<string, string>, extra);
    expect(r.sent).toEqual([]);
    expect(r.text).toContain('"outcome":"quarantined"');
    expect(r.text).toContain("self-heal skipped");
    expect(r.text).not.toContain(VALUE);
  });

  // Decided from the Journey, before it runs: the break can come before the extract, with the value already on the page.
  it.each([
    ["the broken step is the extract itself", [{ step: { ...extractKey.step, target: { role: "button", name: "Nowhere" } } }], []],
    ["an earlier step breaks, the extract further on", [], [extractKey]],
    ["an earlier step breaks, the extract further on in a forEach", [], [{ step: { kind: "forEach", items: { css: "#minted" }, as: "row", steps: [{ ...extractKey.step, target: { css: "button" } }] } }]],
  ] as const)("a Journey that can extract a credential, %s: no model call, from step 1", async (what, before, after) => {
    const id = `heal-first-${what.replace(/\W+/g, "-")}`;
    const j = noSecretJourney(id, [...before]);
    j.recording.pages[0]!.steps = [...j.recording.pages[0]!.steps, ...after] as never;
    const r = await heal(id, j, {});
    expect(r.sent).toEqual([]);
    expect(r.text).toContain('"outcome":"quarantined"');
    expect(r.text).toContain("self-heal skipped");
    expect(r.text).toContain("extracted credential apiKey");
    expect(r.text).not.toContain("ExtractVal5Rt1");
  });

  it("a fixture's secret output, before anything is held from it: no model call, from step 1", async () => {
    const id = "heal-first-output";
    const r = await heal(id, noSecretJourney(id), {}, { fixtures: fixtureOf({ minted: "$.sec" }, ["minted"]) });
    expect(r.sent).toEqual([]);
    expect(r.text).toContain("self-heal skipped");
    expect(r.text).toContain("fixture secret minted");
  });

  it.each([
    ["a parameter", { passengers: "2" }, [{ step: { kind: "fill", target: { testId: "who" }, value: { var: "passengers" }, expect: { kind: "visible", target: { testId: "who" } } } }], "passengers"],
    ["an extract", {}, [{ step: { ...extractKey.step, as: "token_count" } }], "token_count"],
  ] as const)("a name that only looks like a credential, on %s: refused, naming the way out, and a person's secret: false heals", async (what, params, extra, name) => {
    const id = `heal-broad-${what.replace(/\W+/g, "-")}`;
    const make = (): Journey => {
      const j = noSecretJourney(id, [...extra]);
      j.metadata.params = [name];
      j.metadata.parameters = [{ name }];
      return j;
    };
    const refused = await heal(id, make(), params);
    expect(refused.sent).toEqual([]);
    expect(refused.text).toContain("self-heal skipped");
    expect(refused.text).toContain(name);
    expect(refused.text).toContain('\\"secret\\": false');
    expect(refused.text).toContain("jevitate journey promote");

    const lifted = (channel: string): Journey => {
      const j = make();
      j.metadata.parameters = [{ name, secret: false }];
      return approved(j, channel);
    };
    const byAgent = await heal(id, lifted("mcp"), params, { keepApproval: true });
    expect(byAgent.sent).toEqual([]);
    const byPerson = await heal(id, lifted("tty"), params, { keepApproval: true });
    expect(byPerson.sent.length).toBeGreaterThan(0);
    expect(byPerson.text).not.toContain("self-heal skipped");
  });

  it("a run holding none still heals: the model is asked", async () => {
    const r = await heal("heal-on", noSecretJourney("heal-on"), {});
    expect(r.sent.length).toBeGreaterThan(0);
    expect(r.text).not.toContain("self-heal skipped");
  });

  it("a non-secret param heals, and a value the app marks secret still isn't sent", async () => {
    const id = "heal-plain-param";
    const j = noSecretJourney(id, [{ step: { kind: "fill", target: { testId: "who" }, value: { var: "who" }, expect: { kind: "visible", target: { testId: "who" } } } }]);
    j.metadata.params = ["who"];
    j.metadata.parameters = [{ name: "who" }];
    const r = await heal(id, j, { who: "Ada-Plain" }, { marked: `<input type=password aria-label="Pin" value="MarkedPwVal9Kx2"><p data-jevitate-mask>MarkedTextVal7Qm</p>` });
    expect(r.sent.length).toBeGreaterThan(0);
    for (const v of ["MarkedPwVal9Kx2", "MarkedTextVal7Qm"]) expect(JSON.stringify(r.sent)).not.toContain(v);
  });
});

describe("nothing secret-bound goes to a model: annotate", { timeout: 120_000 }, () => {
  useSkippingTime();
  const annotate = async (j: Journey, params: Record<string, string>, extra: Record<string, unknown> = {}, channel?: string): Promise<{ sent: unknown[]; err: unknown; before: string; after: string; draft: string }> => {
    approved(j, channel);
    writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
    const file = join(journeysDir, `${j.metadata.id}.json`);
    const before = readFileSync(file, "utf8");
    const sent: unknown[] = [];
    const gen = gatewayRecording(sent, (task) => (task === "journey.goal" ? { goal: "g", successCriteria: [] } : { objective: "o", expectedResult: "e" }));
    const err = await annotateJourney({ dir: journeysDir, id: j.metadata.id, params, gen, now: () => "2026-11-06T00:00:00.000Z", ...extra } as never).then(() => undefined, (e: unknown) => e);
    return { sent, err, before, after: readFileSync(file, "utf8"), draft: annotationDraftPath(journeysDir, j.metadata.id) };
  };
  const plain = (id: string, extra: unknown[] = []): Journey => {
    const j = journey(id, "who");
    j.metadata.params = [];
    j.metadata.parameters = [];
    j.recording.pages[0]!.steps = [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "pw" } } } }, ...extra] as never;
    return j;
  };
  const fixtureOf = (outputs: Record<string, string>, secretOutputs: string[] = []) => (): never =>
    new MissionFixtures({ spec: { setup: [{ method: "POST", url: `${origin}/mint`, outputs, secretOutputs }] }, auth: {}, allowlist: [origin], baseUrl: origin } as never) as never;

  it.each([
    ["a secret parameter", () => journey("an-param"), { secret1: VALUE }, {}],
    ["an extracted credential", () => plain("an-extract", [{ step: { kind: "extract", target: { testId: "pw" }, as: "apiKey", attr: "id", expect: { kind: "visible", target: { testId: "pw" } } } }]), {}, {}],
    ["a credential extracted in a forEach", () => plain("an-foreach", [{ step: { kind: "forEach", items: { testId: "pw" }, as: "row", steps: [{ kind: "extract", target: { css: "input" }, as: "apiKey", attr: "id", expect: { kind: "visible", target: { css: "input" } } }] } }]), {}, {}],
    ["a secretOutputs value", () => plain("an-secret-output"), {}, { fixtures: fixtureOf({ minted: "$.sec" }, ["minted"]) }],
    ["a credential-named fixture output", () => plain("an-auth-output"), {}, { fixtures: fixtureOf({ authToken: "$.tok" }) }],
  ])("needing %s: refused by name, and no model call", async (_what, make, params, extra) => {
    const r = await annotate(make(), params as Record<string, string>, extra);
    expect(r.err).toBeInstanceOf(SecretBoundJourneyError);
    expect((r.err as SecretBoundJourneyError).code).toBe("E_MODEL_REFUSED_SECRET");
    expect(r.sent).toEqual([]);
    // The refusal leaves the Journey as it was, and no draft.
    expect(r.after).toBe(r.before);
    expect(existsSync(r.draft)).toBe(false);
  });

  it("a name that only looks like a credential: the refusal names the way out, and a person's secret: false annotates", async () => {
    const make = (): Journey => {
      const j = plain("an-broad", [{ step: { kind: "fill", target: { testId: "who" }, value: { var: "passengers" }, expect: { kind: "visible", target: { testId: "who" } } } }]);
      j.metadata.params = ["passengers"];
      j.metadata.parameters = [{ name: "passengers" }];
      return j;
    };
    const refused = await annotate(make(), { passengers: "2" });
    expect(refused.err).toBeInstanceOf(SecretBoundJourneyError);
    expect((refused.err as Error).message).toContain("secret parameter passengers");
    expect((refused.err as Error).message).toContain('"secret": false');
    expect((refused.err as Error).message).toContain("jevitate journey promote");
    expect(refused.sent).toEqual([]);
    const lifted = (): Journey => {
      const j = make();
      j.metadata.parameters = [{ name: "passengers", secret: false }];
      return j;
    };
    expect((await annotate(lifted(), { passengers: "2" }, {}, "mcp")).err).toBeInstanceOf(SecretBoundJourneyError);
    const byPerson = await annotate(lifted(), { passengers: "2" }, {}, "tty");
    expect(byPerson.err).toBeUndefined();
    expect(byPerson.sent.length).toBeGreaterThan(0);
  });

  it("annotate_journey says so over MCP, by name", async () => {
    const r = await call("annotate_journey", { id: "login", fakeAi: true });
    expect(r.body).toMatchObject({ code: "E_MODEL_REFUSED_SECRET" });
    expect(pageLoads).toBe(0);
  });

  it("create_demo's error mapping names it", () => {
    expect(refusalOf(new SecretBoundJourneyError("x", ["secret parameter y"]))).toMatchObject({ code: "E_MODEL_REFUSED_SECRET" });
  });

  it("a Journey needing none is still annotated", async () => {
    const r = await annotate(plain("an-plain"), {});
    expect(r.err).toBeUndefined();
    expect(r.sent.length).toBeGreaterThan(0);
  });

  it("a non-secret param is annotated, and a password field's value isn't sent", async () => {
    showsSecrets = `<input type=password aria-label="Pin" value="MarkedPwVal9Kx2">`;
    const j = plain("an-plain-param", [{ step: { kind: "fill", target: { testId: "who" }, value: { var: "who" }, expect: { kind: "visible", target: { testId: "who" } } } }]);
    j.metadata.params = ["who"];
    j.metadata.parameters = [{ name: "who" }];
    const r = await annotate(j, { who: "Ada-Plain" }).finally(() => {
      showsSecrets = "";
    });
    expect(r.err).toBeUndefined();
    // Succeeding, it leaves the Journey as it was: the draft is a sidecar, and neither holds a value.
    expect(r.after).toBe(r.before);
    expect(r.after).not.toContain("MarkedPwVal9Kx2");
    expect(r.after).not.toContain("Ada-Plain");
    expect(readFileSync(r.draft, "utf8")).not.toContain("MarkedPwVal9Kx2");
    expect(r.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.sent)).not.toContain("MarkedPwVal9Kx2");
  });
});

describe("explore --feature --secret: model-free, and masked where it writes", { timeout: 120_000 }, () => {
  it("still runs, and the value is in no transcript, result or stdout", async () => {
    showsSecrets = `<a href="/next?t=${VALUE}">Link ${VALUE}</a><button aria-label="Copy ${VALUE}">x</button>`;
    const out = join(root, "feature-out");
    const r = await cli(["explore", "--url", `${origin}/`, "--feature", "profile", "--route", "/**", "--allow", origin, "--out", out, "--max-actions", "4", "--secret", `env:${VAR}`, "--json"]).finally(() => {
      showsSecrets = "";
    });
    expect(JSON.parse(r.out)).toMatchObject({ ok: true });
    expect(r.out + r.err).not.toContain(VALUE);
    expect(allFiles(out).length).toBeGreaterThan(0);
    expect(allFiles(out).filter((f) => readFileSync(f).includes(VALUE)).map((f) => `${f.slice(out.length)}: ${readFileSync(f, "utf8").split(VALUE)[0]!.slice(-90)}`)).toEqual([]);
  });
});

describe("explore --secret on a strategy that can't keep it out (E4)", { timeout: 60_000 }, () => {
  it.each(["coverage", "exploratory"])("%s refuses before anything runs", async (strategy) => {
    const r = await cli(["explore", "--url", `${origin}/`, "--strategy", strategy, "--secret", `env:${VAR}`, "--allow", origin, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_EXPLORE_SECRET_UNSUPPORTED" } });
    expect(pageLoads).toBe(0);
    expect(r.out + r.err).not.toContain(VALUE);
  });
});

describe("masked text never goes into a field (D5)", { timeout: 120_000 }, () => {
  useSkippingTime();
  const CONTRACT = "chk-handoff@1";
  const chainJourneys = (field: string, value: string): void => {
    const producer = {
      metadata: { id: "chain-from", name: "chain-from", params: [], promoted: true, createdAtIso: "2026-10-22T17:00:00Z", outputs: { contract: CONTRACT, key: ["recordId"], fields: { recordId: { type: "id" }, [field]: { type: "text" } } } },
      recording: { version: "1.0.0", site: origin, pages: [{ url: "/", steps: [
        { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "record" } } }, stepId: "p1" },
        { step: { kind: "extract", target: { testId: "record" }, as: "recordId", attr: "data-recordid", expect: { kind: "attr", target: { testId: "record" }, name: "data-recordid" } }, stepId: "p2" },
        { step: { kind: "extract", target: { testId: "record" }, as: field, attr: "data-field", expect: { kind: "attr", target: { testId: "record" }, name: "data-field" } }, stepId: "p3" },
      ] }] },
    } as unknown as Journey;
    const consumer = {
      metadata: { id: "chain-to", name: "chain-to", params: ["recordId", "reply"], promoted: true, createdAtIso: "2026-10-22T17:00:00Z",
        inputs: { accepts: CONTRACT, request: { key: ["recordId"], fields: { recordId: { type: "id" } } }, bindings: { recordId: { record: "recordId" }, reply: { record: field } } },
        boundary: { kind: "prepare-only", stopBefore: { target: { testId: "record" }, label: "rec" }, blockWrites: true, nextStep: "Review." } },
      recording: { version: "1.0.0", site: origin, pages: [{ url: "/", steps: [
        { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "record" } } }, stepId: "c1" },
        { step: { kind: "assert", check: { kind: "attr", target: { testId: "record" }, name: "data-recordid", value: { var: "recordId" } } }, stepId: "c0" },
        { step: { kind: "fill", target: { testId: "who" }, value: { var: "reply" }, expect: { kind: "visible", target: { testId: "who" } } }, stepId: "c3" },
      ] }] },
    } as unknown as Journey;
    showsSecrets = `<div data-testid=record data-recordid="r1" data-field="${value}">rec</div>`;
    for (const j of [approved(producer), approved(consumer)]) writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
    writeFileSync(join(root, "chain-requests.jsonl"), `${JSON.stringify({ recordId: "r1" })}\n`);
  };
  afterAll(() => {
    showsSecrets = "";
  });

  it("issueKey: the consumer's field gets the value as extracted, as in 0.28", async () => {
    typedWho.length = 0;
    chainJourneys("issueKey", "ISS-7");
    const r = await cli(["journey", "chain", "--from", "chain-from", "--to", "chain-to", "--requests", join(root, "chain-requests.jsonl"), "--json"]);
    expect(r.exitCode, r.out).toBe(0);
    expect(typedWho).toEqual(["ISS-7"]);
  });

  it("apiKey: masked text would be typed, so the consumer's run fails instead of reporting ok", async () => {
    typedWho.length = 0;
    chainJourneys("apiKey", "real-key-value-99");
    const r = await cli(["journey", "chain", "--from", "chain-from", "--to", "chain-to", "--requests", join(root, "chain-requests.jsonl"), "--json"]);
    expect(r.exitCode, r.out).not.toBe(0);
    expect(typedWho).toEqual([]);
    expect(r.out).not.toContain("real-key-value-99");
  });

  it("apiKey in a consumer's navigate URL: fails, no /item/«redacted» with exit 0 (E5)", async () => {
    chainJourneys("apiKey", "real-key-value-99");
    const consumer = JSON.parse(readFileSync(join(journeysDir, "chain-to.json"), "utf8")) as Journey;
    consumer.recording.pages[0]!.steps.push({ step: { kind: "navigate", url: "/item/${reply}", expect: { kind: "visible", target: { css: "body" } } }, stepId: "c4" } as never);
    consumer.recording.pages[0]!.steps.splice(2, 1);
    approved(consumer);
    writeFileSync(join(journeysDir, "chain-to.json"), JSON.stringify(consumer));
    const r = await cli(["journey", "chain", "--from", "chain-from", "--to", "chain-to", "--requests", join(root, "chain-requests.jsonl"), "--json"]);
    expect(r.exitCode, r.out).not.toBe(0);
    expect(r.out).not.toContain("real-key-value-99");
  });

  it("a stale secret: false lifts no redaction on the CLI (D6)", async () => {
    const j = fillNamed("password", false, "tty", "stale-false");
    j.metadata.name = "edited after the person approved";
    writeFileSync(join(journeysDir, "stale-false.json"), JSON.stringify(j));
    const r = await cli(["journey", "run", "stale-false", "--param", `password=${VALUE}`, "--json"]);
    expect(r.out).not.toContain(VALUE);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, data: { output: { password: "«redacted»" } } });
  });
});
