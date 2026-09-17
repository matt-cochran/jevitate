import { describe, it, expect } from "vitest";
import { RecordingSchema } from "./schema";

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
});
