import { describe, it, expect } from "vitest";
import { RecordingSchema, AssertionSchema } from "./schema";

describe("RecordingSchema", () => {
  it("parses a valid one-page recording", () => {
    const validRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          title: "Example",
          steps: [
            {
              step: {
                kind: "navigate",
                url: "https://example.com",
                expect: {
                  kind: "urlIncludes",
                  text: "example.com",
                },
              },
            },
          ],
        },
      ],
    };

    const result = RecordingSchema.parse(validRecording);
    expect(result).toBeDefined();
  });

  it("rejects a step with unknown kind", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "doSomethingWeird",
                url: "https://example.com",
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  it("rejects a click step without expect field (Poka-Yoke)", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "click",
                target: {
                  testId: "my-button",
                },
                // Missing expect field
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  it("parses a fill step with var value", () => {
    const validRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "fill",
                target: {
                  testId: "input-field",
                },
                value: {
                  var: "body",
                },
                expect: {
                  kind: "visible",
                  target: {
                    testId: "input-field",
                  },
                },
              },
            },
          ],
        },
      ],
    };

    const result = RecordingSchema.parse(validRecording);
    expect(result).toBeDefined();
  });

  // === Fix scope D: navigate.url scheme constraint ===

  function withNavigateUrl(url: string) {
    return {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "navigate",
                url,
                expect: { kind: "urlIncludes", text: "x" },
              },
            },
          ],
        },
      ],
    };
  }

  it("parses navigate.url as a relative path starting with '/'", () => {
    expect(() => RecordingSchema.parse(withNavigateUrl("/inbox"))).not.toThrow();
  });

  it("parses navigate.url as an absolute https:// URL", () => {
    expect(() => RecordingSchema.parse(withNavigateUrl("https://example.com/x"))).not.toThrow();
  });

  it("rejects navigate.url with a javascript: scheme", () => {
    expect(() => RecordingSchema.parse(withNavigateUrl("javascript:alert(1)"))).toThrow();
  });

  it("rejects navigate.url with a data: scheme", () => {
    expect(() => RecordingSchema.parse(withNavigateUrl("data:text/html,x"))).toThrow();
  });

  // === Fix scope E: TargetDescriptor .strict() + non-empty refinement ===

  function withClickTarget(target: unknown) {
    return {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "click",
                target,
                expect: { kind: "visible", target: { testId: "x" } },
              },
            },
          ],
        },
      ],
    };
  }

  it("rejects an empty TargetDescriptor ({}) — no usable selector at all", () => {
    expect(() => RecordingSchema.parse(withClickTarget({}))).toThrow();
  });

  it("rejects a TargetDescriptor with only frameUrl set — still no usable selector", () => {
    expect(() =>
      RecordingSchema.parse(withClickTarget({ frameUrl: "https://example.com/iframe" })),
    ).toThrow();
  });

  it("rejects a TargetDescriptor with a typo'd key (testid instead of testId)", () => {
    expect(() => RecordingSchema.parse(withClickTarget({ testid: "x" }))).toThrow();
  });

  it("accepts a TargetDescriptor with role set but no name (pairing is an interpreter-level rule, not schema-level)", () => {
    expect(() => RecordingSchema.parse(withClickTarget({ role: "button" }))).not.toThrow();
  });

  it("rejects a RecordedStep with an unexpected extra field", () => {
    const invalid = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: { kind: "assert", check: { kind: "visible", target: { testId: "x" } } },
              bogusField: "oops",
            },
          ],
        },
      ],
    };
    expect(() => RecordingSchema.parse(invalid)).toThrow();
  });

  it("rejects a PageSegment with an unexpected extra field", () => {
    const invalid = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [],
          bogusField: "oops",
        },
      ],
    };
    expect(() => RecordingSchema.parse(invalid)).toThrow();
  });

  // === Task 1: select + press primitives ===

  it("parses a valid select step with expect", () => {
    const validRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "select",
                target: { testId: "country" },
                value: { redacted: false, value: "US" },
                expect: { kind: "visible", target: { testId: "country" } },
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(validRecording)).not.toThrow();
  });

  it("parses a select step with a var value", () => {
    const validRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "select",
                target: { testId: "country" },
                value: { var: "country" },
                expect: { kind: "visible", target: { testId: "country" } },
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(validRecording)).not.toThrow();
  });

  it("rejects a select step without expect (Poka-Yoke)", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "select",
                target: { testId: "country" },
                value: { redacted: false, value: "US" },
                // Missing expect field
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  it("rejects a select step without a value", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "select",
                target: { testId: "country" },
                expect: { kind: "visible", target: { testId: "country" } },
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  it("parses a valid press step with expect", () => {
    const validRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "press",
                key: "Enter",
                expect: { kind: "urlIncludes", text: "/results" },
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(validRecording)).not.toThrow();
  });

  it("rejects a press step without expect (Poka-Yoke)", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "press",
                key: "Enter",
                // Missing expect field
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  it("rejects a press step without a key", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "press",
                expect: { kind: "urlIncludes", text: "/results" },
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  it("rejects a press step with a target field (press has no target)", () => {
    const invalidRecording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: {
                kind: "press",
                key: "Enter",
                target: { testId: "search-box" },
                expect: { kind: "urlIncludes", text: "/results" },
              },
            },
          ],
        },
      ],
    };

    expect(() => RecordingSchema.parse(invalidRecording)).toThrow();
  });

  // === Task 1: TargetDescriptor ordinal/container ===

  it("accepts a TargetDescriptor with role+name and an ordinal (nth-match)", () => {
    expect(() =>
      RecordingSchema.parse(withClickTarget({ role: "button", name: "OK", ordinal: 1 })),
    ).not.toThrow();
  });

  it("accepts a TargetDescriptor with a container (nearest stable ancestor)", () => {
    expect(() =>
      RecordingSchema.parse(
        withClickTarget({
          role: "button",
          name: "OK",
          ordinal: 0,
          container: { testId: "row-1" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a negative ordinal", () => {
    expect(() =>
      RecordingSchema.parse(withClickTarget({ role: "button", name: "OK", ordinal: -1 })),
    ).toThrow();
  });

  it("rejects a non-integer ordinal", () => {
    expect(() =>
      RecordingSchema.parse(withClickTarget({ role: "button", name: "OK", ordinal: 1.5 })),
    ).toThrow();
  });

  it("rejects an ordinal-only TargetDescriptor — still no usable selector", () => {
    expect(() => RecordingSchema.parse(withClickTarget({ ordinal: 0 }))).toThrow();
  });

  it("rejects a TargetDescriptor with a typo'd key on a nested container", () => {
    expect(() =>
      RecordingSchema.parse(
        withClickTarget({ role: "button", name: "OK", container: { testid: "row-1" } }),
      ),
    ).toThrow();
  });

  it("rejects a StepTiming with an unexpected extra field", () => {
    const invalid = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com",
          steps: [
            {
              step: { kind: "assert", check: { kind: "visible", target: { testId: "x" } } },
              timing: { atMs: 0, durationMs: 0, gapBeforeMs: 0, bogusField: "oops" },
            },
          ],
        },
      ],
    };
    expect(() => RecordingSchema.parse(invalid)).toThrow();
  });
});

describe("AssertionSchema (exported for @jevitate/missions' successAssertion)", () => {
  it("parses a well-formed urlIncludes assertion", () => {
    expect(() => AssertionSchema.parse({ kind: "urlIncludes", text: "/checkout" })).not.toThrow();
  });

  it("rejects an unknown assertion kind", () => {
    expect(() => AssertionSchema.parse({ kind: "bogus" })).toThrow();
  });

  it("parses valueEquals (a form control's value) and requires its target and value", () => {
    expect(AssertionSchema.parse({ kind: "valueEquals", target: { testId: "last" }, value: "Litmus" })).toEqual({
      kind: "valueEquals",
      target: { testId: "last" },
      value: "Litmus",
    });
    expect(() => AssertionSchema.parse({ kind: "valueEquals", target: { testId: "last" } })).toThrow();
    expect(() => AssertionSchema.parse({ kind: "valueEquals", value: "x" })).toThrow();
    expect(() => AssertionSchema.parse({ kind: "valueEquals", target: { testId: "last" }, value: "x", text: "y" })).toThrow();
  });
});

describe("RecordingSchema — upload step", () => {
  const withStep = (step: unknown) => ({
    version: "1.0",
    site: "https://example.com",
    pages: [{ url: "/profile", steps: [{ step }] }],
  });
  const target = { label: "Choose avatar" };
  const expect_ = { kind: "count", target, min: 1 };

  it("parses a plain-path, redacted and var-bound upload", () => {
    for (const file of [
      { redacted: false, value: "/abs/avatar.png" },
      { redacted: true, length: 12 },
      { var: "fixture" },
    ]) {
      expect(() => RecordingSchema.parse(withStep({ kind: "upload", target, file, expect: expect_ }))).not.toThrow();
    }
  });

  it("rejects an upload without a file or with an unknown key (strict)", () => {
    expect(() => RecordingSchema.parse(withStep({ kind: "upload", target, expect: expect_ }))).toThrow();
    expect(() =>
      RecordingSchema.parse(
        withStep({ kind: "upload", target, file: { var: "f" }, path: "/x", expect: expect_ }),
      ),
    ).toThrow();
  });
});
