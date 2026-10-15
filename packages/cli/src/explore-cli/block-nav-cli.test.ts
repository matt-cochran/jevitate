import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram, type CliDeps } from "../program.js";
import { mintStorageState, parsePersonaLogin } from "../persona-login.js";
import { runJourneyProgrammatically } from "../journey-api.js";

/**
 * #521: `--block-off-allowlist-navigation` is a plain opt-in boolean on every mission strategy (never
 * a usage refusal), passed to the mission session's open options; login and Journey sessions never
 * get it. A spy port records the options and opens nothing.
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-521-cli-"));
  mkdirSync(join(dir, "journeys"), { recursive: true });
  writeFileSync(
    join(dir, "journeys", "hop.json"),
    JSON.stringify({
      metadata: { id: "hop", name: "hop", promoted: true, params: [], createdAtIso: "2026-10-15T00:00:00Z" },
      recording: { version: "1", site: "http://127.0.0.1:3999", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "go" }, expect: { kind: "visible", target: { testId: "ok" } } } }] }] },
    }),
  );
});

function spyPort(seen: OpenOptions[]): BrowserPort {
  return {
    open: async (o: OpenOptions) => {
      seen.push(o);
      throw new Error("spy port: no browser");
    },
  } as BrowserPort;
}

async function explore(argv: readonly string[]): Promise<{ code: number; seen: OpenOptions[] }> {
  const seen: OpenOptions[] = [];
  const deps = {
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => spyPort(seen) },
  } as unknown as CliDeps;
  const program = buildProgram(deps);
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  process.exitCode = undefined;
  await program.parseAsync(["explore", ...argv, "--out", join(dir, "out"), "--fake-ai", "--json"], { from: "user" });
  return { code: Number(process.exitCode), seen };
}

const URL_ = "http://127.0.0.1:3999/";
const STRATEGIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["goal", ["--goal", "g", "--success", "urlIncludes:/x"]],
  ["usability", ["--strategy", "usability", "--goal", "g", "--app-class", "consumer"]],
  ["adversarial", ["--strategy", "adversarial"]],
  ["coverage", ["--strategy", "coverage"]],
  ["exploratory", ["--strategy", "exploratory"]],
  ["feature", ["--feature", "checkout"]],
];

describe("explore --block-off-allowlist-navigation (#521)", () => {
  it.each(STRATEGIES)("%s: the mission session opens with blockOffAllowlistNavigation", async (_name, args) => {
    const r = await explore(["--url", URL_, ...args, "--block-off-allowlist-navigation"]);
    expect(r.seen[0]?.blockOffAllowlistNavigation).toBe(true);
  });

  it.each(STRATEGIES)("%s: the flag is never a usage refusal (exit 64)", async (_name, args) => {
    expect((await explore(["--url", URL_, ...args, "--block-off-allowlist-navigation"])).code).not.toBe(64);
  });

  it("without the flag the mission session opens unguarded", async () => {
    const r = await explore(["--url", URL_, "--strategy", "coverage"]);
    expect(r.seen[0]?.blockOffAllowlistNavigation).toBeUndefined();
  });
});

describe("sessions that may legitimately leave the allowlist stay unguarded (#521)", () => {
  it("a persona login session opens without blockOffAllowlistNavigation", async () => {
    const seen: OpenOptions[] = [];
    await mintStorageState({
      login: parsePersonaLogin({ url: "http://127.0.0.1:3999/login", userEnv: "APP_USER", passwordEnv: "APP_PASSWORD" }, "login"),
      save: join(dir, "state.json"),
      allowlist: ["http://127.0.0.1:3999"],
      env: { APP_USER: "u", APP_PASSWORD: "p" },
      port: spyPort(seen),
      timeoutMs: 1000,
    }).catch(() => undefined);
    expect(seen.map((o) => o.blockOffAllowlistNavigation)).toEqual([undefined]);
  });

  it("a journey run session opens without blockOffAllowlistNavigation", async () => {
    const seen: OpenOptions[] = [];
    await runJourneyProgrammatically({ dir: join(dir, "journeys"), id: "hop", params: {}, browserPortFactory: () => spyPort(seen) }).catch(() => undefined);
    expect(seen.map((o) => o.blockOffAllowlistNavigation)).toEqual([undefined]);
  });
});
