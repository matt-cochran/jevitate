import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { runCheck, type CheckRunners } from "./check-api.js";
import { parseSuite } from "./check-suite.js";

/**
 * #563 part 1: a Journey item's `params` value may be a `{ "unique": "<template>" }` object whose
 * template contains `{run}`. At execution the template's `{run}` becomes a fresh per-run token, so a
 * committed create-style suite (a sign-up that invents `inv-{run}@example.test`) runs repeatedly.
 */

const journey = (): Journey => ({
  metadata: { id: "invite", name: "Invite", promoted: true, params: ["email"], createdAtIso: "2026-10-09T00:00:00.000Z" },
  recording: {
    version: "1.0.0",
    site: "https://shop.example",
    pages: [{ url: "/invite", steps: [{ step: { kind: "navigate", url: "/invite", expect: { kind: "urlIncludes", text: "/invite" } } }] }],
  },
});

const rawSuite = (params: unknown) => ({
  version: 1,
  name: "s",
  targets: [{ name: "shop", url: "https://shop.example/invite", journeys: [{ id: "invite", params }] }],
});

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jev-check-563-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") }));
  await new FsJourneyStore(dir).put(journey());
});
afterEach(() => {
  resetClock();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake Journey runner: records the run options it was handed; every run is `ok`. */
function capture(sink: Array<Record<string, unknown>>): CheckRunners["journey"] {
  return (async (o: Record<string, unknown>) => {
    sink.push(o);
    return { outcome: "ok", output: {} };
  }) as unknown as CheckRunners["journey"];
}

/** Runs the suite once through the public `runCheck` and returns the params the runner saw and the recorded result. */
async function runOnce(out: string): Promise<{ passed: Record<string, string>; recorded: Record<string, string> }> {
  const sink: Array<Record<string, unknown>> = [];
  const suite = parseSuite(rawSuite({ email: { unique: "inv-{run}@example.test" } }), join(dir, "suite.json"));
  const r = await runCheck({ suite, outDir: join(dir, out), journeysDir: dir, runners: { journey: capture(sink) }, projectDir: null });
  const passed = sink[0]?.params as Record<string, string>;
  const record = JSON.parse(readFileSync(r.results[0]!, "utf8")) as { result: { params?: Record<string, string> } };
  return { passed, recorded: record.result.params ?? {} };
}

describe("#563: unique journey params", () => {
  it("parses a unique param object beside a plain string param", () => {
    const s = parseSuite(rawSuite({ email: { unique: "inv-{run}@example.test" }, sku: "A1" }), join(dir, "suite.json"));
    expect(s.targets[0]?.journeys[0]?.params).toEqual({ email: { unique: "inv-{run}@example.test" }, sku: "A1" });
  });

  it("refuses a unique template without {run}, naming the journey entry and param", () => {
    expect(() => parseSuite(rawSuite({ email: { unique: "inv@example.test" } }), join(dir, "suite.json"))).toThrow(
      /\$\.targets\[0\]\.journeys\[0\]\.params\.email: .*\{run\}/,
    );
  });

  it("refuses a unique param object with any other key, naming the journey entry and param", () => {
    expect(() => parseSuite(rawSuite({ email: { Unique: "inv-{run}@example.test" } }), join(dir, "suite.json"))).toThrow(
      /\$\.targets\[0\]\.journeys\[0\]\.params\.email: must be a string or/,
    );
  });

  it("resolves a unique template to a different value on each suite run", async () => {
    const a = await runOnce("out-a");
    const b = await runOnce("out-b");
    expect(a.passed.email).not.toBe(b.passed.email);
  });

  it("passes the resolved unique value to the journey run and records the same value", async () => {
    const { passed, recorded } = await runOnce("out");
    expect(recorded.email).toBe(passed.email);
  });
});
