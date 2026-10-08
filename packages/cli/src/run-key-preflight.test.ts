import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { MissingCredentialError, type VerifyFetch } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import { buildProgram, type CliDeps } from "./program.js";
import { buildExploreGateways, buildGenerationGateway } from "./cli-shared.js";
import { InvalidCredentialError, NO_KEY_VERIFY_ENV, resetKeyPreflightCache } from "./run-key-preflight.js";

/**
 * #291 (runs): a run that needs live AI keys verifies them once at startup and refuses a key the
 * provider rejects as a typed setup refusal (E_AI_SETUP_REQUIRED, exit 64) — never a run that ends
 * `inconclusive` on "model decision unavailable". The verifier is a deterministic fake: no network.
 */

const OPENROUTER = "sk-or-v1-generation-key-value";
// The #291 incident: the OpenRouter key stored in the TypeSafe slot.
const MISPLACED = "sk-or-v1-misplaced-in-typesafe-slot";

let dir: string;
let calls: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-key-preflight-"));
  calls = [];
  resetKeyPreflightCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** OpenRouter accepts the generation key; TypeSafe rejects anything but "ts-good". */
const verifyFetch: VerifyFetch = async (url, init) => {
  calls.push(url);
  const key = init.headers.Authorization?.replace(/^Bearer /, "");
  if (url.includes("openrouter")) return { status: key === OPENROUTER ? 200 : 401 };
  return { status: key === "ts-good" ? 200 : 401 };
};

const refusingPort: BrowserPort = {
  async open() {
    throw new Error("open intercepted by test");
  },
};

function deps(env: Record<string, string | undefined>, fetchFn: VerifyFetch = verifyFetch): CliDeps {
  return {
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: { env, localConfig: {}, verifyFetch: fetchFn, browserPortFactory: () => refusingPort },
  };
}

async function run(d: CliDeps, argv: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram(d);
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  const override = (c: typeof program): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  let code: number | undefined;
  try {
    await program.parseAsync(argv, { from: "user" });
    code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  } finally {
    process.stdout.write = write;
  }
  return { code, out: stdout.join(""), err: stderr.join("") };
}

describe("judgment on the OpenRouter key (#429)", () => {
  it("--real builds with only an OpenRouter key: one key, verified once, no TypeSafe check", async () => {
    const built = await buildExploreGateways(deps({ OPENROUTER_API_KEY: OPENROUTER }), { real: true, fakeAi: false });
    expect(built.judge).toBeDefined();
    expect(calls).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  it("--jev-provider openrouter skips a (rejected) TypeSafe key and runs judgment on the OpenRouter key", async () => {
    const built = await buildExploreGateways(deps({ OPENROUTER_API_KEY: OPENROUTER, TYPESAFE_API_KEY: "ts-bad" }), { real: true, fakeAi: false, jevProvider: "openrouter" });
    expect(built.judge).toBeDefined();
    expect(calls.some((u) => u.includes("typesafe"))).toBe(false);
  });

  it("JEVITATE_JEV_PROVIDER=typesafe with no TypeSafe key refuses (no quiet switch to OpenRouter)", async () => {
    const err = await buildExploreGateways(deps({ OPENROUTER_API_KEY: OPENROUTER, JEVITATE_JEV_PROVIDER: "typesafe" }), { real: true, fakeAi: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingCredentialError);
    expect((err as MissingCredentialError).missing).toEqual(["TYPESAFE_API_KEY"]);
  });

  it("an unknown provider is a gateway-selection refusal", async () => {
    const err = await buildExploreGateways(deps({ OPENROUTER_API_KEY: OPENROUTER }), { real: true, fakeAi: false, jevProvider: "nope" }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/not a Jev provider/);
  });
});

describe("run startup key check (#291)", () => {
  it("explore --real with a rejected (misplaced) judgment key exits 64 E_AI_SETUP_REQUIRED, naming the key — never its value", async () => {
    const r = await run(deps({ OPENROUTER_API_KEY: OPENROUTER, TYPESAFE_API_KEY: MISPLACED }), [
      "explore",
      "--url",
      "http://127.0.0.1:9/",
      "--goal",
      "g",
      "--success",
      "urlIncludes:/x",
      "--real",
      "--json",
    ]);
    const env = JSON.parse(r.out) as { ok: boolean; error?: { code: string; message: string } };
    expect(env).toMatchObject({ ok: false, error: { code: "E_AI_SETUP_REQUIRED" } });
    expect(env.error?.message).toMatch(/TYPESAFE_API_KEY \(TypeSafe\/Jev\) was rejected by the provider \(HTTP 401\)/);
    expect(env.error?.message).toMatch(/looks like an OpenRouter key \(OPENROUTER_API_KEY\)/);
    expect(env.error?.message).toMatch(new RegExp(NO_KEY_VERIFY_ENV));
    expect(`${r.out}${r.err}`).not.toContain(MISPLACED);
    expect(`${r.out}${r.err}`).not.toContain(OPENROUTER);
    expect(r.code).toBe(64);
  });

  it("verifies each key once per process (cached), refusing with a typed MissingCredentialError subclass", async () => {
    const d = deps({ OPENROUTER_API_KEY: OPENROUTER, TYPESAFE_API_KEY: "ts-bad" });
    const first = await buildExploreGateways(d, { real: true, fakeAi: false }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(InvalidCredentialError);
    expect(first).toBeInstanceOf(MissingCredentialError);
    expect((first as InvalidCredentialError).missing).toEqual(["TYPESAFE_API_KEY"]);
    await buildExploreGateways(d, { real: true, fakeAi: false }).catch(() => undefined);
    expect(calls).toHaveLength(2); // one per key, not per build
  });

  it("valid keys build the live gateways; unreachable providers do not block (and are re-checked later)", async () => {
    const ok = deps({ OPENROUTER_API_KEY: OPENROUTER, TYPESAFE_API_KEY: "ts-good" });
    await expect(buildExploreGateways(ok, { real: true, fakeAi: false })).resolves.toHaveProperty("judge");
    let n = 0;
    const offline: VerifyFetch = async () => {
      n += 1;
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const d = deps({ OPENROUTER_API_KEY: "sk-or-other", TYPESAFE_API_KEY: "ts-other" }, offline);
    await expect(buildExploreGateways(d, { real: true, fakeAi: false })).resolves.toHaveProperty("gen");
    await buildExploreGateways(d, { real: true, fakeAi: false });
    expect(n).toBe(4);
  });

  it(`${NO_KEY_VERIFY_ENV}=1 skips the check (offline CI); --fake-ai never reaches the network`, async () => {
    await expect(
      buildExploreGateways(deps({ OPENROUTER_API_KEY: OPENROUTER, TYPESAFE_API_KEY: "ts-bad", [NO_KEY_VERIFY_ENV]: "1" }), { real: true, fakeAi: false }),
    ).resolves.toHaveProperty("judge");
    await buildExploreGateways(deps({}), { real: false, fakeAi: true });
    await buildGenerationGateway(deps({}), { real: false, fakeAi: true });
    expect(calls).toEqual([]);
  });

  it("the generation-only gateway (journey annotate) checks only the generation key", async () => {
    const e = await buildGenerationGateway(deps({ OPENROUTER_API_KEY: "sk-or-wrong" }), { real: true, fakeAi: false }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidCredentialError);
    expect(calls.every((u) => u.includes("openrouter"))).toBe(true);
  });
});
