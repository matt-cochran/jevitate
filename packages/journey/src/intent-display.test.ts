import { describe, expect, it } from "vitest";
import { describeStep } from "./intent.js";

/** #497: a step is described by what a person saw (its recorded label), not by its locator. */
describe("describeStep names a step's target by its recorded label (#497)", () => {
  it("a click on a labelled target reads as the label", () => {
    const text = describeStep({
      kind: "click",
      target: { testId: "action-import", display: { role: "button", name: "Import" } },
      expect: { kind: "visible", target: { testId: "action-import" } },
    });
    expect(text).toBe('click "Import"');
  });

  it("an upload to a labelled target reads as the label", () => {
    const text = describeStep({
      kind: "upload",
      target: { testId: "import-file", display: { name: "Upload a file" } },
      file: { redacted: false, value: "contacts.csv" },
      expect: { kind: "count", target: { testId: "import-file" }, min: 1 },
    });
    expect(text).toBe('upload a file to "Upload a file"');
  });

  it("a fill on a labelled target reads as the label with its value placeholder", () => {
    const text = describeStep({
      kind: "fill",
      target: { testId: "contact-email", display: { role: "textbox", name: "Email" } },
      value: { var: "email" },
      expect: { kind: "visible", target: { testId: "contact-email" } },
    });
    expect(text).toBe('fill "Email" with <param email>');
  });

  it("a test-id target with no recorded label reads as its test id in words, marked unlabelled", () => {
    const text = describeStep({
      kind: "click",
      target: { testId: "action-import" },
      expect: { kind: "visible", target: { testId: "action-import" } },
    });
    expect(text).toBe("click [action import] (no recorded label)");
  });

  it("underscores in an unlabelled test id read as spaces too", () => {
    const text = describeStep({
      kind: "click",
      target: { testId: "save__contact_btn" },
      expect: { kind: "visible", target: { testId: "save__contact_btn" } },
    });
    expect(text).toBe("click [save contact btn] (no recorded label)");
  });

  it("the recorded label wins over a role+name locator", () => {
    const text = describeStep({
      kind: "click",
      target: { role: "button", name: "Import", display: { role: "button", name: "Import contacts" } },
      expect: { kind: "visible", target: { role: "button", name: "Import" } },
    });
    expect(text).toBe('click "Import contacts"');
  });
});
