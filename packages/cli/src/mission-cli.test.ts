import { expect, test } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import {
  FsMissionQueueStore,
  FsMissionTargetStore,
  MissionTargetRegistry,
  UnknownOrUnpromotedMissionTargetError,
  enqueueMission,
} from "@jevitate/missions";
import { buildProgram } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { currentEngineInfo } from "./engine.js";
import { writeMissionResult } from "./mission-journal.js";
import type { QueuedMissionExecutor, QueuedMissionSpec } from "./mission-queue-runner.js";

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

// ---------------------------------------------------------------------------
// #117 — `mission target add --api-origin` and `mission run` (the queue drain).
// The executor is injected, so no browser opens; everything else (queue, targets,
// result files, the MCP read-back) is the real fs-backed wiring.
// ---------------------------------------------------------------------------

test("mission target add --api-origin declares extra authorized origins; a malformed origin is refused", async () => {
  const dir = await newTargetsDir();
  const { program, lines } = newProgram();
  await program.parseAsync(
    [
      "mission", "target", "add", "spa",
      "--name", "SPA",
      "--authorized-origin", "http://127.0.0.1:5193",
      "--api-origin", "http://127.0.0.1:18582",
      "--api-origin", "http://127.0.0.1:18583",
      "--base-url", "http://127.0.0.1:5193/settings",
      "--dir", dir, "--json",
    ],
    { from: "user" },
  );
  expect(JSON.parse(lines.join(""))).toMatchObject({
    ok: true,
    data: { apiOrigins: ["http://127.0.0.1:18582", "http://127.0.0.1:18583"] },
  });

  const savedExitCode = process.exitCode;
  try {
    const { program: p2, lines: l2 } = newProgram();
    await p2.parseAsync(
      [
        "mission", "target", "add", "bad",
        "--name", "Bad",
        "--authorized-origin", "http://127.0.0.1:5193",
        "--api-origin", "http://127.0.0.1:18582/api",
        "--base-url", "http://127.0.0.1:5193/",
        "--dir", dir, "--json",
      ],
      { from: "user" },
    );
    expect(JSON.parse(l2.join(""))).toMatchObject({ ok: false, error: { code: "E_MISSION_TARGET_ADD" } });
  } finally {
    process.exitCode = savedExitCode;
  }
});

async function missionRunFixture() {
  const root = await mkdtemp(join(tmpdir(), "jevitate-mission-run-"));
  const targetsDir = join(root, "targets");
  const queueDir = join(root, "queue");
  const recordingsDir = join(root, "recordings");
  const store = new FsMissionTargetStore(targetsDir);
  const registry = new MissionTargetRegistry(store);
  await registry.put({
    id: "spa",
    name: "SPA",
    authorizedOrigin: "http://127.0.0.1:5193",
    apiOrigins: ["http://127.0.0.1:18582"],
    baseUrl: "http://127.0.0.1:5193/settings",
    promoted: true,
    createdAtIso: "2026-09-24T00:00:00Z",
  });
  const queue = new FsMissionQueueStore(queueDir);
  let n = 0;
  const enqueue = (req: Record<string, unknown>) =>
    enqueueMission(registry, queue, { target: "spa", ...req }, { clock: () => `2026-09-24T00:00:0${n++}.000Z` });
  const specs: QueuedMissionSpec[] = [];
  let stamp = 0;
  const execute: QueuedMissionExecutor = async (spec) => {
    specs.push(spec);
    const prefix = spec.mission.strategy === "goal-based" ? "explore" : spec.mission.strategy;
    const recordingPath = join(recordingsDir, `${prefix}-2026-09-24T00-00-0${stamp++}-000Z.json`);
    await mkdir(recordingsDir, { recursive: true });
    const outcome = spec.mission.strategy === "goal-based" ? "succeeded" : "clean";
    return { resultPath: writeMissionResult(recordingPath, outcome, 0, { outcome }), missionOutcome: outcome, exitCode: 0 };
  };
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager("/unused-in-these-tests"), missions: { execute } });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(["mission", "run", "--dir", queueDir, "--targets-dir", targetsDir, "--json", ...args], { from: "user" });
    return JSON.parse(lines.join(""));
  };
  return { store, registry, queue, queueDir, recordingsDir, enqueue, specs, run };
}

test("mission run --once drains every queued strategy; get_mission_result {id: missionId} then reads each result", async () => {
  const savedExitCode = process.exitCode;
  try {
    const f = await missionRunFixture();
    const goal = await f.enqueue({ strategy: "goal-based", goal: "find the plan", successAssertion: { kind: "urlIncludes", text: "/settings" } });
    const coverage = await f.enqueue({ strategy: "coverage", route: "/settings/**" });
    const adversarial = await f.enqueue({ strategy: "adversarial" });
    const feature = await f.enqueue({ strategy: "feature", feature: "billing" });

    const env = await f.run(["--once", "--fake-ai"]);
    expect(env).toMatchObject({ v: 1, ok: true, data: { skipped: [], engine: currentEngineInfo() } });
    expect(env.data.ran.map((m: { missionId: string }) => m.missionId)).toEqual([goal.id, coverage.id, adversarial.id, feature.id]);
    expect(env.data.ran.every((m: { status: string }) => m.status === "done")).toBe(true);
    expect(process.exitCode).toBe(0);

    // Each run was confined to the target's own origins (app + declared API) and started at its baseUrl.
    for (const spec of f.specs) {
      expect(spec.allowlist).toEqual(["http://127.0.0.1:5193", "http://127.0.0.1:18582"]);
      expect(spec.target.baseUrl).toBe("http://127.0.0.1:5193/settings");
    }

    const tool = buildMcpTools({ journeysDir: "/unused", recordingsDir: f.recordingsDir, missionQueueDir: f.queueDir }).find(
      (t) => t.name === "get_mission_result",
    )!;
    for (const m of [goal, coverage, adversarial, feature]) {
      const record = await f.queue.get(m.id);
      expect(record).toMatchObject({ status: "done", exitCode: 0 });
      const r = await tool.handler({ id: m.id });
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0]!.text)).toMatchObject({ missionId: m.id, resultId: record!.resultId, status: "clean" });
    }

    // A second drain finds nothing left to run — a done mission never runs twice.
    const again = await f.run(["--once", "--fake-ai"]);
    expect(again.data.ran).toEqual([]);
    expect(f.specs).toHaveLength(4);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("mission run without a gateway selection runs only model-free missions; the rest stay queued", async () => {
  const savedExitCode = process.exitCode;
  try {
    const f = await missionRunFixture();
    const goal = await f.enqueue({ strategy: "goal-based", goal: "g", successAssertion: { kind: "urlIncludes", text: "/x" } });
    const feature = await f.enqueue({ strategy: "feature", feature: "billing" });
    const env = await f.run([]);
    expect(env.data.ran).toMatchObject([{ missionId: feature.id, status: "done" }]);
    expect(env.data.skipped).toMatchObject([{ missionId: goal.id, reason: expect.stringContaining("needs a model gateway") }]);
    expect(await f.queue.get(goal.id)).toMatchObject({ status: "queued" });
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("mission run marks a mission failed (exit 1) when its target is no longer promoted — it never runs", async () => {
  const savedExitCode = process.exitCode;
  try {
    const f = await missionRunFixture();
    const m = await f.enqueue({ strategy: "feature", feature: "billing" });
    const target = (await f.store.get("spa"))!;
    await f.store.put({ ...target, promoted: false });
    const env = await f.run(["--once"]);
    expect(env.data.ran).toMatchObject([{ missionId: m.id, status: "failed", error: "unknown or unpromoted mission target" }]);
    expect(await f.queue.get(m.id)).toMatchObject({ status: "failed", error: "unknown or unpromoted mission target" });
    expect(f.specs).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("mission run refuses --once together with --watch", async () => {
  const savedExitCode = process.exitCode;
  try {
    const f = await missionRunFixture();
    const env = await f.run(["--once", "--watch"]);
    expect(env).toMatchObject({ ok: false, error: { code: "E_MISSION_RUN_ARGS" } });
  } finally {
    process.exitCode = savedExitCode;
  }
});
