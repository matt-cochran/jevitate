import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsTrustStore, isTrusted } from "./trust.js";

describe("FsTrustStore", () => {
  it("put+get round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    await store.put({
      sourceId: "gmail",
      journeyId: "read-inbox",
      contentHash: "sha256:aaaa",
      approvedBy: "matthew@outboundlabs.com",
      approvedAtIso: "2026-09-20T00:00:00Z",
    });
    const rec = await store.get("gmail", "read-inbox");
    expect(rec?.contentHash).toBe("sha256:aaaa");
  });

  it("get returns null for an unknown pair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    expect(await store.get("gmail", "nope")).toBeNull();
  });

  it("list() returns all records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    await store.put({ sourceId: "a", journeyId: "x", contentHash: "sha256:1", approvedBy: "m", approvedAtIso: "t" });
    await store.put({ sourceId: "b", journeyId: "y", contentHash: "sha256:2", approvedBy: "m", approvedAtIso: "t" });
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("rejects path-traversal ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    await expect(
      store.put({ sourceId: "../evil", journeyId: "x", contentHash: "sha256:1", approvedBy: "m", approvedAtIso: "t" }),
    ).rejects.toThrow();
    await expect(store.get("gmail", "../evil")).rejects.toThrow();
  });
});

describe("isTrusted", () => {
  it("returns false when no record exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    expect(await isTrusted(store, "gmail", "read-inbox", "sha256:aaaa")).toBe(false);
  });

  it("returns true when the record's hash matches the current hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    await store.put({ sourceId: "gmail", journeyId: "read-inbox", contentHash: "sha256:aaaa", approvedBy: "m", approvedAtIso: "t" });
    expect(await isTrusted(store, "gmail", "read-inbox", "sha256:aaaa")).toBe(true);
  });

  it("returns FALSE when the stored hash differs from the current content hash (TOCTOU close, FMECA #2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const store = new FsTrustStore(dir);
    await store.put({ sourceId: "gmail", journeyId: "read-inbox", contentHash: "sha256:aaaa", approvedBy: "m", approvedAtIso: "t" });
    expect(await isTrusted(store, "gmail", "read-inbox", "sha256:bbbb")).toBe(false);
  });
});
