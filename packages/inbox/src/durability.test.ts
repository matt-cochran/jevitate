import { describe, expect, it, vi } from "vitest";
import { durableWritesEnabled, flushIfDurable } from "./durability.js";

describe("inbox durability switch", () => {
  it("is ON unless explicitly turned off", () => {
    expect(durableWritesEnabled({})).toBe(true);
    expect(durableWritesEnabled({ JEVITATE_DURABLE_WRITES: "on" })).toBe(true);
    expect(durableWritesEnabled({ JEVITATE_DURABLE_WRITES: "off" })).toBe(false);
  });

  it("the test suite runs with it off (vitest.config env), so no test waits on the host's disk flush", async () => {
    expect(process.env.JEVITATE_DURABLE_WRITES).toBe("off");
    const handle = { sync: vi.fn(async () => undefined) };
    await flushIfDurable(handle);
    expect(handle.sync).not.toHaveBeenCalled();
  });
});
