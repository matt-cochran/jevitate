import { describe, expect, it } from "vitest";
import { reviewRenderOptions } from "./review-render-options.js";

const tty = { isTTY: true, columns: 132, env: {} };

describe("reviewRenderOptions (#496)", () => {
  it("uses the terminal width on a TTY", () => {
    expect(reviewRenderOptions({}, tty).width).toBe(132);
  });
  it("defaults the width to 100 when stdout is not a TTY", () => {
    expect(reviewRenderOptions({}, { isTTY: false, columns: 132, env: {} }).width).toBe(100);
  });
  it("defaults the width to 100 when a TTY reports no columns", () => {
    expect(reviewRenderOptions({}, { isTTY: true, env: {} }).width).toBe(100);
  });
  it("colours on a TTY", () => {
    expect(reviewRenderOptions({}, tty).color).toBe(true);
  });
  it("does not colour a pipe", () => {
    expect(reviewRenderOptions({}, { isTTY: false, env: {} }).color).toBe(false);
  });
  it("does not colour when NO_COLOR is set", () => {
    expect(reviewRenderOptions({}, { ...tty, env: { NO_COLOR: "1" } }).color).toBe(false);
  });
  it("colours when NO_COLOR is empty", () => {
    expect(reviewRenderOptions({}, { ...tty, env: { NO_COLOR: "" } }).color).toBe(true);
  });
  it("never colours a file written with --out", () => {
    expect(reviewRenderOptions({ toFile: true }, tty).color).toBe(false);
  });
  it("passes full through", () => {
    expect(reviewRenderOptions({ full: true }, tty).full).toBe(true);
  });
  it("omits full when not asked", () => {
    expect(reviewRenderOptions({}, tty).full).toBeUndefined();
  });
});
