import { describe, expect, it } from "vitest";
import type { ActionDeltaRecord, RecordedStep, Recording, Step, ValueOrVar } from "@jevitate/recording";
import { deriveStepExpectations } from "./step-expectations.js";
import { expectedResultFromDelta } from "../replay-deltas.js";

const publish = { testId: "publish" };
const click = (target = publish): Step => ({ kind: "click", target, expect: { kind: "visible", target } });
const delta = (d: Partial<ActionDeltaRecord>): ActionDeltaRecord => ({ verdict: "inconclusive", why: "", changes: [], overheadMs: 1, ...d });
const rec = (...steps: RecordedStep[]): Recording => ({ version: "1", site: "https://app.test", pages: [{ url: "/editor", steps }] });
const only = (r: Recording): RecordedStep => r.pages[0]!.steps[0]!;

describe("#400 deriveStepExpectations: a step's expect comes from what it changed, never its own target", () => {
  it("a write step gets responseStatus:<METHOD> <path>=2xx from the request its delta recorded", () => {
    const out = only(
      deriveStepExpectations(
        rec({
          step: click(),
          delta: delta({ requests: ["POST /portal.v1.OwnerSiteEditService/PublishSiteEdits → 200", "GET /api/site → 200"] }),
        }),
      ),
    );
    expect(out.expectRequests).toEqual([
      { kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } },
    ]);
    // No visible change to claim: the explicit "no claim", never "my own target is visible".
    expect(out.step).toMatchObject({ expect: { kind: "count", target: publish, min: 0 } });
  });

  it("falls back to the step's recorded timing requests (ids become globs) without a delta", () => {
    const out = only(
      deriveStepExpectations(
        rec({
          step: click(),
          timing: {
            atMs: 0,
            durationMs: 1,
            gapBeforeMs: 0,
            page: {
              route: "/editor",
              kind: "transition",
              settled: true,
              requests: { count: 2, pending: 0, slowest: [
                { endpoint: "PUT /api/items/:id", url: "/api/items/42", status: 204, durationMs: 5 },
                { endpoint: "GET /api/items", url: "/api/items", status: 200, durationMs: 3 },
              ] },
            },
          },
        }),
      ),
    );
    expect(out.expectRequests).toEqual([{ kind: "responseStatus", method: "PUT", pathGlob: "/api/items/*", status: { class: 2 } }]);
  });

  it("never claims a read RPC, a failed write, or a write still pending", () => {
    const out = only(
      deriveStepExpectations(
        rec({
          step: click(),
          delta: delta({ requests: ["POST /pkg.Sites/GetSite → 200", "POST /api/save → 500", "POST /api/other → pending"] }),
        }),
      ),
    );
    expect(out.expectRequests).toBeUndefined();
  });

  it("a relevant-change step gets an expect on the text it added", () => {
    const out = only(deriveStepExpectations(rec({ step: click(), delta: delta({ verdict: "relevant-change", changes: ["+ status: Site published"] }) })));
    expect(out.step).toMatchObject({ expect: { kind: "visible", target: { text: "Site published", textMatch: "contains" } } });
  });

  it("an added named element is asserted by role and name; a changed text by its new value", () => {
    const added = only(deriveStepExpectations(rec({ step: click(), delta: delta({ verdict: "relevant-change", changes: ['+ heading "Preview ready" [level=2]'] }) })));
    expect(added.step).toMatchObject({ expect: { kind: "visible", target: { role: "heading", name: "Preview ready" } } });
    const changed = only(deriveStepExpectations(rec({ step: click(), delta: delta({ verdict: "relevant-change", changes: ['~ status: "Saving" → "Saved"'] }) })));
    expect(changed.step).toMatchObject({ expect: { kind: "visible", target: { text: "Saved", textMatch: "contains" } } });
  });

  it("skips volatile (digits), redacted, removed and summarised changes, and the target's own name", () => {
    const out = only(
      deriveStepExpectations(
        rec({
          step: click({ role: "button", name: "Publish" } as never),
          delta: delta({
            verdict: "relevant-change",
            changes: ["- status: Draft", "+ text: Saved at 10:42", "+ text: «redacted»", "list: 7 added, 0 removed, 0 changed — e.g. x", '+ button "Publish"', "+ text: Live now"],
          }),
        }),
      ),
    );
    expect(out.step).toMatchObject({ expect: { kind: "visible", target: { text: "Live now", textMatch: "contains" } } });
  });

  it("an inconclusive delta claims nothing on the page", () => {
    const out = only(deriveStepExpectations(rec({ step: click(), delta: delta({ verdict: "inconclusive", changes: ["+ text: Hello"] }) })));
    expect(out.step).toMatchObject({ expect: { kind: "count", min: 0 } });
  });

  it("a fill of a constant asserts the value it typed; a parameter fill claims nothing", () => {
    const fill = (value: ValueOrVar): Step => ({ kind: "fill", target: { label: "Title" }, value, expect: { kind: "visible", target: { label: "Title" } } });
    expect(only(deriveStepExpectations(rec({ step: fill({ redacted: false, value: "Hello" }) }))).step).toMatchObject({
      expect: { kind: "valueEquals", target: { label: "Title" }, value: "Hello" },
    });
    expect(only(deriveStepExpectations(rec({ step: fill({ var: "title" }) }))).step).toMatchObject({ expect: { kind: "count", target: { label: "Title" }, min: 0 } });
  });

  it("fills a step's expectedResult from the delta it recorded", () => {
    const d = delta({ verdict: "relevant-change", changes: ["+ status: Site published"] });
    const out = only(deriveStepExpectations(rec({ step: click(), delta: d })));
    expect(out.expectedResult).toBe(expectedResultFromDelta(d));
  });

  it("keeps an expectedResult the step already has", () => {
    const out = only(
      deriveStepExpectations(rec({ step: click(), delta: delta({ verdict: "relevant-change", changes: ["+ status: Site published"] }), expectedResult: "Shows the receipt" })),
    );
    expect(out.expectedResult).toBe("Shows the receipt");
  });

  it("leaves a step without a delta without an expectedResult", () => {
    const out = only(deriveStepExpectations(rec({ step: click() })));
    expect(out.expectedResult).toBeUndefined();
  });

  it("keeps a navigation postcondition and any expect that is not the step's own target", () => {
    const nav: Step = { kind: "click", target: publish, expect: { kind: "urlIncludes", text: "/published" } };
    expect(only(deriveStepExpectations(rec({ step: nav }))).step).toEqual(nav);
    const navigate: Step = { kind: "navigate", url: "/editor", expect: { kind: "urlIncludes", text: "/editor" } };
    expect(only(deriveStepExpectations(rec({ step: navigate }))).step).toEqual(navigate);
  });
});
