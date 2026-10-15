import { describe, expect, it } from "vitest";
import type { Recording } from "@jevitate/recording";
import { Frontier } from "../../coverage/frontier.js";
import type { Control } from "../../index.js";
import { enqueueFrom } from "./helpers.js";

const empty: Recording = { version: "1", site: "http://x.test", pages: [] };
const btn = (name: string, inRegion: boolean): Control =>
  ({
    index: 0,
    descriptor: { role: "button", name },
    stability: "stable",
    role: "button",
    name,
    tag: "button",
    inputType: null,
    enabled: true,
    summary: `button "${name}"`,
    inRegion,
  }) as unknown as Control;

describe("enqueueFrom — region-scoped frontier (#519)", () => {
  it("enqueues only in-region controls when the region is declared", () => {
    const f = new Frontier();
    enqueueFrom(f, "fp", empty, [btn("In", true), btn("Out", false)], () => false, true);
    expect(f.size).toBe(1);
  });
  it("returns how many controls it skipped as out-of-region", () => {
    const f = new Frontier();
    expect(enqueueFrom(f, "fp", empty, [btn("In", true), btn("Out", false)], () => false, true)).toBe(1);
  });
  it("enqueues everything without a region (unchanged)", () => {
    const f = new Frontier();
    enqueueFrom(f, "fp", empty, [btn("In", true), btn("Out", false)], () => false, false);
    expect(f.size).toBe(2);
  });
  it("reports zero skipped without a region", () => {
    const f = new Frontier();
    expect(enqueueFrom(f, "fp", empty, [btn("In", true), btn("Out", false)], () => false, false)).toBe(0);
  });
});
