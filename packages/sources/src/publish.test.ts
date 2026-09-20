import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@doit/journey";
import { GitSourceManager, type GitExec } from "./git.js";
import { validateForPublish, publishJourney, type GhPort } from "./publish.js";
import { EmbeddedSecretError, UndeclaredOriginError } from "./errors.js";

const ORIGIN = "https://mail.example.com";

function journeyWithFill(value: any): Journey {
  return {
    metadata: { id: "login", name: "login", promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
    recording: {
      version: "1",
      site: "mail.example.com",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: `${ORIGIN}/login`, expect: { kind: "urlIncludes", text: "/login" } } },
            { step: { kind: "fill", target: { testId: "pw" }, value, expect: { kind: "urlIncludes", text: "/login" } } },
          ],
        },
      ],
    } as any,
  };
}

describe("validateForPublish", () => {
  it("throws EmbeddedSecretError for a fill with a materialized value (FMECA #3)", () => {
    const req = { journey: journeyWithFill({ redacted: false, value: "hunter2" }), declaredOrigins: [ORIGIN], toSource: "gmail" };
    expect(() => validateForPublish(req)).toThrow(EmbeddedSecretError);
  });

  it("throws when a step touches an origin missing from declaredOrigins", () => {
    const req = { journey: journeyWithFill({ var: "pw" }), declaredOrigins: ["https://other.example.com"], toSource: "gmail" };
    expect(() => validateForPublish(req)).toThrow(UndeclaredOriginError);
  });

  it("passes a valid journey with {var} and {redacted:true} values", () => {
    const req = { journey: journeyWithFill({ var: "pw" }), declaredOrigins: [ORIGIN], toSource: "gmail" };
    expect(validateForPublish(req).metadata.id).toBe("login");

    const req2 = { journey: journeyWithFill({ redacted: true, length: 8 }), declaredOrigins: [ORIGIN], toSource: "gmail" };
    expect(validateForPublish(req2).metadata.id).toBe("login");
  });
});

describe("publishJourney (fake GitExec + fake GhPort)", () => {
  function setup() {
    const sourcesDir = mkdtempSync(join(tmpdir(), "pub-sources-"));
    const cloneDir = join(sourcesDir, "gmail");
    const calls: string[][] = [];
    const fake: GitExec = async (args) => {
      calls.push(args);
      return { stdout: "" };
    };
    const mgr = new GitSourceManager(sourcesDir, fake);
    // Simulate an already-cloned source directory (real clone happens via
    // GitSourceManager.add in the real flow; here we just need the dir to
    // exist so `run()`'s cwd resolves).
    mkdirSync(cloneDir, { recursive: true });
    return { mgr, calls, cloneDir };
  }

  it("writes to publish/<id> — never the default branch — and returns instructions when gh is unavailable", async () => {
    const { mgr, calls, cloneDir } = setup();
    const gh: GhPort = { available: async () => false, createPr: async () => "https://github.com/x/y/pull/1" };
    const req = { journey: journeyWithFill({ var: "pw" }), declaredOrigins: [ORIGIN], toSource: "gmail" };

    const result = await publishJourney(mgr, gh, req);

    expect(result.branch).toBe("publish/login");
    expect(result.branch).not.toMatch(/^(main|master)$/);
    expect(result.pushed).toBe(true);
    expect(result.prUrl).toBeUndefined();
    expect(result.instructions).toMatch(/publish\/login/);

    const checkoutCall = calls.find((a) => a[0] === "checkout");
    expect(checkoutCall).toEqual(["checkout", "-b", "publish/login"]);
    const pushCall = calls.find((a) => a[0] === "push");
    expect(pushCall).toEqual(["push", "-u", "origin", "publish/login"]);
    expect(pushCall).not.toContain("main");
    expect(pushCall).not.toContain("master");

    const written = JSON.parse(readFileSync(join(cloneDir, "journeys", "login.journey.json"), "utf8"));
    expect(written.metadata.id).toBe("login");
    expect(written.declaredOrigins).toEqual([ORIGIN]);
  });

  it("opens a PR via gh when available", async () => {
    const { mgr, cloneDir } = setup();
    void cloneDir;
    const gh: GhPort = { available: async () => true, createPr: async () => "https://github.com/x/y/pull/2" };
    const req = { journey: journeyWithFill({ var: "pw" }), declaredOrigins: [ORIGIN], toSource: "gmail" };
    const result = await publishJourney(mgr, gh, req);
    expect(result.prUrl).toBe("https://github.com/x/y/pull/2");
    expect(result.instructions).toBeUndefined();
  });

  it("never publishes a journey that fails validation (no branch/commit/push calls at all)", async () => {
    const { mgr, calls } = setup();
    const gh: GhPort = { available: async () => false, createPr: async () => "" };
    const req = { journey: journeyWithFill({ redacted: false, value: "hunter2" }), declaredOrigins: [ORIGIN], toSource: "gmail" };
    await expect(publishJourney(mgr, gh, req)).rejects.toBeInstanceOf(EmbeddedSecretError);
    expect(calls).toHaveLength(0);
  });
});
