import { describe, expect, it } from "vitest";
import { describeCheck } from "@jevitate/explore";
import { parseAssertionSpec, parseSuccessSpec } from "./explore-api.js";

/** #148 — the `--success` visual-state spec syntax: parsed, validated, and round-tripped. */

describe("--success visual-state specs (#148)", () => {
  it("parses style (a property or a channel of one), with styleMatches as an alias", () => {
    expect(parseAssertionSpec("style:#b1|color=rgb(255, 0, 0)")).toEqual({
      kind: "style",
      target: { css: "#b1" },
      property: "color",
      op: "=",
      value: "rgb(255, 0, 0)",
    });
    expect(parseAssertionSpec("styleMatches:[data-heat]|alpha(background-color)>0")).toEqual({
      kind: "style",
      target: { css: "[data-heat]" },
      property: "background-color",
      channel: "alpha",
      op: ">",
      value: "0",
    });
    expect(parseAssertionSpec("style:.ring|px(outline-width) >= 2")).toMatchObject({ channel: "px", op: ">=", value: "2" });
  });

  it("parses geometry, attribute and flash specs", () => {
    expect(parseAssertionSpec("inViewport:#b3")).toEqual({ kind: "inViewport", target: { css: "#b3" } });
    expect(parseAssertionSpec("inViewport:#b3|min=0.9")).toEqual({ kind: "inViewport", target: { css: "#b3" }, min: 0.9 });
    expect(parseAssertionSpec("box:testId=card|minWidth=100,maxHeight=300")).toEqual({
      kind: "box",
      target: { testId: "card" },
      minWidth: 100,
      maxHeight: 300,
    });
    expect(parseAssertionSpec("overlaps:#a|#b")).toEqual({ kind: "overlap", target: { css: "#a" }, other: { css: "#b" }, overlapping: true });
    expect(parseAssertionSpec("noOverlap:#a|#b")).toMatchObject({ kind: "overlap", overlapping: false });
    expect(parseAssertionSpec("attr:#cell|data-active=true")).toEqual({ kind: "attr", target: { css: "#cell" }, name: "data-active", value: "true" });
    expect(parseAssertionSpec("attr:#cell|aria-current")).toEqual({ kind: "attr", target: { css: "#cell" }, name: "aria-current" });
    expect(parseAssertionSpec("attr:#cell|!hidden")).toEqual({ kind: "attr", target: { css: "#cell" }, name: "hidden", absent: true });
    expect(parseAssertionSpec("flashed:#b2|class=flash|withinMs=1000")).toEqual({
      kind: "flashed",
      target: { css: "#b2" },
      className: "flash",
      withinMs: 1000,
    });
    expect(parseAssertionSpec("flashed:#b2|animation")).toEqual({ kind: "flashed", target: { css: "#b2" }, animation: true });
  });

  it("rejects what code cannot decide: an unlisted property, a bad op/channel, a missing bound, an unscoped flash", () => {
    expect(() => parseAssertionSpec("style:#a|content=x")).toThrow(/not allowlisted/);
    expect(() => parseAssertionSpec("style:#a|hue(color)>1")).toThrow(/unknown channel/);
    expect(() => parseAssertionSpec("style:#a|color~red")).toThrow(/expected <prop><op><value>/);
    expect(() => parseAssertionSpec("style:#a")).toThrow(/requires/);
    expect(() => parseAssertionSpec("inViewport:#a|min=2")).toThrow(/invalid inViewport spec/);
    expect(() => parseAssertionSpec("inViewport:#a|min=x")).toThrow(/must be a number/);
    expect(() => parseAssertionSpec("box:#a|")).toThrow(/at least one bound/);
    expect(() => parseAssertionSpec("box:#a|width=3")).toThrow(/unknown bound/);
    expect(() => parseAssertionSpec("flashed:#a|withinMs=100")).toThrow(/exactly one of className, attr, animation/);
    expect(() => parseAssertionSpec("flashed:#a|glow")).toThrow(/unknown option/);
  });

  it("describeCheck round-trips through parseSuccessSpec (regression capture re-parses it)", () => {
    for (const spec of [
      "style:css=[data-heat]|alpha(background-color)>0",
      "style:css=#b1|color=rgb(255, 0, 0)",
      "inViewport:css=#b3|min=0.9",
      "box:testId=card|minWidth=100,maxHeight=300",
      "overlaps:css=#a|css=#b",
      "noOverlap:css=#a|css=#b",
      "attr:css=#cell|data-active=true",
      "attr:css=#cell|!hidden",
      "flashed:css=#b2|class=flash|withinMs=1000",
      "reloadThen:style:css=#b1|font-weight>=700",
    ]) {
      expect(describeCheck(parseSuccessSpec(spec))).toBe(spec);
    }
  });
});
