import { afterEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * `--secret-field` / `--totp` (#72): bindings are resolved from the environment before any browser
 * opens, refused outside the goal strategy, and no value ever appears in the CLI's output. The
 * port is a capturing fake that aborts before any browser starts.
 */
function capture(): { program: ReturnType<typeof buildProgram>; lines: string[]; opens: OpenOptions[] } {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      throw new Error("open intercepted by test");
    },
  };
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => port },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opens };
}

const URL = "http://127.0.0.1:3000/login";
const GOAL = ["explore", "--url", URL, "--goal", "log in", "--success", "urlIncludes:/home", "--json"];
const PW = "cli-pw-canary-7f3a";

afterEach(() => {
  delete process.env.JEV_TEST_PW;
  delete process.env.JEV_TEST_SEED;
});

describe("explore --secret-field / --totp (#72)", () => {
  it("fails fast (no browser) when the bound variable is unset — naming the variable only", async () => {
    const { program, lines, opens } = capture();
    await program.parseAsync([...GOAL, "--secret-field", "label=Password=env:JEV_TEST_PW"], { from: "user" });
    expect(opens).toHaveLength(0);
    const out = JSON.parse(lines.join(""));
    expect(out).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(out.error.message).toContain("JEV_TEST_PW is not set");
  });

  it("never echoes a value pasted in place of env:<VAR>", async () => {
    const { program, lines, opens } = capture();
    await program.parseAsync([...GOAL, "--secret-field", `label=Password=${PW}`], { from: "user" });
    expect(opens).toHaveLength(0);
    expect(lines.join("")).toContain("E_EXPLORE_ARGS");
    expect(lines.join("")).not.toContain(PW);
  });

  it("refuses a TOTP seed that is not base32, and bindings outside the goal strategy", async () => {
    process.env.JEV_TEST_SEED = "not a seed!";
    const a = capture();
    await a.program.parseAsync([...GOAL, "--totp", "label=Code=env:JEV_TEST_SEED"], { from: "user" });
    expect(JSON.parse(a.lines.join("")).error.message).toContain("not a base32 TOTP seed");
    const b = capture();
    await b.program.parseAsync(
      ["explore", "--strategy", "adversarial", "--url", URL, "--secret-field", "type=password=env:JEV_TEST_PW", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(b.lines.join("")).error.message).toContain("only with --strategy goal");
    expect(a.opens.length + b.opens.length).toBe(0);
  });

  it("a resolved binding reaches the run (the browser is opened) and its value is not in the output", async () => {
    process.env.JEV_TEST_PW = PW;
    const { program, lines, opens } = capture();
    await program.parseAsync([...GOAL, "--secret-field", "type=password=env:JEV_TEST_PW"], { from: "user" });
    expect(opens).toHaveLength(1);
    expect(lines.join("")).not.toContain(PW);
  });

  it("explore --help says --secret is redaction only and documents the bindings", () => {
    const { program } = capture();
    const explore = program.commands.find((c) => c.name() === "explore")!;
    let help = "";
    explore.configureOutput({ writeOut: (s) => (help += s) });
    explore.outputHelp();
    expect(help).toContain("REDACTION ONLY");
    expect(help).toContain("--secret-field");
    expect(help).toContain("--totp");
    expect(help).toContain("--storage-state");
  });
});
