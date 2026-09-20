import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@doit/journey";
import { LocalSource, FederatedJourneyRegistry, FsTrustStore } from "@doit/sources";
import { findFederatedCapabilities } from "./index.js";

function makeJourney(id: string, promoted: boolean): Journey {
  return {
    metadata: { id, name: id, description: `${id} journey`, promoted, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
    recording: { version: "1", site: "example", pages: [] },
  };
}

async function buildFederated(): Promise<FederatedJourneyRegistry> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-facade-fed-"));
  const store = new FsJourneyStore(dir);
  const reg = new JourneyRegistry(store);
  await reg.put(makeJourney("checkout", true));
  await reg.put(makeJourney("login", false));
  const local = new LocalSource("local", reg);
  const trust = new FsTrustStore(mkdtempSync(join(tmpdir(), "mcp-facade-trust-")));
  return new FederatedJourneyRegistry([local], trust);
}

describe("findFederatedCapabilities", () => {
  it("projects source/pin/riskClass/trusted tags onto a source/id-addressed capability", async () => {
    const fed = await buildFederated();
    const result = await findFederatedCapabilities(fed, "");
    expect(result).toEqual([
      {
        id: "local/checkout",
        name: "checkout",
        description: "checkout journey",
        params: [],
        source: "local",
        pin: undefined,
        riskClass: "read-only",
        trusted: true,
      },
    ]);
  });
});
