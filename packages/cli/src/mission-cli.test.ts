import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  UnknownOrUnpromotedMissionTargetError,
} from "@jevitate/missions";
import { buildProgram } from "./program.js";

/**
 * Browser-free, fast CLI tests for `jevitate mission target`. Kept separate
 * from `program.test.ts` (which carries a known full-suite timeout flake),
 * mirroring `journey-cli.test.ts`.
 */

async function newTargetsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevitate-mission-targets-"));
}

function newProgram() {
  const profiles = new ProfileManager("/unused-in-these-tests");
  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines };
}

test("mission target add registers an UNPROMOTED target", async () => {
  const dir = await newTargetsDir();
  const { program, lines } = newProgram();

  await program.parseAsync(
    [
      "mission", "target", "add", "acme",
      "--name", "Acme staging",
      "--authorized-origin", "https://staging.acme.test",
      "--base-url", "https://staging.acme.test/app",
      "--dir", dir, "--json",
    ],
    { from: "user" },
  );
  const parsed = JSON.parse(lines.join(""));

  expect(parsed).toMatchObject({
    v: 1,
    ok: true,
    data: {
      id: "acme",
      name: "Acme staging",
      authorizedOrigin: "https://staging.acme.test",
      baseUrl: "https://staging.acme.test/app",
      promoted: false,
    },
  });
  expect(typeof parsed.data.createdAtIso).toBe("string");
});

test("SECURITY: a registered-but-unpromoted target is NOT resolvable by queue_exploration's registry; promote flips the gate", async () => {
  const dir = await newTargetsDir();
  const { program } = newProgram();

  // Register via the CLI (writes to the SAME fs store the MCP tool reads).
  await program.parseAsync(
    [
      "mission", "target", "add", "acme",
      "--name", "Acme staging",
      "--authorized-origin", "https://staging.acme.test",
      "--base-url", "https://staging.acme.test/app",
      "--dir", dir, "--json",
    ],
    { from: "user" },
  );

  // The exact registry `queue_exploration` uses (via `enqueueMission`) to
  // resolve a target id — reading the very directory the CLI wrote to.
  const registry = new MissionTargetRegistry(new FsMissionTargetStore(dir));

  // Un-promoted: the promoted-only gate refuses it (fail-closed).
  await expect(registry.resolve("acme")).rejects.toBeInstanceOf(
    UnknownOrUnpromotedMissionTargetError,
  );

  // Promote via the CLI.
  const { program: program2 } = newProgram();
  await program2.parseAsync(
    ["mission", "target", "promote", "acme", "--dir", dir, "--json"],
    { from: "user" },
  );

  // Now the same registry resolves it.
  const resolved = await registry.resolve("acme");
  expect(resolved).toMatchObject({
    id: "acme",
    authorizedOrigin: "https://staging.acme.test",
    baseUrl: "https://staging.acme.test/app",
    promoted: true,
  });
});

test("mission target list --json returns ALL targets including unpromoted ones", async () => {
  const dir = await newTargetsDir();

  const addTarget = async (id: string, promote: boolean) => {
    const { program } = newProgram();
    await program.parseAsync(
      [
        "mission", "target", "add", id,
        "--name", id,
        "--authorized-origin", `https://${id}.test`,
        "--base-url", `https://${id}.test/`,
        "--dir", dir, "--json",
      ],
      { from: "user" },
    );
    if (promote) {
      const { program: p2 } = newProgram();
      await p2.parseAsync(["mission", "target", "promote", id, "--dir", dir, "--json"], { from: "user" });
    }
  };
  await addTarget("published", true);
  await addTarget("draft", false);

  const { program, lines } = newProgram();
  await program.parseAsync(["mission", "target", "list", "--dir", dir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  const byId = new Map(
    (parsed.data as Array<{ id: string; promoted: boolean }>).map((t) => [t.id, t.promoted]),
  );
  expect(byId.get("published")).toBe(true);
  expect(byId.get("draft")).toBe(false);
});

test("mission target add with missing required flags fails with E_MISSION_TARGET_ARGS and a non-zero exit", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await newTargetsDir();
    const { program, lines } = newProgram();
    await program.parseAsync(
      ["mission", "target", "add", "acme", "--name", "Acme", "--dir", dir, "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_MISSION_TARGET_ARGS");
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("mission target add with an invalid id fails with E_MISSION_TARGET_ADD (schema rejects it — no file written)", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await newTargetsDir();
    const { program, lines } = newProgram();
    await program.parseAsync(
      [
        "mission", "target", "add", "../escape",
        "--name", "Escape",
        "--authorized-origin", "https://x.test",
        "--base-url", "https://x.test/",
        "--dir", dir, "--json",
      ],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_MISSION_TARGET_ADD");
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("mission target promote of an unknown id fails with E_UNKNOWN_MISSION_TARGET and a non-zero exit", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dir = await newTargetsDir();
    const { program, lines } = newProgram();
    await program.parseAsync(
      ["mission", "target", "promote", "nope", "--dir", dir, "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_UNKNOWN_MISSION_TARGET" } });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
