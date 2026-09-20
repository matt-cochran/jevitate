import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@doit/journey";
import { listNamedJourneyTools } from "./index.js";

function makeJourney(id: string, promoted: boolean, params: string[] = ["qty"]): Journey {
  return {
    metadata: {
      id,
      name: id,
      description: `${id} journey`,
      promoted,
      params,
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
  const dir = mkdtempSync(join(tmpdir(), "nt-"));
  const store = new FsJourneyStore(dir);
  const reg = new JourneyRegistry(store);
  await reg.put(makeJourney("checkout", true, ["qty"]));
  await reg.put(makeJourney("login", false, []));
  return reg;
}

describe("listNamedJourneyTools", () => {
  it("#6 returns only promoted journeys as named tools with JSON-schema inputSchema", async () => {
    const reg = await buildRegistry();
    const result = await listNamedJourneyTools(reg);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "checkout",
      description: "checkout journey",
      inputSchema: {
        type: "object",
        properties: { qty: { type: "string" } },
        required: ["qty"],
      },
    });
  });

  it("#6 unpromoted journeys produce no tool", async () => {
    const reg = await buildRegistry();
    const result = await listNamedJourneyTools(reg);
    const names = result.map((t) => t.name);
    expect(names).not.toContain("login");
  });
});
