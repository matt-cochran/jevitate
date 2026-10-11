import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import type { CliDeps } from "./cli-shared.js";

/** #496/#497 — the review sheet's --full flag, promote's attention block, and `journey migrate --labels`. No browser. */

const SECRET_LITERAL = "s3cret-literal-value";

function strongJourney(id = "strong", overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: "Publish",
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      secretRefs: [{ manager: "env", key: "PUBLISH_TOKEN_ENV", origin: "https://example.test", field: "token" }],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "fill", target: { label: "Access token" }, value: { redacted: false, value: SECRET_LITERAL }, expect: { kind: "textIncludes", target: { role: "status" }, text: "ready" } } },
            {
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/publish", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

let root: string;
let journeysDir: string;

beforeEach(async () => {
  prompts = [];
  root = await mkdtemp(join(tmpdir(), "jev-012-surface-"));
  journeysDir = join(root, "journeys");
  await new FsJourneyStore(journeysDir).put(strongJourney());
  installClock(new FakeClock({ startMs: Date.parse("2026-10-08T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

let prompts: string[] = [];
function approval(): NonNullable<CliDeps["approval"]> {
  return { env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true, user: () => "tester", prompt: async (q) => { prompts.push(q); return "no"; } };
}

function deps(): CliDeps {
  // #437: approvals here run without a terminal (`--non-interactive-approval "test"`), in a fixed environment.
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    explore: { targetsConfigPath: join(root, "no-targets.json") },
    approval: approval(),
  };
}

async function cli(argv: readonly string[]): Promise<{ out: string; json: any }> {
  const lines: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  await program.parseAsync([...argv], { from: "user" });
  const out = lines.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { out, json };
}


describe("#496 journey review --full", () => {
  it("the default sheet has no detail section", async () => {
    expect((await cli(["journey", "review", "strong"])).out).not.toContain("DETAIL");
  });

  it("--full adds the detail section", async () => {
    expect((await cli(["journey", "review", "strong", "--full"])).out).toContain("DETAIL");
  });

  it("--full with --markdown adds the detail section", async () => {
    expect((await cli(["journey", "review", "strong", "--markdown", "--full"])).out).toContain("## Detail");
  });

  it("--stale refuses --full", async () => {
    expect((await cli(["journey", "review", "--stale", "--full", "--json"])).json.error.code).toBe("E_JOURNEY_REVIEW_ARGS");
  });
});

describe("#496 journey promote", () => {
  it("--full shows the detail section before the confirmation", async () => {
    const { out } = await cli(["journey", "promote", "strong", "--full"]);
    expect(out).toContain("DETAIL");
  });

  it("repeats the sheet's attention items in the confirmation prompt", async () => {
    await cli(["journey", "promote", "strong"]);
    expect(prompts[0]).toContain("Before you approve:");
  });
});

describe("#497 journey migrate --labels", () => {
  it("refuses a mix with --step-ids", async () => {
    expect((await cli(["journey", "migrate", "--labels", "--step-ids", "--json"])).json.error.code).toBe("E_JOURNEY_MIGRATE_ARGS");
  });

  it("refuses to run with no migration named", async () => {
    expect((await cli(["journey", "migrate", "--json"])).json.error.code).toBe("E_JOURNEY_MIGRATE_ARGS");
  });

  it("refuses --id without --labels", async () => {
    expect((await cli(["journey", "migrate", "--step-ids", "--id", "strong", "--json"])).json.error.code).toBe("E_JOURNEY_MIGRATE_ARGS");
  });
});
