import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsMissionTargetStore } from "./target-store.js";
import { MissionTargetRegistry } from "./target-registry.js";
import { UnknownOrUnpromotedMissionTargetError } from "./errors.js";
import type { MissionTarget } from "./schema.js";

function mkTarget(id: string, promoted: boolean): MissionTarget {
  return {
    id,
    name: id,
    authorizedOrigin: "https://demo.example.com",
    baseUrl: "https://demo.example.com",
    promoted,
    createdAtIso: "2026-09-20T00:00:00Z",
  };
}

async function buildRegistry(): Promise<MissionTargetRegistry> {
  const dir = mkdtempSync(join(tmpdir(), "mtr-"));
  const store = new FsMissionTargetStore(dir);
  const reg = new MissionTargetRegistry(store);
  await reg.put(mkTarget("demo-shop", true));
  await reg.put(mkTarget("staging-shop", false));
  return reg;
}

describe("MissionTargetRegistry.resolve", () => {
  it("resolves a known, promoted target", async () => {
    const reg = await buildRegistry();
    const target = await reg.resolve("demo-shop");
    expect(target.id).toBe("demo-shop");
  });

  it("refuses a known but unpromoted target", async () => {
    const reg = await buildRegistry();
    await expect(reg.resolve("staging-shop")).rejects.toBeInstanceOf(
      UnknownOrUnpromotedMissionTargetError,
    );
  });

  it("refuses a nonexistent target with the SAME error (non-distinguishing, no enumeration)", async () => {
    const reg = await buildRegistry();
    let unpromotedMessage = "";
    let nonexistentMessage = "";
    try {
      await reg.resolve("staging-shop");
    } catch (err) {
      unpromotedMessage = (err as Error).message;
    }
    try {
      await reg.resolve("nonexistent");
    } catch (err) {
      nonexistentMessage = (err as Error).message;
    }
    expect(nonexistentMessage).toBe(unpromotedMessage);
  });

  it("promote() flips the flag so resolve() succeeds", async () => {
    const reg = await buildRegistry();
    await reg.promote("staging-shop");
    const target = await reg.resolve("staging-shop");
    expect(target.id).toBe("staging-shop");
  });
});
