import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteSource } from "./remote-source.js";
import { canonicalJourneyHash } from "./hash.js";

const PIN = "a".repeat(40);

function mkClone(sites: any[], journeys: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "remote-"));
  mkdirSync(join(dir, "journeys"), { recursive: true });
  writeFileSync(join(dir, "jevitate.json"), JSON.stringify({ version: 1, source: "jevitate-gmail", sites }));
  for (const j of journeys) {
    writeFileSync(join(dir, "journeys", `${j.metadata.id}.journey.json`), JSON.stringify(j));
  }
  return dir;
}

const inboxJourney = {
  metadata: { id: "read-inbox", name: "read-inbox", promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
  recording: {
    version: "1",
    site: "mail.example.com",
    pages: [{ url: "/", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/inbox" } } }] }],
  },
  declaredOrigins: ["https://mail.example.com"],
};

const undeclaredOriginJourney = {
  metadata: { id: "sneaky", name: "sneaky", promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
  recording: { version: "1", site: "evil.example.com", pages: [] },
  declaredOrigins: ["https://evil.example.com"],
};

describe("RemoteSource", () => {
  it("list() returns source-tagged, risk-classified journeys with the pin", async () => {
    const dir = mkClone([{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }], [inboxJourney]);
    const source = new RemoteSource("gmail", dir, PIN);
    const list = await source.list();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("gmail");
    expect(list[0].pin).toBe(PIN);
    expect(list[0].riskClass).toBe("read-only");
    expect(list[0].trusted).toBe(false);
    expect(list[0].contentHash).toBe(canonicalJourneyHash(inboxJourney));
  });

  it("excludes a journey whose declaredOrigins is absent from the manifest's sites (fail-closed, FMECA #4 basis)", async () => {
    const dir = mkClone(
      [{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }],
      [inboxJourney, undeclaredOriginJourney],
    );
    const source = new RemoteSource("gmail", dir, PIN);
    const list = await source.list();
    expect(list.map((m) => m.id)).toEqual(["read-inbox"]);
  });

  it("get() returns the tagged journey by id even if excluded from list (run-gate decides refusal)", async () => {
    const dir = mkClone([{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }], [undeclaredOriginJourney]);
    const source = new RemoteSource("gmail", dir, PIN);
    const sourced = await source.get("sneaky");
    expect(sourced).not.toBeNull();
    expect(sourced!.meta.source).toBe("gmail");
  });

  it("get() returns null for an unknown id", async () => {
    const dir = mkClone([{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }], [inboxJourney]);
    const source = new RemoteSource("gmail", dir, PIN);
    expect(await source.get("nope")).toBeNull();
  });
});
