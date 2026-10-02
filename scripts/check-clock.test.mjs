import { describe, expect, it } from "vitest";
import { checkSource } from "./check-clock.mjs";

const lines = (src) => checkSource("/x/packages/demo/src/a.ts", src).map((v) => v.text.split(" — ")[0]);

describe("check-clock (#304 guard)", () => {
  it("flags direct time reads and global timers in Node source", () => {
    expect(
      lines(`
const a = Date.now();
const b = new Date();
const c = performance.now();
const t = setTimeout(() => undefined, 5);
clearTimeout(t);
import { setTimeout as sleep } from "node:timers/promises";
`),
    ).toEqual(["Date.now()", "new Date()", "performance.now()", "global setTimeout", "global clearTimeout", "timers import from node:timers/promises"]);
  });

  it("allows the clock, types, explicit dates, property names and locally bound names", () => {
    expect(
      lines(`
import { clock } from "@jevitate/domain";
let h: ReturnType<typeof setTimeout> | undefined = clock.setTimeout(() => undefined, 5);
const d = new Date(clock.now());
const deps = { setTimeout: clock.setTimeout };
function f(setTimeout: (fn: () => void, ms: number) => void) { setTimeout(() => undefined, 1); }
`),
    ).toEqual([]);
  });

  it("allows browser code: inline evaluate args, BROWSER CODE docs, serialized functions, markers, clock-ok", () => {
    expect(
      lines(`
await page.evaluate(() => Date.now());
/** BROWSER CODE — runs in the page. */
function inPage(): number { return performance.now(); }
function serialized(): void { setTimeout(() => undefined, 1); }
const src = \`(\${serialized.toString()})()\`;
await page.addInitScript(installer);
function installer(): void { setInterval(() => undefined, 1); }
const ok = Date.now(); // clock-ok: measuring the real host on purpose
`),
    ).toEqual([]);
    expect(lines(`// @jevitate-browser-code\nsetTimeout(() => 1, 1);`)).toEqual([]);
  });
});
