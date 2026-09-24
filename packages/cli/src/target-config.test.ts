import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig } from "./target-config.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("per-target settle/hang config (~/.jevitate/targets.json)", () => {
  it("is keyed by origin; flags add patterns and override numbers", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const p = join(dir, "targets.json");
    await writeFile(
      p,
      JSON.stringify({
        "http://localhost:3000": { settle: { ignoreRequests: ["/api/poll*"], longPollMs: 4000 }, hangs: { ignoreNoProgress: ["click Refresh*"] } },
      }),
    );
    const file = loadTargetsFile(p);
    expect(resolveTargetConfig(file, "http://localhost:3000", { settleIgnore: ["/hub/*"], longPollMs: 2000 })).toEqual({
      settle: { ignoreRequests: ["/api/poll*", "/hub/*"], longPollMs: 2000 },
      hangs: { ignoreNoProgress: ["click Refresh*"] },
      timing: {},
    });
    expect(resolveTargetConfig(file, "http://other.test", { apiPrefixes: ["/graphql"] })).toEqual({
      settle: {},
      hangs: {},
      timing: { apiPrefixes: ["/graphql"] },
    });
  });

  it("a missing file is no config; a malformed one fails closed", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    expect(loadTargetsFile(join(dir, "none.json"))).toEqual({});
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ "http://a.test": { settle: { longPollMs: -1 } } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
    await writeFile(bad, JSON.stringify({ "http://a.test": { settle: { ignoreRequests: "x" } } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
  });
});
