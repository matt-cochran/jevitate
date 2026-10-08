import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { looksLikeOtherKey, verifyKey, type CredentialKey, type VerifyFetch } from "@jevitate/ai-core";
import { buildProgram, type CliDeps } from "./program.js";

/**
 * #268 (name each key and its source; replace a stored key), #269 (masked entry that keeps the
 * instructions on screen) and #291 (a live auth check, typed verdicts, --no-verify). Every test
 * asserts that no key VALUE reaches stdout, stderr or the --json envelope.
 */

const OR_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const TS_KEY = "ts_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const NEW_KEY = "sk-or-v1-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW12";
const VALUES = [OR_KEY, TS_KEY, NEW_KEY];

/** A verifier stub: per key VALUE, the HTTP status the provider answers (or a thrown network error). */
function stubFetch(answers: Record<string, number | Error>): { fetch: VerifyFetch; calls: Array<{ url: string; auth: string }> } {
  const calls: Array<{ url: string; auth: string }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      const auth = init.headers.Authorization ?? "";
      calls.push({ url, auth });
      const value = auth.replace(/^Bearer /, "");
      const a = answers[value] ?? 200;
      if (a instanceof Error) throw a;
      return { status: a };
    },
  };
}

function run(ai: NonNullable<CliDeps["ai"]>, init?: CliDeps["init"]) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused-in-key-tests"), ai: { localConfig: {}, ...ai }, ...(init === undefined ? {} : { init }) });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    err.push(String(s));
    return true;
  });
  return {
    program,
    out,
    err,
    async parse(argv: string[]) {
      try {
        await program.parseAsync(argv, { from: "user" });
      } finally {
        stderr.mockRestore();
      }
      return { out: out.join(""), err: err.join("") };
    },
  };
}

function expectNoValue(text: string): void {
  for (const v of VALUES) expect(text).not.toContain(v);
}

afterEach(() => {
  process.exitCode = 0;
});

describe("ai status — names, sources and live verification (#268, #291)", () => {
  it("names each key, its provider and its source: env vs ~/.jevitate/credentials.json; an env var shadowing a stored key is reported", async () => {
    const { fetch } = stubFetch({});
    const r = run({ env: { OPENROUTER_API_KEY: OR_KEY }, localConfig: { OPENROUTER_API_KEY: "sk-or-stored-older", TYPESAFE_API_KEY: TS_KEY }, verifyFetch: fetch });
    const { out, err } = await r.parse(["ai", "status"]);
    expect(out).toContain("generation: ready — OPENROUTER_API_KEY (OpenRouter), from env OPENROUTER_API_KEY (overrides the key stored in");
    expect(out).toMatch(/judgment: ready via TypeSafe \(model jev-latest; the TypeSafe key is preferred\) — TYPESAFE_API_KEY \(TypeSafe\/Jev\), from .*credentials\.json: valid/);
    expectNoValue(out + err);
    expect(out + err).not.toContain("sk-or-stored-older");
    expect(process.exitCode).toBe(0);

    const j = run({ env: { TYPESAFE_JEV_API_KEY: TS_KEY }, localConfig: { OPENROUTER_API_KEY: OR_KEY }, verifyFetch: fetch });
    const json = JSON.parse((await j.parse(["ai", "status", "--json"])).out);
    expect(json.data.generation.sources).toEqual([expect.objectContaining({ key: "OPENROUTER_API_KEY", provider: "OpenRouter", source: "file" })]);
    expect(json.data.judgment.sources).toEqual([{ key: "TYPESAFE_API_KEY", provider: "TypeSafe/Jev", source: "env", envVar: "TYPESAFE_JEV_API_KEY" }]);
    expect(json.data.judgment.verification).toEqual([{ key: "TYPESAFE_API_KEY", provider: "TypeSafe/Jev", status: "valid" }]);
    expectNoValue(JSON.stringify(json));
  });

  it("a swapped / wrong key is INVALID (HTTP 401), flagged as another provider's key, exit 2 — never 'ready'", async () => {
    // The #291 incident: the two keys swapped. TypeSafe rejects the OpenRouter key and vice versa.
    const { fetch, calls } = stubFetch({ [OR_KEY]: 401, [TS_KEY]: 401 });
    const r = run({ env: {}, localConfig: { OPENROUTER_API_KEY: TS_KEY, TYPESAFE_API_KEY: OR_KEY }, verifyFetch: fetch });
    const { out, err } = await r.parse(["ai", "status", "--json"]);
    const json = JSON.parse(out);
    expect(json.data.judgment.verification[0]).toMatchObject({ status: "invalid", httpStatus: 401, looksLike: "OPENROUTER_API_KEY" });
    expect(json.data.generation.verification[0]).toMatchObject({ status: "invalid", httpStatus: 401 });
    expect(process.exitCode).toBe(2);
    expectNoValue(out + err);
    // One authenticated GET per key, the key only in the Authorization header.
    expect(calls.map((c) => c.url).sort()).toEqual(["https://api.typesafe.ai/v1/models", "https://openrouter.ai/api/v1/key"]);
    for (const c of calls) expect(c.url).not.toMatch(/sk-|ts_/);

    const human = run({ env: {}, localConfig: { TYPESAFE_API_KEY: OR_KEY, OPENROUTER_API_KEY: OR_KEY }, verifyFetch: stubFetch({ [OR_KEY]: 401 }).fetch });
    const h = await human.parse(["ai", "status"]);
    expect(h.out).toContain("judgment: NOT ready via TypeSafe (model jev-latest; the TypeSafe key is preferred) — TYPESAFE_API_KEY (TypeSafe/Jev)");
    expect(h.out).toContain("INVALID (HTTP 401) — looks like an OpenRouter key (OPENROUTER_API_KEY)");
    expect(h.out).toContain("`jevitate ai setup judgment --replace`");
    expectNoValue(h.out + h.err);
  });

  it("an unreachable provider is reported as such (exit 2, never valid); --no-verify makes no request (offline / CI)", async () => {
    const down = stubFetch({ [OR_KEY]: new Error(`getaddrinfo ENOTFOUND openrouter.ai (key ${OR_KEY})`), [TS_KEY]: 503 });
    const r = run({ env: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: TS_KEY }, verifyFetch: down.fetch });
    const { out, err } = await r.parse(["ai", "status", "--json"]);
    const json = JSON.parse(out);
    expect(json.data.generation.verification[0]).toMatchObject({ status: "unreachable" });
    expect(json.data.judgment.verification[0]).toMatchObject({ status: "unreachable", reason: "unexpected HTTP 503" });
    expect(process.exitCode).toBe(2);
    expectNoValue(out + err); // the network error echoed the key: scrubbed

    const offline = stubFetch({});
    const o = run({ env: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: TS_KEY }, verifyFetch: offline.fetch });
    const oj = JSON.parse((await o.parse(["ai", "status", "--no-verify", "--json"])).out);
    expect(offline.calls).toHaveLength(0);
    expect(oj.data.generation.verification).toBeUndefined();
    expect(oj.data.generation.sources[0]).toMatchObject({ source: "env" });
    expect(process.exitCode).toBe(0);
  });
});

describe("ai setup — replace, verify before storing (#268, #291)", () => {
  function io(values: string[]) {
    const persisted: Array<{ key: CredentialKey; value: string }> = [];
    const prompts: string[] = [];
    return {
      persisted,
      prompts,
      secureIO: {
        promptSecret: async (message: string) => {
          prompts.push(message);
          return values.shift() ?? "";
        },
        persist: async (key: CredentialKey, value: string) => {
          persisted.push({ key, value });
        },
      },
    };
  }

  it("--replace prompts for and overwrites a stored key; without it, nothing is prompted", async () => {
    const plain = io([]);
    const p = run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY }, secureIO: plain.secureIO, verifyFetch: stubFetch({}).fetch });
    const pj = JSON.parse((await p.parse(["ai", "setup", "generation", "--json"])).out);
    expect(pj.data.collected).toEqual([]);
    expect(plain.prompts).toHaveLength(0);
    expect(pj.data.verification).toEqual([{ key: "OPENROUTER_API_KEY", provider: "OpenRouter", status: "valid" }]);

    const rep = io([NEW_KEY]);
    const r = run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY }, secureIO: rep.secureIO, verifyFetch: stubFetch({}).fetch });
    const { out, err } = await r.parse(["ai", "setup", "generation", "--replace", "--json"]);
    const json = JSON.parse(out);
    expect(json.ok).toBe(true);
    expect(rep.prompts[0]).toMatch(/new value for OPENROUTER_API_KEY .*masked/);
    expect(rep.persisted).toEqual([{ key: "OPENROUTER_API_KEY", value: NEW_KEY }]);
    expect(json.data.collected).toEqual(["OPENROUTER_API_KEY"]);
    expectNoValue(out + err);
  });

  it("warns when an env var shadows the key just stored (the env value wins)", async () => {
    const rep = io([NEW_KEY]);
    const r = run({ env: { OPENROUTER_API_KEY: OR_KEY }, localConfig: {}, secureIO: rep.secureIO, verifyFetch: stubFetch({}).fetch });
    const { out, err } = await r.parse(["ai", "setup", "generation", "--replace"]);
    expect(out).toContain("warning: env OPENROUTER_API_KEY is set and overrides the OPENROUTER_API_KEY just stored");
    expect(rep.persisted).toHaveLength(1);
    expectNoValue(out + err);
  });

  it("an entered key the provider rejects is NOT stored (E_AI_KEY_INVALID); an unreachable check is not stored either unless --no-verify", async () => {
    const bad = io([NEW_KEY]);
    const r = run({ env: {}, secureIO: bad.secureIO, verifyFetch: stubFetch({ [NEW_KEY]: 401 }).fetch });
    const { out, err } = await r.parse(["ai", "setup", "generation", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "E_AI_KEY_INVALID" } });
    expect(JSON.parse(out).error.message).toMatch(/rejected by OpenRouter \(HTTP 401\) — not stored/);
    expect(bad.persisted).toHaveLength(0);
    expectNoValue(out + err);

    const offline = io([NEW_KEY]);
    const o = run({ env: {}, secureIO: offline.secureIO, verifyFetch: stubFetch({ [NEW_KEY]: new Error("ECONNREFUSED") }).fetch });
    const oj = JSON.parse((await o.parse(["ai", "setup", "generation", "--json"])).out);
    expect(oj).toMatchObject({ ok: false, error: { code: "E_AI_KEY_UNVERIFIED" } });
    expect(oj.error.message).toContain("--no-verify");
    expect(offline.persisted).toHaveLength(0);

    const unverified = io([NEW_KEY]);
    const calls = stubFetch({});
    const u = run({ env: {}, secureIO: unverified.secureIO, verifyFetch: calls.fetch });
    const uj = JSON.parse((await u.parse(["ai", "setup", "generation", "--no-verify", "--json"])).out);
    expect(uj.ok).toBe(true);
    expect(unverified.persisted).toEqual([{ key: "OPENROUTER_API_KEY", value: NEW_KEY }]);
    expect(calls.calls).toHaveLength(0);
  });

  it("a key already present but invalid fails setup (\"nothing missing\" is not success) and points at --replace", async () => {
    const none = io([]);
    const r = run({ env: {}, localConfig: { TYPESAFE_API_KEY: OR_KEY }, secureIO: none.secureIO, verifyFetch: stubFetch({ [OR_KEY]: 401 }).fetch });
    const { out, err } = await r.parse(["ai", "setup", "judgment", "--json"]);
    const json = JSON.parse(out);
    expect(json).toMatchObject({ ok: false, error: { code: "E_AI_KEY_INVALID" } });
    expect(json.error.message).toContain("--replace");
    expect(json.error.message).toContain("looks like an OpenRouter key");
    expectNoValue(out + err);
  });

  it("the real prompt refuses a non-interactive stdin instead of hanging", async () => {
    const r = run({ env: {}, isInteractive: () => false, verifyFetch: stubFetch({}).fetch });
    const json = JSON.parse((await r.parse(["ai", "setup", "generation", "--json"])).out);
    expect(json).toMatchObject({ ok: false, error: { code: "E_AI_SETUP" } });
    expect(json.error.message).toMatch(/interactive terminal/);
  });
});

describe("judgment on either key: TypeSafe or OpenRouter (#429)", () => {
  it("status: an OpenRouter key alone makes judgment ready via OpenRouter, naming the route and model", async () => {
    const r = run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY }, verifyFetch: stubFetch({}).fetch });
    const { out, err } = await r.parse(["ai", "status"]);
    expect(out).toContain("judgment: ready via OpenRouter (model ~typesafe/jev-latest; no TypeSafe key set) — OPENROUTER_API_KEY (OpenRouter)");
    expect(process.exitCode).toBe(0);
    expectNoValue(out + err);
    const j = JSON.parse((await run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY }, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--json"])).out);
    expect(j.data.judgment).toMatchObject({
      required: ["OPENROUTER_API_KEY"],
      missing: [],
      route: { provider: "openrouter", key: "OPENROUTER_API_KEY", model: "~typesafe/jev-latest", reason: "precedence" },
    });
  });

  it("status: with both keys the TypeSafe key wins", async () => {
    const j = JSON.parse((await run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: TS_KEY }, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--json"])).out);
    expect(j.data.judgment.route).toEqual({ provider: "typesafe", key: "TYPESAFE_API_KEY", model: "jev-latest", reason: "precedence" });
  });

  it("status: --jev-provider openrouter overrides the TypeSafe key", async () => {
    const j = JSON.parse(
      (await run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: TS_KEY }, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--jev-provider", "openrouter", "--json"])).out,
    );
    expect(j.data.judgment.route).toMatchObject({ provider: "openrouter", reason: "override" });
  });

  it("status: JEVITATE_JEV_PROVIDER=openrouter overrides the TypeSafe key", async () => {
    const j = JSON.parse(
      (await run({ env: { JEVITATE_JEV_PROVIDER: "openrouter" }, localConfig: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: TS_KEY }, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--json"])).out,
    );
    expect(j.data.judgment.route).toMatchObject({ provider: "openrouter", reason: "override" });
  });

  it("status: --jev-provider typesafe without a TypeSafe key is missing — never a quiet switch to OpenRouter", async () => {
    const j = JSON.parse((await run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY }, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--jev-provider", "typesafe", "--json"])).out);
    expect(j.data.judgment).toMatchObject({ required: ["TYPESAFE_API_KEY"], missing: ["TYPESAFE_API_KEY"], route: null });
  });

  it("status: with no key at all, the missing line names both keys", async () => {
    const { out } = await run({ env: {}, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--no-verify"]);
    expect(out).toContain("judgment: missing TYPESAFE_API_KEY (TypeSafe/Jev) or OPENROUTER_API_KEY (OpenRouter)");
    expect(out).toContain("ai setup judgment --jev-provider openrouter");
  });

  it("status: an unknown JEVITATE_JEV_PROVIDER is refused, not ignored", async () => {
    const { out } = await run({ env: { JEVITATE_JEV_PROVIDER: "anthropic" }, verifyFetch: stubFetch({}).fetch }).parse(["ai", "status", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "E_INVALID_ARGS" } });
  });

  it("setup judgment --jev-provider openrouter asks for the OpenRouter key and reports the OpenRouter route", async () => {
    const prompts: string[] = [];
    const persisted: Array<{ key: CredentialKey; value: string }> = [];
    const secureIO = {
      promptSecret: async (m: string) => (prompts.push(m), NEW_KEY),
      persist: async (key: CredentialKey, value: string) => void persisted.push({ key, value }),
    };
    const r = run({ env: {}, secureIO, verifyFetch: stubFetch({}).fetch });
    const { out, err } = await r.parse(["ai", "setup", "judgment", "--jev-provider", "openrouter", "--json"]);
    const json = JSON.parse(out);
    expect(json.ok).toBe(true);
    expect(prompts[0]).toMatch(/^Enter OPENROUTER_API_KEY /);
    expect(persisted.map((p) => p.key)).toEqual(["OPENROUTER_API_KEY"]);
    expect(json.data.route).toMatchObject({ provider: "openrouter", key: "OPENROUTER_API_KEY", reason: "override" });
    expectNoValue(out + err);
  });

  it("setup judgment with only an OpenRouter key asks nothing and offers the TypeSafe key", async () => {
    const promptSecret = vi.fn(async () => "never");
    const r = run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY }, secureIO: { promptSecret, persist: async () => {} }, verifyFetch: stubFetch({}).fetch });
    const { out } = await r.parse(["ai", "setup", "judgment"]);
    expect(promptSecret).not.toHaveBeenCalled();
    expect(out).toContain("judgment: ready via OpenRouter");
    expect(out).toContain("`jevitate ai setup judgment --jev-provider typesafe`");
  });
});

describe("init — key names, sources, --replace-keys (#268)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function initDeps(interactive: boolean): CliDeps["init"] {
    const home = mkdtempSync(join(tmpdir(), "keys-init-home-"));
    dirs.push(home);
    return { detection: { existsSync: () => false, homedir: () => home, cwd: () => home }, statePath: join(home, "state.json"), isInteractive: () => interactive };
  }
  const INIT = ["init", "--skip-skills", "--skip-mcp", "--skip-project"];

  it("names each key, provider and source instead of 'already configured'", async () => {
    const r = run({ env: { OPENROUTER_API_KEY: OR_KEY }, localConfig: { TYPESAFE_API_KEY: TS_KEY }, verifyFetch: stubFetch({}).fetch }, initDeps(true));
    const { out, err } = await r.parse(INIT);
    expect(out).toContain("keys: generation ready — OPENROUTER_API_KEY (OpenRouter), from env OPENROUTER_API_KEY: valid");
    expect(out).toMatch(/keys: judgment ready — TYPESAFE_API_KEY \(TypeSafe\/Jev\), from .*credentials\.json: valid/);
    expectNoValue(out + err);
  });

  it("--replace-keys prompts for every key and stores each new value; refused without a TTY", async () => {
    const persisted: Array<{ key: string; value: string }> = [];
    const values = [NEW_KEY, TS_KEY];
    const secureIO = { promptSecret: async () => values.shift() ?? "", persist: async (key: string, value: string) => void persisted.push({ key, value }) };
    const r = run({ env: {}, localConfig: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: OR_KEY }, secureIO, verifyFetch: stubFetch({}).fetch }, initDeps(true));
    const { out, err } = await r.parse([...INIT, "--replace-keys", "--json"]);
    const json = JSON.parse(out);
    expect(persisted.map((p) => p.key)).toEqual(["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]);
    expect(json.data.keys.generation).toMatchObject({ collected: ["OPENROUTER_API_KEY"], verification: [{ status: "valid" }] });
    expectNoValue(out + err);

    const n = run({ env: {}, verifyFetch: stubFetch({}).fetch }, initDeps(false));
    const nj = JSON.parse((await n.parse([...INIT, "--replace-keys", "--json"])).out);
    expect(nj).toMatchObject({ ok: false, error: { code: "E_INIT" } });
    expect(nj.error.message).toMatch(/interactive terminal/);
  });
});

describe("verifyKey / looksLikeOtherKey (#291)", () => {
  it("maps statuses to typed verdicts and never puts the key in a reason", async () => {
    const f = (status: number | Error): VerifyFetch => async () => {
      if (status instanceof Error) throw status;
      return { status };
    };
    await expect(verifyKey("OPENROUTER_API_KEY", OR_KEY, f(200))).resolves.toEqual({ status: "valid" });
    await expect(verifyKey("OPENROUTER_API_KEY", OR_KEY, f(403))).resolves.toEqual({ status: "invalid", httpStatus: 403 });
    await expect(verifyKey("OPENROUTER_API_KEY", OR_KEY, f(429))).resolves.toEqual({ status: "unreachable", reason: "rate limited (HTTP 429)" });
    const net = await verifyKey("OPENROUTER_API_KEY", OR_KEY, f(new Error(`boom ${OR_KEY}`)));
    expect(net.status).toBe("unreachable");
    expect(JSON.stringify(net)).not.toContain(OR_KEY);
    const slow: VerifyFetch = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(verifyKey("TYPESAFE_API_KEY", TS_KEY, slow, 20)).resolves.toEqual({ status: "unreachable", reason: "no answer within 20ms" });
    expect(looksLikeOtherKey("TYPESAFE_API_KEY", OR_KEY)).toBe("OPENROUTER_API_KEY");
    expect(looksLikeOtherKey("OPENROUTER_API_KEY", OR_KEY)).toBeNull();
  });
});
