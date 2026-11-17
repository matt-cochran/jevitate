import { describe, expect, it } from "vitest";
import type { Control, Snapshot } from "./snapshot.js";
import { boundUploadFixture, markUploadFixtures, TypeFixtureSpecError, type UploadFixture } from "./type-fixtures.js";

// #720: which descriptor-bound upload fixture a file input receives.

const control = (over: Partial<Control>): Control => ({
  index: 0,
  descriptor: {},
  stability: "high",
  role: "file-input",
  name: "",
  tag: "input",
  inputType: "file",
  enabled: true,
  summary: 'file-input ""',
  ...over,
});

const bind = (descriptor: string, name: string): UploadFixture => {
  const eq = descriptor.indexOf("=");
  const key = descriptor.slice(0, eq) as UploadFixture["matcher"]["key"];
  return { descriptor, matcher: { key, value: descriptor.slice(eq + 1) }, name, path: `/project/fixtures/${name}` } as UploadFixture;
};

describe("#720 boundUploadFixture", () => {
  it("matches a file input by label, testId, id or name", () => {
    const fixtures = [bind("label=Before photo", "before.png"), bind("testId=after", "after.png"), bind("id=front", "front.png"), bind("name=back", "back.png")];
    expect(boundUploadFixture(control({ name: "Before photo" }), fixtures)?.name).toBe("before.png");
    expect(boundUploadFixture(control({ descriptor: { testId: "after" } }), fixtures)?.name).toBe("after.png");
    expect(boundUploadFixture(control({ descriptor: { anchor: { id: "front" } } as Control["descriptor"] }), fixtures)?.name).toBe("front.png");
    expect(boundUploadFixture(control({ descriptor: { anchor: { name: "back" } } as Control["descriptor"] }), fixtures)?.name).toBe("back.png");
  });

  it("returns null for a control no binding matches, and never binds a non-input", () => {
    const fixtures = [bind("label=Before photo", "before.png")];
    expect(boundUploadFixture(control({ name: "After photo" }), fixtures)).toBeNull();
    expect(boundUploadFixture(control({ tag: "button", role: "button", name: "Before photo" }), fixtures)).toBeNull();
    expect(boundUploadFixture(control({ name: "Before photo" }), [])).toBeNull();
  });

  it("refuses two bindings that match the same control instead of picking one", () => {
    const fixtures = [bind("label=Before photo", "a.png"), bind("id=before", "b.png")];
    const c = control({ name: "Before photo", descriptor: { anchor: { id: "before" } } as Control["descriptor"] });
    expect(() => boundUploadFixture(c, fixtures)).toThrow(TypeFixtureSpecError);
    expect(() => boundUploadFixture(c, fixtures)).toThrow("--upload-fixture bindings are ambiguous for Before photo");
  });

  it("marks only unambiguous bound inputs for the model, by file name and never by path", () => {
    const fixtures = [bind("label=Before photo", "before.png"), bind("label=Gallery", "g1.png"), bind("id=gallery", "g2.png")];
    const snap = {
      controls: [
        control({ index: 0, name: "Before photo", summary: 'file-input "Before photo"' }),
        control({ index: 1, name: "Gallery", descriptor: { anchor: { id: "gallery" } } as Control["descriptor"], summary: 'file-input "Gallery"' }),
      ],
    } as unknown as Snapshot;
    const marked = markUploadFixtures(snap, fixtures);
    expect(marked.controls[0]!.summary).toContain("«fixture:before.png»");
    expect(marked.controls[1]!.summary).toBe('file-input "Gallery"');
    expect(JSON.stringify(marked)).not.toContain("/project/fixtures");
  });
});
