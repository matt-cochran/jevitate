import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserPort, type OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { SecretArgError, resolveSecretArgs } from "./secret-args.js";

/**
 * #195 part 4 — `--secret env:VAR`: the value is read from the environment (never the process list
 * or shell history), matching `--secret-field`'s `env:` binding. An unset/empty variable is a clear
 * refusal — never an empty secret, never the literal text "env:VAR". The resolved value is
 * registered for redaction exactly like a literal `--secret`.
 */

const CANARY = "env-secret-canary-9c41d";
const VAR = "JEV_TEST_SECRET_195";

afterEach(() => {
  delete process.env[VAR];
});

describe("resolveSecretArgs (#195)", () => {
  it("resolves env:VAR from the given environment and passes literals through", () => {
    expect(resolveSecretArgs([`env:${VAR}`, "literal-x"], { [VAR]: CANARY }, "--secret")).toEqual({ secrets: [CANARY, "literal-x"], literals: 1 });
    expect(resolveSecretArgs([], {}, "--secret")).toEqual({ secrets: [], literals: 0 });
  });

  it("refuses an unset or empty variable, naming the variable — never an empty secret or the literal ref", () => {
    for (const env of [{}, { [VAR]: "" }]) {
      expect(() => resolveSecretArgs([`env:${VAR}`], env, "--secret")).toThrow(SecretArgError);
      expect(() => resolveSecretArgs([`env:${VAR}`], env, "--secret")).toThrow(`--secret env:${VAR}: environment variable ${VAR} is not set`);
    }
  });

  it("refuses a malformed env: ref without echoing it (it may be a pasted value)", () => {
    for (const bad of ["env:", "env:1abc", "env:has space", "env:a-b"]) {
      let msg = "";
      try {
        resolveSecretArgs([bad], {}, "--secret");
      } catch (e) {
        expect(e).toBeInstanceOf(SecretArgError);
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/env:<VAR>/);
      if (bad.length > "env:".length) expect(msg).not.toContain(bad.slice("env:".length));
    }
  });
});

function capture(port: BrowserPort, judge: JudgmentPort = new DoneJudge()) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: { judge, gen: new FakeGenerationGateway(), browserPortFactory: () => port },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  return { program, out, err };
}

/** Records every (already redacted) payload the model would see, and ends the run at once. */
class DoneJudge implements JudgmentPort {
  readonly payloads: string[] = [];
  async systemOne(args: unknown): Promise<Record<string, Answer>> {
    this.payloads.push(JSON.stringify(args));
    return { action: { kind: "choice", value: "done", confidence: 0.9 } };
  }
}

const intercepting = (): { port: BrowserPort; opens: OpenOptions[] } => {
  const opens: OpenOptions[] = [];
  return {
    opens,
    port: {
      async open(opts) {
        opens.push(opts);
        throw new Error("open intercepted by test");
      },
    },
  };
};

describe("explore --secret env:VAR (#195)", () => {
  const GOAL = ["explore", "--url", "http://127.0.0.1:3000/app", "--goal", "look", "--success", "urlIncludes:/app", "--json"];

  it("an unset variable refuses the run before any browser opens", async () => {
    const { port, opens } = intercepting();
    const { program, out } = capture(port);
    await program.parseAsync([...GOAL, "--secret", `env:${VAR}`], { from: "user" });
    expect(opens).toHaveLength(0);
    const env = JSON.parse(out.join("").trim()) as { ok: boolean; error: { code: string; message: string } };
    expect(env).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(env.error.message).toContain(`${VAR} is not set`);
  });

  it("verify-fix refuses an unset variable too", async () => {
    const { port, opens } = intercepting();
    const { program, out } = capture(port);
    await program.parseAsync(["verify-fix", "--result", "/nonexistent.json", "--fingerprint", "x", "--secret", `env:${VAR}`, "--json"], { from: "user" });
    expect(opens).toHaveLength(0);
    expect(JSON.parse(out.join("").trim())).toMatchObject({ ok: false, error: { code: "E_VERIFY_FIX_ARGS" } });
  });

  it("a literal --secret still works but warns (stderr) that it is visible — pointing at env:", async () => {
    const { port } = intercepting();
    const { program, err } = capture(port);
    await program.parseAsync([...GOAL, "--secret", "literal-pw"], { from: "user" });
    expect(err.join("")).toMatch(/--secret env:VAR/);
    expect(err.join("")).not.toContain("literal-pw");
    const quiet = capture(intercepting().port);
    process.env[VAR] = CANARY;
    await quiet.program.parseAsync([...GOAL, "--secret", `env:${VAR}`], { from: "user" });
    expect(quiet.err.join("")).not.toMatch(/--secret env:VAR/);
  });
});

describe("explore --secret env:VAR redacts the resolved value like a literal (#195, served)", () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body><main>
        <h1>Account</h1><p data-testid="token">API token: ${CANARY}</p>
        <button type="button">Copy ${CANARY}</button><a href="/app">Home</a></main></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const run = async (secretArgs: string[]): Promise<{ payloads: string; out: string }> => {
    const judge = new DoneJudge();
    const { program, out } = capture(new PlaywrightBrowserPort(), judge);
    await program.parseAsync(
      ["explore", "--url", `${origin}/app`, "--goal", "read the account page", "--success", "urlIncludes:/app", ...secretArgs, "--json"],
      { from: "user" },
    );
    return { payloads: judge.payloads.join("\n"), out: out.join("") };
  };

  it(
    "the model never sees the env-resolved value, exactly as with a literal --secret (and does without one)",
    async () => {
      const bare = await run([]);
      expect(bare.payloads).toContain(CANARY); // the control: the page really shows it to the model

      process.env[VAR] = CANARY;
      const viaEnv = await run(["--secret", `env:${VAR}`]);
      expect(viaEnv.payloads.length).toBeGreaterThan(0);
      expect(viaEnv.payloads).not.toContain(CANARY);
      expect(viaEnv.out).not.toContain(CANARY);
      expect(viaEnv.payloads).not.toContain(`env:${VAR}`);

      delete process.env[VAR];
      const literal = await run(["--secret", CANARY]);
      expect(literal.payloads).not.toContain(CANARY);
    },
    120_000,
  );
});
