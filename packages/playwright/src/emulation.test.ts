import { describe, expect, test } from "vitest";
import {
  ConflictingEmulationError,
  UnknownDeviceError,
  closestDeviceNames,
  emulationContextOptions,
  parseViewport,
  resolveEmulation,
} from "./emulation.js";

describe("parseViewport", () => {
  test("parses WxH", () => {
    expect(parseViewport("375x812")).toEqual({ width: 375, height: 812 });
  });

  test("rejects malformed input", () => {
    expect(() => parseViewport("375")).toThrow(RangeError);
    expect(() => parseViewport("375×812")).toThrow(RangeError);
    expect(() => parseViewport("0x812")).toThrow(RangeError);
  });
});

describe("resolveEmulation", () => {
  test("undefined spec resolves to undefined (Playwright's default viewport)", () => {
    expect(resolveEmulation(undefined)).toBeUndefined();
  });

  test("a bare viewport resolves to just that viewport", () => {
    expect(resolveEmulation({ viewport: { width: 375, height: 812 } })).toEqual({ viewport: { width: 375, height: 812 } });
  });

  test("a known device resolves viewport + deviceScaleFactor + isMobile + hasTouch + userAgent", () => {
    const resolved = resolveEmulation({ device: "iPhone 13" });
    expect(resolved?.device).toBe("iPhone 13");
    expect(resolved?.viewport).toEqual({ width: 390, height: 664 });
    expect(resolved?.isMobile).toBe(true);
    expect(resolved?.hasTouch).toBe(true);
    expect(resolved?.deviceScaleFactor).toBeGreaterThan(1);
    expect(resolved?.userAgent).toMatch(/iPhone/);
  });

  test("an unknown device is refused before any browser opens, with close matches", () => {
    expect(() => resolveEmulation({ device: "Nokia 9000" })).toThrow(UnknownDeviceError);
    try {
      resolveEmulation({ device: "iPhone 13 Pr" });
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownDeviceError);
      expect((e as Error).message).toContain("iPhone 13");
    }
  });

  test("viewport + device together is refused (mutually exclusive)", () => {
    expect(() => resolveEmulation({ viewport: { width: 375, height: 812 }, device: "iPhone 13" })).toThrow(ConflictingEmulationError);
  });
});

describe("closestDeviceNames", () => {
  test("ranks near matches first", () => {
    const close = closestDeviceNames("iPhone 13", 3, ["iPhone 13", "iPhone 13 Pro", "iPhone 12", "Pixel 5"]);
    expect(close[0]).toBe("iPhone 13");
  });
});

describe("emulationContextOptions", () => {
  test("carries only the fields a resolved emulation set", () => {
    expect(emulationContextOptions({ viewport: { width: 375, height: 812 } })).toEqual({ viewport: { width: 375, height: 812 } });
  });
});
