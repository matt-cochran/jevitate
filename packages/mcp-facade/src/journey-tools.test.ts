import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { JourneyRunner } from "@jevitate/runtime";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { safeRunPolicy } from "@jevitate/domain";
import { findCapabilities, runJourney } from "./index.js";

function makeJourney(id: string, promoted: boolean): Journey {
  return {
    metadata: {
      id,
      name: id,
      description: `${id} journey`,
      promoted,
      params: ["qty"],
      createdAtIso: new Date().toISOString(),
    },
    recording: {
      version: "1",
      site: "example",
      pages: [
        {
          url: "/checkout",
          steps: [
            {
              step: {
                kind: "fill",
                target: { css: "#qty" },
                value: { var: "qty" },
                expect: { kind: "urlIncludes", text: "/checkout" },
              },
              variableName: "qty",
            },
          ],
        },
      ],
    } as any,
  };
}

async function buildRegistry(): Promise<JourneyRegistry> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-facade-journey-"));
  const store = new FsJourneyStore(dir);
  const reg = new JourneyRegistry(store);
  await reg.put(makeJourney("checkout", true));
  await reg.put(makeJourney("login", false));
  return reg;
}

describe("two-level MCP journey tools", () => {
  it("#6 find_capabilities returns only promoted capabilities with their params", async () => {
    const reg = await buildRegistry();
    const result = await findCapabilities(reg, "");
    expect(result).toEqual([
      { id: "checkout", name: "checkout", description: "checkout journey", params: ["qty"] },
    ]);
  });

  it("#5 run_journey rejects an unknown/unpublished id (no inline steps)", async () => {
    const reg = await buildRegistry();
    const runner = new JourneyRunner({} as any, new RecordingInterpreter());
    await expect(runJourney(reg, runner, "does-not-exist", {}, safeRunPolicy())).rejects.toThrow(
      /unknown|not found/i,
    );
  });

  it("#5 run_journey rejects an unpromoted id", async () => {
    const reg = await buildRegistry();
    const runner = new JourneyRunner({} as any, new RecordingInterpreter());
    await expect(runJourney(reg, runner, "login", {}, safeRunPolicy())).rejects.toThrow(
      /unknown|not found|unpublished/i,
    );
  });

  it("#5 run_journey rejects unknown params", async () => {
    const reg = await buildRegistry();
    const runner = new JourneyRunner({} as any, new RecordingInterpreter());
    await expect(
      runJourney(reg, runner, "checkout", { bogus: "1" }, safeRunPolicy()),
    ).rejects.toThrow(/unknown/);
  });
});
