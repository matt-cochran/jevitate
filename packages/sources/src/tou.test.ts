import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDeclaredTou, surfaceForAck, FsAckStore } from "./tou.js";
import { UndeclaredTouError } from "./errors.js";
import type { JevitateManifest } from "./manifest.js";

const manifest: JevitateManifest = {
  version: 1,
  source: "jevitate-gmail",
  sites: [{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }],
};

describe("requireDeclaredTou", () => {
  it("returns the declaration for a declared origin", () => {
    expect(requireDeclaredTou(manifest, "https://mail.example.com/inbox").touBasis).toBe(
      "https://mail.example.com/tos",
    );
  });

  it("throws UndeclaredTouError for an undeclared origin (FMECA #4)", () => {
    expect(() => requireDeclaredTou(manifest, "https://evil.example.com")).toThrow(UndeclaredTouError);
  });
});

describe("surfaceForAck", () => {
  it("includes the full gitUrl and every touBasis", () => {
    const surfaced = surfaceForAck(manifest, "https://github.com/x/jevitate-gmail");
    expect(surfaced.gitUrl).toBe("https://github.com/x/jevitate-gmail");
    expect(surfaced.sites.map((s) => s.touBasis)).toEqual(["https://mail.example.com/tos"]);
  });
});

describe("FsAckStore", () => {
  it("round-trips an ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ack-"));
    const store = new FsAckStore(dir);
    await store.put({
      sourceName: "gmail",
      gitUrl: "https://github.com/x/jevitate-gmail",
      origins: ["https://mail.example.com"],
      ackedBy: "matthew@outboundlabs.com",
      ackedAtIso: "2026-09-20T00:00:00Z",
    });
    const ack = await store.get("gmail");
    expect(ack?.gitUrl).toBe("https://github.com/x/jevitate-gmail");
  });

  it("get returns null for a source with no recorded ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ack-"));
    const store = new FsAckStore(dir);
    expect(await store.get("nope")).toBeNull();
  });
});
