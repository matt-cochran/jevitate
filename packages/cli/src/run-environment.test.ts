import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { RunExplorationOptions, RunExplorationResult } from "./explore-goal.js";
import { stampRunMetadata } from "./run-metadata.js";
import { recordAcceptedLocalDevCert, resetRunEnvironment } from "./run-environment.js";

/**
 * #872 follow-up — a run that accepted a local dev server's certificate says so in its result:
 * `localDevCerts: [origin, …]`, stamped by `stampRunMetadata` on every emitted and persisted
 * result (beside its tags and target). Absent when the flag was not used.
 */

vi.mock("./explore-goal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./explore-goal.js")>();
  return {
    ...real,
    runExploration: vi.fn(async (_opts: RunExplorationOptions): Promise<RunExplorationResult> =>
      ({
        goalOutcome: "succeeded",
        outcome: "succeeded",
        defectOutcome: { status: "none", byKind: {} },
        stop: "done",
        runOutcome: { status: "completed", verifiedBy: "success-condition" },
        checks: [{ check: "urlIncludes:/done", passed: true, detail: "held" }],
        decisions: 1,
        actions: 1,
        finalUrl: "https://localhost:5173/done",
      }) as unknown as RunExplorationResult),
  };
});

const { buildProgram } = await import("./program.js");

afterEach(() => {
  resetRunEnvironment();
  process.exitCode = undefined;
});

async function explore(extra: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  const dir = join(tmpdir(), "jev-run-env");
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir: join(dir, "journeys"),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const overrideExit = (c: ReturnType<typeof buildProgram>): void => {
    c.exitOverride();
    for (const child of c.commands) overrideExit(child);
  };
  overrideExit(program);
  await program.parseAsync(
    ["explore", "--url", "https://localhost:5173/", "--goal", "g", "--success", "urlIncludes:/done", "--fake-ai", "--json", ...extra],
    { from: "user" },
  );
  return JSON.parse(out.join("")).data as Record<string, unknown>;
}

describe("the result records accepted local dev certificates (#872)", () => {
  it("names the accepted origin", async () => {
    const data = await explore(["--accept-local-dev-cert", "https://localhost:5173"]);
    expect(data["localDevCerts"]).toEqual(["https://localhost:5173"]);
  });

  it("has no localDevCerts when the flag was not used", async () => {
    const data = await explore([]);
    expect("localDevCerts" in data).toBe(false);
  });

  it("a later program does not inherit an earlier run's origins", async () => {
    await explore(["--accept-local-dev-cert", "https://localhost:5173"]);
    const data = await explore([]);
    expect("localDevCerts" in data).toBe(false);
  });
});

describe("stampRunMetadata", () => {
  it("stamps the recorded origins on a result", () => {
    recordAcceptedLocalDevCert("https://127.0.0.1:8443");
    expect(stampRunMetadata({ a: 1 }, undefined)).toMatchObject({ a: 1, localDevCerts: ["https://127.0.0.1:8443"] });
  });

  it("a result with nothing recorded gains no localDevCerts", () => {
    expect("localDevCerts" in (stampRunMetadata({ a: 1 }, undefined) as object)).toBe(false);
  });

  it("records an origin once", () => {
    recordAcceptedLocalDevCert("https://127.0.0.1:8443");
    recordAcceptedLocalDevCert("https://127.0.0.1:8443");
    expect((stampRunMetadata({}, undefined) as { localDevCerts?: string[] }).localDevCerts).toEqual(["https://127.0.0.1:8443"]);
  });
});
