import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@doit/journey";
import { LocalSource } from "./local-source.js";
import { RemoteSource } from "./remote-source.js";
import { FsTrustStore } from "./trust.js";
import { FederatedJourneyRegistry } from "./federated-registry.js";
import { UnknownSourceError } from "./errors.js";

const PIN = "a".repeat(40);

function mkRemoteClone() {
  const dir = mkdtempSync(join(tmpdir(), "remote-"));
  mkdirSync(join(dir, "journeys"), { recursive: true });
  writeFileSync(
    join(dir, "jevitate.json"),
    JSON.stringify({
      version: 1,
      source: "jevitate-gmail",
      sites: [{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }],
    }),
  );
  writeFileSync(
    join(dir, "journeys", "checkout.journey.json"),
    JSON.stringify({
      metadata: { id: "checkout", name: "checkout", promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
      recording: { version: "1", site: "mail.example.com", pages: [] },
      declaredOrigins: ["https://mail.example.com"],
    }),
  );
  return dir;
}

async function mkLocalRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "local-"));
  const registry = new JourneyRegistry(new FsJourneyStore(dir));
  await registry.put({
    metadata: { id: "checkout", name: "checkout", promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: { version: "1", site: "example", pages: [] },
  } as any);
  return registry;
}

describe("FederatedJourneyRegistry", () => {
  it("find('') merges a LocalSource + a fixture RemoteSource, tagged and addressed, no collision on shared bare id", async () => {
    const local = new LocalSource("local", await mkLocalRegistry());
    const remote = new RemoteSource("gmail", mkRemoteClone(), PIN);
    const trust = new FsTrustStore(mkdtempSync(join(tmpdir(), "trust-")));
    const fed = new FederatedJourneyRegistry([local, remote], trust);

    const results = await fed.find("");
    expect(results).toHaveLength(2);
    const addresses = results.map((m) => `${m.source}/${m.id}`).sort();
    expect(addresses).toEqual(["gmail/checkout", "local/checkout"]);

    const localResult = results.find((m) => m.source === "local")!;
    const remoteResult = results.find((m) => m.source === "gmail")!;
    expect(localResult.trusted).toBe(true);
    expect(remoteResult.trusted).toBe(false); // no TrustRecord recorded
    expect(remoteResult.pin).toBe(PIN);
  });

  it("get('gmail/checkout') resolves via the correct source", async () => {
    const local = new LocalSource("local", await mkLocalRegistry());
    const remote = new RemoteSource("gmail", mkRemoteClone(), PIN);
    const trust = new FsTrustStore(mkdtempSync(join(tmpdir(), "trust-")));
    const fed = new FederatedJourneyRegistry([local, remote], trust);

    const sourced = await fed.get("gmail/checkout");
    expect(sourced?.meta.source).toBe("gmail");
  });

  it("get('nosuchsource/x') throws UnknownSourceError", async () => {
    const local = new LocalSource("local", await mkLocalRegistry());
    const trust = new FsTrustStore(mkdtempSync(join(tmpdir(), "trust-")));
    const fed = new FederatedJourneyRegistry([local], trust);
    await expect(fed.get("nosuchsource/x")).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("a recorded TrustRecord upgrades a remote journey's trusted flag when the hash matches", async () => {
    const remote = new RemoteSource("gmail", mkRemoteClone(), PIN);
    const trustDir = mkdtempSync(join(tmpdir(), "trust-"));
    const trust = new FsTrustStore(trustDir);
    const fed = new FederatedJourneyRegistry([remote], trust);

    const before = await fed.find("");
    expect(before[0].trusted).toBe(false);

    await trust.put({
      sourceId: "gmail",
      journeyId: "checkout",
      contentHash: before[0].contentHash,
      approvedBy: "matthew@outboundlabs.com",
      approvedAtIso: "2026-09-20T00:00:00Z",
    });

    const after = await fed.find("");
    expect(after[0].trusted).toBe(true);
  });
});
