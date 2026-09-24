import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import {
  parseAssertionSpec,
  parseSuccessSpec,
  resolveExploreAllowlist,
  runExploration,
  runAuthorJourney,
  runCoverageMission,
  runAdversarialCliMission,
  runFeatureCliMission,
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

  it("parses valueEquals (a form control's value) with key=value or CSS-selector descriptors", () => {
    expect(parseAssertionSpec("valueEquals:label=Last name|Litmus")).toEqual({
      kind: "valueEquals",
      target: { label: "Last name" },
      value: "Litmus",
    });
    // The issue's own example: a [data-testid=…] selector is read as the test id.
    expect(parseAssertionSpec("valueEquals:[data-testid=profile-general-lastName]|Litmus")).toEqual({
      kind: "valueEquals",
      target: { testId: "profile-general-lastName" },
      value: "Litmus",
    });
    expect(parseAssertionSpec('valueEquals:[data-testid="last"]|')).toEqual({
      kind: "valueEquals",
      target: { testId: "last" },
      value: "",
    });
    expect(parseAssertionSpec("valueEquals:#profile input[name=last]|x")).toEqual({
      kind: "valueEquals",
      target: { css: "#profile input[name=last]" },
      value: "x",
    });
    expect(() => parseAssertionSpec("valueEquals:testId=last")).toThrow(/<descriptor>\|<value>/);
  });

  it("parses every --success check kind: page, reloadThen, requestMade, responseStatus", () => {
    expect(parseSuccessSpec("urlIncludes:/done")).toEqual({ kind: "page", assertion: { kind: "urlIncludes", text: "/done" } });
    expect(parseSuccessSpec("reloadThen:valueEquals:[data-testid=last]|Litmus")).toEqual({
      kind: "reloadThen",
      assertion: { kind: "valueEquals", target: { testId: "last" }, value: "Litmus" },
    });
    expect(parseSuccessSpec("requestMade:put /api/profile/*")).toEqual({
      kind: "requestMade",
      method: "PUT",
      pathGlob: "/api/profile/*",
    });
    expect(parseSuccessSpec("requestMade:* /api/**")).toEqual({ kind: "requestMade", method: "*", pathGlob: "/api/**" });
    expect(parseSuccessSpec("responseStatus:PUT /api/profile=2xx")).toEqual({
      kind: "responseStatus",
      method: "PUT",
      pathGlob: "/api/profile",
      status: { class: 2 },
    });
    expect(parseSuccessSpec("responseStatus:POST /api/items=201")).toMatchObject({ status: { code: 201 } });
    expect(parseSuccessSpec("responseStatus:DELETE /api/items/*=4XX")).toMatchObject({ status: { class: 4 } });
  });

  it("rejects malformed --success checks", () => {
    expect(() => parseSuccessSpec("requestMade:/api/profile")).toThrow(/<METHOD> <path-glob>/);
    expect(() => parseSuccessSpec("requestMade:PUT api/profile")).toThrow(/<METHOD> <path-glob>/);
    expect(() => parseSuccessSpec("responseStatus:PUT /api/profile")).toThrow(/=<2xx\|4xx\|code>/);
    expect(() => parseSuccessSpec("responseStatus:PUT /api/profile=ok")).toThrow(/2xx, 4xx/);
    expect(() => parseSuccessSpec("responseStatus:PUT /api/profile=600")).toThrow(/2xx, 4xx/);
    expect(() => parseSuccessSpec("reloadThen:reloadThen:urlIncludes:/x")).toThrow(/cannot be nested/);
    expect(() => parseSuccessSpec("reloadThen:nope")).toThrow();
    expect(() => parseSuccessSpec("nope")).toThrow();
  });

  it("documents every --success kind in the explore help, and --success is repeatable", () => {
    const program = buildProgram({ profiles: new ProfileManager("/unused") });
    const explore = program.commands.find((c) => c.name() === "explore");
    const success = explore?.options.find((o) => o.long === "--success");
    for (const kind of ["urlIncludes:", "visible:", "textIncludes:", "count:", "valueEquals:", "reloadThen:", "requestMade:", "responseStatus:"]) {
      expect(success?.description).toContain(kind);
    }
    expect(success?.description).toContain("repeatable");
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

  it("runAuthorJourney writes the authored Journey to the journeys store", async () => {
    const journeysDir = await mkdtemp(join(tmpdir(), "explore-author-"));
    const authored: Journey = {
      metadata: {
        id: "explore-checkout",
        name: "Explore: checkout",
        promoted: false,
        params: [],
        authoredBy: "jev-driven",
        createdAtIso: "2026-09-20T00:00:00Z",
      },
      recording: { version: "1.0", site: "https://fixture.test", pages: [] },
    };

    const result = await runAuthorJourney({
      url: "https://fixture.test/checkout",
      goal: "reach the confirmation page",
      successAssertion: parseAssertionSpec("visible:testId=confirmed"),
      allowlist: ["https://fixture.test"],
      journeysDir,
      journeyId: "explore-checkout",
      journeyName: "Explore: checkout",
      takes: 1,
      // Test seam: no browser — assert persistence of an authored Journey.
      authorImpl: async () => ({ outcome: "authored", journey: authored }),
    });

    expect(result.outcome).toBe("authored");
    const persisted = await new FsJourneyStore(journeysDir).get("explore-checkout");
    expect(persisted?.metadata.authoredBy).toBe("jev-driven");
    expect(persisted?.metadata.promoted).toBe(false);
  });

  it("runAuthorJourney refuses an off-allowlist target BEFORE authoring", async () => {
    const authorImpl = vi.fn();
    await expect(
      runAuthorJourney({
        url: "https://evil.test/checkout",
        goal: "g",
        successAssertion: parseAssertionSpec("visible:testId=confirmed"),
        allowlist: ["https://fixture.test"],
        journeysDir: "/unused",
        journeyId: "x",
        journeyName: "x",
        authorImpl,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExploreTargetError);
    expect(authorImpl).not.toHaveBeenCalled();
  });

  it("runCoverageMission refuses an off-allowlist target BEFORE opening a browser", async () => {
    const browserPortFactory = vi.fn(() => {
      throw new Error("browser must not be opened for an unauthorized target");
    });
    await expect(
      runCoverageMission({
        url: "http://127.0.0.1:3000/login",
        allowlist: ["https://only-this.example.com"],
        judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
        gen: new FakeGenerationGateway(),
        browserPortFactory,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExploreTargetError);
    expect(browserPortFactory).not.toHaveBeenCalled();
  });

  it("runFeatureCliMission refuses an undeclared origin (no browser touched)", async () => {
    await expect(
      runFeatureCliMission({
        seedUrl: "https://not-authorized.test",
        allowlist: ["https://authorized.test"],
        capability: "checkout",
        routeGlobs: ["/checkout/**"],
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
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

  it("adversarial: refuses a --min-control-coverage outside 0..1 before any browser opens", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(
      ["explore", "--strategy", "adversarial", "--url", "http://127.0.0.1:3000/login", "--fake-ai", "--min-control-coverage", "2", "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS", message: expect.stringContaining("between 0 and 1") } });
  });

  it("refuses a --success-when other than held|final before any browser opens (#80)", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(
      [
        "explore", "--url", "http://127.0.0.1:3000/login", "--goal", "g", "--success", "visible:testId=x",
        "--success-when", "sometimes", "--fake-ai", "--json",
      ],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS", message: expect.stringContaining("--success-when") } });
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

  it("explore --strategy coverage does not require --goal/--success and reaches gateway setup", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(
      ["explore", "--strategy", "coverage", "--url", "http://127.0.0.1:3000/login", "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    // Got PAST the goal-args validation (no E_EXPLORE_ARGS) to gateway setup,
    // proving the coverage strategy is a distinct, goal-free path.
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
