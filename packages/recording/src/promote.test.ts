import { describe, it, expect } from "vitest";
import type { Recording, Step } from "./schema.js";
import { promoteToVariable, boundVariables } from "./promote.js";

describe("promoteToVariable", () => {
  it("promotes a fill step and returns a new recording with value set to var", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/login",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "username-input" },
                value: { redacted: false, value: "testuser" },
                expect: { kind: "visible", target: { testId: "submit-btn" } },
              },
              timing: { atMs: 100, durationMs: 50, gapBeforeMs: 10 },
            },
          ],
        },
      ],
    };

    const promoted = promoteToVariable(recording, { page: 0, step: 0 }, "username");

    // Check the promoted recording has the new variable value
    const promotedStep = promoted.pages[0].steps[0];
    expect(promotedStep.step.value).toEqual({ var: "username" });
    expect(promotedStep.variableName).toBe("username");

    // Check the original recording is unchanged (proves purity)
    const originalStep = recording.pages[0].steps[0];
    expect(originalStep.step.value).toEqual({ redacted: false, value: "testuser" });
    expect(originalStep.variableName).toBeUndefined();
  });

  it("boundVariables returns list of declared variable names in document order", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page1",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "input1" },
                value: { var: "username" },
                expect: { kind: "visible", target: { testId: "btn1" } },
              },
              variableName: "username",
            },
            {
              step: {
                kind: "fill",
                target: { testId: "input2" },
                value: { redacted: false, value: "password123" },
                expect: { kind: "visible", target: { testId: "btn2" } },
              },
            },
          ],
        },
        {
          url: "https://example.com/page2",
          steps: [
            {
              step: {
                kind: "select",
                target: { testId: "dropdown" },
                value: { var: "option" },
                expect: { kind: "visible", target: { testId: "result" } },
              },
              variableName: "option",
            },
          ],
        },
      ],
    };

    const vars = boundVariables(recording);
    expect(vars).toEqual(["username", "option"]);
  });

  it("boundVariables returns empty array when no variables are declared", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page1",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "input1" },
                value: { redacted: false, value: "plaintext" },
                expect: { kind: "visible", target: { testId: "btn1" } },
              },
            },
          ],
        },
      ],
    };

    const vars = boundVariables(recording);
    expect(vars).toEqual([]);
  });

  it("throws when promoting a non-fill/select step", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page",
          steps: [
            {
              step: {
                kind: "click",
                target: { testId: "button" },
                expect: { kind: "visible", target: { testId: "result" } },
              },
            },
          ],
        },
      ],
    };

    expect(() => {
      promoteToVariable(recording, { page: 0, step: 0 }, "var1");
    }).toThrow(/only fill and select steps can be promoted/i);
  });

  it("throws when page index is out of range", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page",
          steps: [],
        },
      ],
    };

    expect(() => {
      promoteToVariable(recording, { page: 5, step: 0 }, "var1");
    }).toThrow();
  });

  it("throws when step index is out of range", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "input" },
                value: { redacted: false, value: "test" },
                expect: { kind: "visible", target: { testId: "btn" } },
              },
            },
          ],
        },
      ],
    };

    expect(() => {
      promoteToVariable(recording, { page: 0, step: 5 }, "var1");
    }).toThrow();
  });

  it("promotes a select step correctly", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page",
          steps: [
            {
              step: {
                kind: "select",
                target: { testId: "select" },
                value: { redacted: false, value: "option1" },
                expect: { kind: "visible", target: { testId: "result" } },
              },
            },
          ],
        },
      ],
    };

    const promoted = promoteToVariable(recording, { page: 0, step: 0 }, "selectedValue");

    const promotedStep = promoted.pages[0].steps[0];
    expect(promotedStep.step.value).toEqual({ var: "selectedValue" });
    expect(promotedStep.variableName).toBe("selectedValue");
  });

  it("preserves other pages and steps unchanged", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.com",
      pages: [
        {
          url: "https://example.com/page1",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "input1" },
                value: { redacted: false, value: "value1" },
                expect: { kind: "visible", target: { testId: "btn1" } },
              },
            },
            {
              step: {
                kind: "click",
                target: { testId: "btn1" },
                expect: { kind: "visible", target: { testId: "result" } },
              },
            },
          ],
        },
        {
          url: "https://example.com/page2",
          steps: [
            {
              step: {
                kind: "navigate",
                url: "/page3",
                expect: { kind: "urlIncludes", text: "page3" },
              },
            },
          ],
        },
      ],
    };

    const promoted = promoteToVariable(recording, { page: 0, step: 0 }, "username");

    // First page, second step should be unchanged (same reference)
    expect(promoted.pages[0].steps[1]).toBe(recording.pages[0].steps[1]);

    // Second page should be unchanged (same reference)
    expect(promoted.pages[1]).toBe(recording.pages[1]);

    // But other pages/steps should not be mutated
    expect(recording.pages[0].steps[0].variableName).toBeUndefined();
    expect(recording.pages[0].steps[0].step.value).toEqual({
      redacted: false,
      value: "value1",
    });
  });
});
