import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@doit/journey";
import { LocalSource } from "./local-source.js";

const rec = (steps: any[] = []) => ({
  version: "1",
  site: "example",
  pages: [{ url: "/", steps: steps.map((s) => ({ step: s })) }],
});

const mk = (id: string, promoted: boolean, steps: any[] = []) => ({
  metadata: { id, name: id, promoted, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
  recording: rec(steps),
});

describe("LocalSource", () => {
  it("list() returns only promoted journeys, source-tagged with engine-derived risk + contentHash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-"));
    const registry = new JourneyRegistry(new FsJourneyStore(dir));
    await registry.put(mk("login", false) as any);
    await registry.put(mk("checkout", true, [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]) as any);

    const source = new LocalSource("local", registry);
    const list = await source.list();

    expect(list.map((m) => m.id)).toEqual(["checkout"]);
    expect(list[0].source).toBe("local");
    expect(list[0].trusted).toBe(true);
    expect(list[0].riskClass).toBe("read-only");
    expect(list[0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(list[0].pin).toBeUndefined();
  });

  it("get() returns the SourcedJourney with the file and tagged meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-"));
    const registry = new JourneyRegistry(new FsJourneyStore(dir));
    await registry.put(mk("checkout", true, [{ kind: "click", target: { testId: "buy" }, expect: { kind: "urlIncludes", text: "/x" } }]) as any);

    const source = new LocalSource("local", registry);
    const sourced = await source.get("checkout");

    expect(sourced).not.toBeNull();
    expect(sourced!.meta.riskClass).toBe("risky");
    expect(sourced!.file.metadata.id).toBe("checkout");
    expect(sourced!.file.declaredOrigins.length).toBeGreaterThan(0);
  });

  it("get() returns null for an unknown id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-"));
    const registry = new JourneyRegistry(new FsJourneyStore(dir));
    const source = new LocalSource("local", registry);
    expect(await source.get("nope")).toBeNull();
  });
});
