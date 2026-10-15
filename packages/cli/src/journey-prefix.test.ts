import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { JourneyPrefixArgsError, resolveJourneyPrefix } from "./journey-prefix.js";

/** #519: a Journey anchor's region reaches the resolved prefix; a bad one is refused before any browser opens. */

const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };
const ASSERT: Step = { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };

function journey(region: string | undefined): Journey {
  return {
    metadata: {
      id: "wiz",
      name: "wiz",
      promoted: true,
      params: [],
      createdAtIso: "2026-10-15T00:00:00Z",
      anchors: [{ name: "wizard", step: 2, stepId: "s-assrt1", ...(region === undefined ? {} : { region }) }],
    },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: CLICK, stepId: "s-click1" }, { step: ASSERT, stepId: "s-assrt1" }] }] },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-519-prefix-"));
});
const seed = (j: Journey): Promise<void> => writeFile(join(dir, "wiz.json"), JSON.stringify(j));
const request = (atStep: string) => ({ dir, id: "wiz", atStep, params: {} });

describe("resolveJourneyPrefix region (#519)", () => {
  it("carries the named anchor's region", async () => {
    await seed(journey("testId=import-view"));
    expect((await resolveJourneyPrefix(request("wizard"))).region).toEqual({ spec: "testId=import-view", descriptor: { testId: "import-view" } });
  });

  it("carries no region for a numeric --at-step", async () => {
    await seed(journey("testId=import-view"));
    expect((await resolveJourneyPrefix(request("2"))).region).toBeUndefined();
  });

  it("carries no region for an anchor that declares none", async () => {
    await seed(journey(undefined));
    expect((await resolveJourneyPrefix(request("wizard"))).region).toBeUndefined();
  });

  it("refuses an anchor region that does not parse", async () => {
    await seed(journey("Import Wizard"));
    await expect(resolveJourneyPrefix(request("wizard"))).rejects.toBeInstanceOf(JourneyPrefixArgsError);
  });
});
