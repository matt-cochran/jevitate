import { describe, expect, it } from "vitest";
import type { Control, Snapshot } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { forwardControls, primaryForwardControl } from "./handle-blocked.js";

/**
 * #826 (remainder of #769) — the blocked-refusal hint finds and ranks a control the goal names only in
 * part (`Publish report` for "Publish the Q3 sales report", `Show demo` for "press Show the demo"),
 * ahead of a control the page's instruction merely suggests, and never one sharing no goal word.
 */
let index = 0;
const control = (name: string, role = "button"): Control =>
  ({ index: index++, name, role, enabled: true, summary: `${role} "${name}"`, tag: role === "link" ? "a" : "button", inputType: null }) as unknown as Control;

const ctxFor = (goal: string): RunContext => ({ goalText: goal, depth: { tried: () => false } }) as unknown as RunContext;
const stepFor = (controls: Control[], visibleText: string) => ({
  snap: { url: "http://127.0.0.1/page", controls } as unknown as Snapshot,
  modelControls: controls,
  visibleText: `${visibleText} ${controls.map((c) => c.name).join(" ")}`,
});
const names = (cs: readonly Control[]): string[] => cs.map((c) => c.name);

describe("#826 — a control the goal names in part is found and ranked", () => {
  it("finds the nav lab's partly named publish control when the page instruction names another", () => {
    // nav lab goal; the page instructs "Open the archive", the goal names `Publish report` in part.
    const controls = [control("Open archive"), control("Publish report"), control("Share")];
    const step = stepFor(controls, "Open the archive to review older reports.");
    expect(primaryForwardControl(ctxFor("Publish the Q3 sales report."), step)?.name).toBe("Publish report");
  });

  it("ranks a close variant of the goal's control ahead of a merely instructed match", () => {
    const controls = [control("Refresh"), control("Check in"), control("Show demo", "link"), control("Share")];
    const step = stepFor(controls, "Check in to continue.");
    const found = forwardControls(ctxFor("Check the demo, then press Show the demo."), step, { goalNamed: true });
    expect(names(found)[0]).toBe("Show demo");
    expect(names(found)).toContain("Check in");
  });

  it("finds a control whose name extends the goal's phrase", () => {
    const controls = [control("Check in"), control("Show the demo now", "link")];
    const step = stepFor(controls, "Check in to continue.");
    expect(primaryForwardControl(ctxFor("Check the demo, then press Show the demo."), step)?.name).toBe("Show the demo now");
  });

  it("does not count a control that shares no goal word, nor one the goal names only in one of several words", () => {
    const controls = [control("Share"), control("Business info"), control("Publish archive")];
    const step = stepFor(controls, "Pick one to continue.");
    expect(names(forwardControls(ctxFor("Publish the Q3 sales report."), step, { goalNamed: true }))).toEqual([]);
  });

  it("keeps the goal's whole-name control first", () => {
    const controls = [control("Show demo"), control("Show", "link")];
    const step = stepFor(controls, "Check in to continue.");
    expect(primaryForwardControl(ctxFor("press Show"), step)?.name).toBe("Show");
  });
});
