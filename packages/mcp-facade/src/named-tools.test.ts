import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { ALLOWED_TOOLS, listNamedJourneyTools } from "./index.js";

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

describe("0.30.0 #797: queue_journey and the named Journey tools", () => {
  it("a promoted Journey's named tool never shadows an allowlisted tool; queue_journey is a domain tool, not a Journey", async () => {
    const reg = await buildRegistry();
    await reg.put(makeJourney("queue_journey", true, []));
    const names = (await listNamedJourneyTools(reg)).map((t) => t.name);
    expect(ALLOWED_TOOLS as readonly string[]).toContain("queue_journey");
    // The named tools are the promoted Journeys, by id; they are not what the server serves.
    expect(names.sort()).toEqual(["checkout", "queue_journey"]);
  });
});
