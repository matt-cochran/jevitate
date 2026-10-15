import { describe, expect, it } from "vitest";
import type { TargetDescriptor } from "@jevitate/recording";
import { snapshot, type SnapshotOptions } from "./snapshot.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

const PAGE = `<!doctype html><html><body>
<nav><button>Menu</button></nav>
<main>
  <button>Filter</button>
  <section data-testid="import-view" aria-label="Import">
    <button>Upload</button><button>Continue</button>
  </section>
  <div id="host"></div>
</main>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = '<div data-testid="shadow-region"><button>Shadow inside</button></div>';
</script>
</body></html>`;

async function snap(opts?: SnapshotOptions) {
  return withSession("explore-snapshot-region-", async (session) => {
    await session.page.setContent(PAGE);
    return snapshot(session.page, opts);
  });
}

const region = (...regions: TargetDescriptor[]): SnapshotOptions => ({ regions });

describe("snapshot regions (#519)", () => {
  it("tags every control inRegion when a region is declared", async () => {
    const s = await snap(region({ testId: "import-view" }));
    const by = Object.fromEntries(s.controls.map((c) => [c.name, c.inRegion]));
    expect(by).toMatchObject({ Menu: false, Filter: false, Upload: true, Continue: true, "Shadow inside": false });
    expect(s.controls.every((c) => typeof c.inRegion === "boolean")).toBe(true);
    expect(s.region).toEqual({ matched: 1 });
  });

  it("leaves controls untagged without a region", async () => {
    const s = await snap();
    expect(s.controls.length).toBeGreaterThan(0);
    expect(s.controls.every((c) => c.inRegion === undefined)).toBe(true);
    expect(s.region).toBeUndefined();
  });

  it("reports matched 0 and no in-region control when the region is absent", async () => {
    const s = await snap(region({ testId: "nope" }));
    expect(s.region).toEqual({ matched: 0 });
    expect(s.controls.length).toBeGreaterThan(0);
    expect(s.controls.every((c) => c.inRegion === false)).toBe(true);
  });

  it("counts every match of a multi-match descriptor and any of several descriptors", async () => {
    const s = await snap(region({ role: "button", name: "Filter" }, { testId: "import-view" }));
    expect(s.region?.matched).toBe(2);
    // A region element that is itself a control counts as inside itself.
    expect(s.controls.find((c) => c.name === "Filter")?.inRegion).toBe(true);
    expect(s.controls.find((c) => c.name === "Upload")?.inRegion).toBe(true);
    expect(s.controls.find((c) => c.name === "Menu")?.inRegion).toBe(false);
  });

  it("every element a single descriptor matches counts as region", async () => {
    // `css=button` matches all five buttons (the shadow one too) — each is its own region.
    const s = await snap(region({ css: "button" }));
    expect(s.region?.matched).toBe(5);
    expect(s.controls.every((c) => c.inRegion === true)).toBe(true);
  });

  it("crosses open shadow roots", async () => {
    const s = await snap(region({ testId: "shadow-region" }));
    expect(s.region).toEqual({ matched: 1 });
    expect(s.controls.find((c) => c.name === "Shadow inside")?.inRegion).toBe(true);
    expect(s.controls.find((c) => c.name === "Upload")?.inRegion).toBe(false);
  });

  it("a region containing a shadow host covers the controls in its open shadow root", async () => {
    const s = await snap(region({ css: "main" }));
    expect(s.controls.find((c) => c.name === "Shadow inside")?.inRegion).toBe(true);
    expect(s.controls.find((c) => c.name === "Menu")?.inRegion).toBe(false);
  });

  it("a descriptor with no usable selector matches nothing instead of failing the read", async () => {
    const s = await snap(region({ role: "main" }));
    expect(s.region).toEqual({ matched: 0 });
    expect(s.controls.every((c) => c.inRegion === false)).toBe(true);
  });

  it("reads in-region controls first when the page exceeds maxCandidates", async () => {
    const s = await snap({ regions: [{ testId: "import-view" }], maxCandidates: 2 });
    expect(s.controls.map((c) => c.name)).toEqual(["Upload", "Continue"]);
    expect(s.controls.map((c) => c.index)).toEqual([0, 1]);
    expect(s.truncated).toBe(true);
  });
});
