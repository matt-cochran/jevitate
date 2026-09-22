import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { Secret } from "./secret.js";

describe("Secret", () => {
  it("reveal() returns the wrapped plaintext", () => {
    expect(new Secret("hunter2").reveal()).toBe("hunter2");
  });

  it("throws on toString() (template-literal interpolation)", () => {
    expect(() => `${new Secret("hunter2")}`).toThrow(/must not be serialized/);
  });

  it("throws on JSON.stringify()", () => {
    expect(() => JSON.stringify({ s: new Secret("hunter2") })).toThrow(/must not be serialized/);
  });

  it("throws on util.inspect() (the console.log path)", () => {
    expect(() => inspect(new Secret("hunter2"))).toThrow(/must not be logged/);
  });
});
