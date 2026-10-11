import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replayAllowlist, VerifyFixInputError } from "./verify-fix-api.js";

/**
 * #484 — verify-fix replays with the allow list stored in the original result. Only an explicit
 * `--allow <origin...>` or `--env <name>` overrides it (a safety boundary: never widened implicitly),
 * and the override is recorded on the report.
 */

const recorded = ["http://localhost:3000"];
let dir: string;
let environmentsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-vf-allow-"));
  environmentsFile = join(dir, "environments.json");
  await writeFile(environmentsFile, JSON.stringify({ local: { baseUrl: "http://localhost:3000", allow: ["http://127.0.0.1:3000"] } }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("replayAllowlist (#484)", () => {
  it("keeps the stored allow list when nothing overrides it", () => {
    expect(replayAllowlist(recorded, {})).toEqual({ allowlist: recorded });
  });

  it("replays with the --allow origins when given", () => {
    expect(replayAllowlist(recorded, { allow: ["http://localhost:3000", "http://127.0.0.1:3000"] }).allowlist).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
  });

  it("records which origins an --allow override added", () => {
    expect(replayAllowlist(recorded, { allow: ["http://localhost:3000", "http://127.0.0.1:3000/"] }).override).toEqual({
      source: "--allow",
      origins: ["http://localhost:3000", "http://127.0.0.1:3000"],
      recorded,
      added: ["http://127.0.0.1:3000"],
      removed: [],
    });
  });

  it("replays with the named environment's current allow list", () => {
    expect(replayAllowlist(recorded, { env: "local", environmentsFile }).override?.origins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  it("refuses --allow and --env together", () => {
    expect(() => replayAllowlist(recorded, { allow: ["http://127.0.0.1:3000"], env: "local", environmentsFile })).toThrow(VerifyFixInputError);
  });

  it("refuses an unknown environment as input, never falling back to the stored list", () => {
    expect(() => replayAllowlist(recorded, { env: "nope", environmentsFile })).toThrow(VerifyFixInputError);
  });
});
