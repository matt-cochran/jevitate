import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Page, Request, Response } from "playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec } from "@jevitate/recording";
import { InvariantMonitor, parseFirstNumber, parseNumbers } from "./declared-invariants.js";

/**
 * #156 — the `number` parser behind `DomObservable.number`: a Unicode minus (U+2212) must not be
 * dropped, thousands separators and decimals must parse, and a range's dash must stay a separator
 * (never mistaken for a sign) so BOTH bounds of a range are readable.
 */
describe("parseNumbers (#156)", () => {
  it("reads a Unicode minus sign (U+2212), not just ASCII '-'", () => {
    expect(parseNumbers("−40 credits")).toEqual([-40]);
    expect(parseFirstNumber("−40 credits")).toBe(-40);
  });

  it("reads an ASCII negative number", () => {
    expect(parseNumbers("-5")).toEqual([-5]);
    expect(parseFirstNumber("-5")).toBe(-5);
  });

  it("reads thousands separators and a decimal together", () => {
    expect(parseNumbers("1,234.5")).toEqual([1234.5]);
    expect(parseFirstNumber("≈ 1,234.5 credits")).toBe(1234.5);
  });

  it("keeps a range's en-dash a separator: both bounds are readable, neither is negated", () => {
    expect(parseNumbers("≈ 30–90 credits")).toEqual([30, 90]);
  });

  it("keeps a spaced dash a separator too (index 1 reads the second number, not -7)", () => {
    const nums = parseNumbers("3 – 7");
    expect(nums).toEqual([3, 7]);
    expect(nums.at(1)).toBe(7);
  });

  it("a negative index counts from the end", () => {
    const nums = parseNumbers("≈ 30–90 credits");
    expect(nums.at(-1)).toBe(90);
  });

  it("returns an empty list when there is no number", () => {
    expect(parseNumbers("no digits here")).toEqual([]);
    expect(parseFirstNumber("no digits here")).toBeNull();
  });
});

/**
 * #212 item 4 — a declared `never.response` violation's evidence must cite the MISSION's own step
 * index, never `InvariantMonitor`'s internal action tally. The monitor only hears about the actions
 * its `when` gates apply to (`#applies`'s `when.op`/`when.route`/`when.control` filters, or a mission
 * that only re-arms it on some steps): its own tally runs behind the mission's real step count, so
 * without `InvariantAction.step` it mislabels evidence (dogfood repro: "step 13" for what the run's
 * own transcript/firstSeenStep recorded as step 30 — a 17-step gap from actions the monitor was
 * never told about). Threading the caller's own step (`transcript.nextStep`, a transcript entry's
 * `step`, or a replayed recording's step index) fixes this; the served `never-response-served.test.ts`
 * exercises the real goal/adversarial/feature/coverage mission wiring end to end.
 */
describe("#212 item 4: never.response evidence cites the mission's own step, not the monitor's tally", () => {
  class FakePage extends EventEmitter {
    url(): string {
      return "https://example.test/app";
    }
  }

  function fakeResponse(url: string, status: number, method = "GET"): Response {
    const request = { url: () => url, method: () => method } as unknown as Request;
    return { url: () => url, status: () => status, request: () => request } as unknown as Response;
  }

  it("uses InvariantAction.step (not the monitor's own action count) in the violation's evidence", async () => {
    const origin = "https://example.test";
    const spec = validateInvariantSpec(
      { invariants: [{ id: "no-billing-403", never: { response: { url: "/api/**", status: "403" } } }] },
      { allowlist: [origin], baseUrl: `${origin}/app` },
    );
    const monitor = new InvariantMonitor(spec, { allowlist: [origin], baseUrl: `${origin}/app` });
    const fakePage = new FakePage();
    const page = fakePage as unknown as Page;
    const actor = CastActor.named("viewer").whoCan(new BrowseTheWeb({ page } as never, [origin]));

    // 12 armed actions the monitor DOES see (steps the mission itself numbers well apart, as an
    // 18-step gap from unrelated, un-arming steps would in a real mission) — none violate.
    for (let i = 1; i <= 12; i++) {
      await monitor.after(actor, { op: "click", control: `c${i}`, url: `${origin}/app`, step: i * 2 });
    }
    // A 403 fires during the mission's real step 30 — its 13th action the monitor was told about.
    fakePage.emit("response", fakeResponse(`${origin}/api/x`, 403));
    const result = await monitor.after(actor, { op: "click", control: "Save", url: `${origin}/app`, step: 30 });

    expect(result.violations).toHaveLength(1);
    const [v] = result.violations;
    // The monitor's own tally is 13 here (its 13th action call) — never what evidence cites.
    expect(v?.evidence[0]).toContain("step 30");
    expect(v?.evidence[0]).not.toContain("step 13");
    expect(v?.responses?.[0]?.step).toBe(30);
  });

  it("falls back to its own tally when a caller never threads a step (backward compatible)", async () => {
    const origin = "https://example.test";
    const spec = validateInvariantSpec(
      { invariants: [{ id: "no-billing-403", never: { response: { url: "/api/**", status: "403" } } }] },
      { allowlist: [origin], baseUrl: `${origin}/app` },
    );
    const monitor = new InvariantMonitor(spec, { allowlist: [origin], baseUrl: `${origin}/app` });
    const fakePage = new FakePage();
    const page = fakePage as unknown as Page;
    const actor = CastActor.named("viewer").whoCan(new BrowseTheWeb({ page } as never, [origin]));

    await monitor.after(actor, null); // page load: step 0, "page load"
    fakePage.emit("response", fakeResponse(`${origin}/api/x`, 403));
    const result = await monitor.after(actor, { op: "click", control: "Save", url: `${origin}/app` });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.evidence[0]).toContain('step 1: click "Save"');
  });
});
