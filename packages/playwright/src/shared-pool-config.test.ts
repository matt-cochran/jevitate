import { afterAll, describe, expect, it } from "vitest";
import { closeSharedBrowserPool, configureSharedBrowserPool, sharedBrowserPool } from "./playwright-browser-port.js";

describe("configureSharedBrowserPool — a harness can own the shared pool's admission", () => {
  afterAll(async () => {
    await closeSharedBrowserPool();
  });

  it("applies the overrides when the pool is created, and refuses once it exists", () => {
    configureSharedBrowserPool({ maxContexts: 3, signals: { sample: async () => ({ memAvailableBytes: 1e12, source: "fixed" }) } });
    const pool = sharedBrowserPool();
    expect(pool.maxContexts).toBe(3);
    expect(() => configureSharedBrowserPool({ maxContexts: 5 })).toThrow(/already exists/);
  });
});
