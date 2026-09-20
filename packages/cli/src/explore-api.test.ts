import { describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { buildProgram } from "./program.js";
import {
  parseAssertionSpec,
  resolveExploreAllowlist,
  runExploration,
  runAdversarialCliMission,
} from "./explore-api.js";

describe("explore-api — assertion spec + allowlist (pure, no browser)", () => {
  it("parses urlIncludes / visible / textIncludes / count specs", () => {
    expect(parseAssertionSpec("urlIncludes:/inbox")).toEqual({ kind: "urlIncludes", text: "/inbox" });
    expect(parseAssertionSpec("visible:role=heading;name=Inbox")).toEqual({
      kind: "visible",
      target: { role: "heading", name: "Inbox" },
    });
    expect(parseAssertionSpec("textIncludes:testId=status|Done")).toEqual({
      kind: "textIncludes",
      target: { testId: "status" },
      text: "Done",
    });
    expect(parseAssertionSpec("count:role=listitem|min=1")).toEqual({
      kind: "count",
      target: { role: "listitem" },
      min: 1,
    });
  });

  it("rejects malformed specs", () => {
    expect(() => parseAssertionSpec("nope")).toThrow();
    expect(() => parseAssertionSpec("urlIncludes:")).toThrow();
    expect(() => parseAssertionSpec("visible:foo=bar")).toThrow(/no usable selector/);
  });

  it("defaults the allowlist to the URL's own origin, honoring explicit --allow", () => {
    expect(resolveExploreAllowlist("http://127.0.0.1:3000/login", [])).toEqual(["http://127.0.0.1:3000"]);
    expect(resolveExploreAllowlist("http://127.0.0.1:3000/login", ["https://a.test"])).toEqual([
      "https://a.test",
    ]);
    expect(resolveExploreAllowlist("not a url", [])).toEqual([]); // fail-closed downstream
  });

  it("runExploration refuses an off-allowlist target BEFORE opening a browser", async () => {
    const browserPortFactory = vi.fn(() => {
      throw new Error("browser must not be opened for an unauthorized target");
    });
    await expect(
      runExploration({
        url: "http://127.0.0.1:3000/login",
        goal: "x",
        successAssertion: { kind: "urlIncludes", text: "/inbox" },
        allowlist: ["https://only-this.example.com"],
        judge: { async systemOne() { return { op: { kind: "choice", value: "done", confidence: 1 } }; } },
        gen: new FakeGenerationGateway(),
        browserPortFactory,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExploreTargetError);
    expect(browserPortFactory).not.toHaveBeenCalled();
  });
});

function newProgram() {
  const profiles = new ProfileManager("/unused-in-these-tests");
  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines };
}

describe("explore command — argument + setup refusals (no browser)", () => {
  it("fails when --url/--goal/--success are missing", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(["explore", "--url", "http://127.0.0.1:3000/login", "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
  });

  it("fails on a malformed --success spec", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(
      ["explore", "--url", "http://127.0.0.1:3000/login", "--goal", "g", "--success", "nope", "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ASSERTION" } });
  });

  it("fails closed when no gateway is selected (neither --real nor --fake-ai)", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(
      [
        "explore",
        "--url",
        "http://127.0.0.1:3000/login",
        "--goal",
        "g",
        "--success",
        "urlIncludes:/inbox",
        "--json",
      ],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_AI_SETUP_REQUIRED" } });
  });
});

describe("runAdversarialCliMission — fail-closed (no browser)", () => {
  it("refuses an undeclared origin before any browser is opened", async () => {
    let opened = false;
    await expect(
      runAdversarialCliMission({
        seedUrl: "https://not-authorized.test",
        allowlist: ["https://authorized.test"],
        strategies: ["ordering-violation"],
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
        generation: new FakeGenerationGateway(),
        profileDir: "/tmp/unused",
        // If the guard failed to fail-closed, this factory would run and flip the flag.
        browserPortFactory: () => {
          opened = true;
          throw new Error("browser must not be opened for an unauthorized origin");
        },
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
    expect(opened).toBe(false);
  });
});
