import { describe, expect, it } from "vitest";
import { drainExitCode } from "./mission-queue-runner.js";
import { mcpToolDeps } from "./mcp-cli-bridge.js";

/** GAPS 23: `mission run`'s exit code counts its drained Journey calls, the worst by the missions' severity order. */

const mission = (status: "done" | "failed") => ({ status }) as never;
const call = (status: "done" | "failed", exitCode?: number) => ({ callId: "c", journey: "j", status, ...(exitCode === undefined ? {} : { exitCode }) });

describe("drainExitCode", () => {
  it("is 0 when everything ran clean, whatever a mission's own outcome", () => {
    expect(drainExitCode({ ran: [mission("done")], journeys: [call("done", 0)] })).toBe(0);
    expect(drainExitCode({ ran: [], journeys: undefined } as never)).toBe(0);
  });

  it("2 beats 0: a mission or a call that could not run, an unverified pass, a call with no exit code", () => {
    expect(drainExitCode({ ran: [mission("failed")], journeys: [call("done", 0)] })).toBe(2);
    expect(drainExitCode({ ran: [mission("done")], journeys: [call("failed")] })).toBe(2);
    expect(drainExitCode({ ran: [], journeys: [call("done", 0), call("done", 2)] })).toBe(2);
    expect(drainExitCode({ ran: [], journeys: [call("done")] })).toBe(2);
  });

  it("follows the severity order: inconclusive (2) beats a defect (1), a defect beats a pending review (5)", () => {
    expect(drainExitCode({ ran: [], journeys: [call("done", 1), call("done", 0)] })).toBe(1);
    expect(drainExitCode({ ran: [], journeys: [call("done", 1), call("done", 2)] })).toBe(2);
    expect(drainExitCode({ ran: [], journeys: [call("done", 5), call("done", 1)] })).toBe(1);
    expect(drainExitCode({ ran: [], journeys: [call("done", 5), call("done", 0)] })).toBe(5);
  });
});

describe("mcpToolDeps", () => {
  it("GAPS 23: passes the CLI's catalog dir to the MCP tools (run_journey's done check)", () => {
    expect(mcpToolDeps({ profiles: {} as never, catalogDir: "/somewhere/.jevitate" }).catalogDir).toBe("/somewhere/.jevitate");
    expect(mcpToolDeps({ profiles: {} as never })).not.toHaveProperty("catalogDir");
  });
});
