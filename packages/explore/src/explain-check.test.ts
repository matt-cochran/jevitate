import { describe, expect, it } from "vitest";
import type { TargetDescriptor } from "@jevitate/recording";
import { explainCheck, explainTarget } from "./explain-check.js";
import type { SuccessCheck } from "./success-checks.js";

const saveButton: TargetDescriptor = { role: "button", name: "Save" };
const statusText: TargetDescriptor = { name: "Status" };
const row: TargetDescriptor = { role: "row", name: "Row" };
const first: TargetDescriptor = { testId: "first" };
const second: TargetDescriptor = { css: ".second" };

const LONG = "x".repeat(90);
const LONG_CUT = `${"x".repeat(80)}…`;

describe("explainTarget", () => {
  it.each<[string, TargetDescriptor, string]>([
    ["recorded display label with its role", { testId: "action-import", display: { role: "button", name: "Import" } }, 'the "Import" button'],
    ["recorded display label without a role", { testId: "action-import", display: { name: "Import" } }, '"Import"'],
    ["role+name", saveButton, 'the "Save" button'],
    ["name", statusText, '"Status"'],
    ["label", { label: "Email" }, '"Email"'],
    ["text", { text: "Hello" }, 'the text "Hello"'],
    ["testId with dashes", { testId: "action-import" }, "action import"],
    ["testId with underscores", { testId: "action_import" }, "action import"],
    ["css", { css: ".foo > button" }, "the element .foo > button"],
  ])("words a %s target", (_name, target, expected) => {
    expect(explainTarget(target)).toBe(expected);
  });
});

describe("explainCheck", () => {
  it.each<[string, SuccessCheck, string]>([
    ["urlIncludes", { kind: "page", assertion: { kind: "urlIncludes", text: "profile" } }, 'the URL contains "profile"'],
    ["visible", { kind: "page", assertion: { kind: "visible", target: saveButton } }, 'the "Save" button is visible'],
    ["textIncludes", { kind: "page", assertion: { kind: "textIncludes", target: statusText, text: "Saved" } }, '"Status" shows "Saved"'],
    ["count with no bounds", { kind: "page", assertion: { kind: "count", target: row } }, 'any number of the "Row" row, including none'],
    ["count with min 0", { kind: "page", assertion: { kind: "count", target: row, min: 0 } }, 'any number of the "Row" row, including none'],
    ["count with a min", { kind: "page", assertion: { kind: "count", target: row, min: 1 } }, 'at least 1 the "Row" row'],
    ["count with a max", { kind: "page", assertion: { kind: "count", target: row, max: 3 } }, 'at most 3 the "Row" row'],
    ["count with both bounds", { kind: "page", assertion: { kind: "count", target: row, min: 1, max: 5 } }, 'between 1 and 5 the "Row" row'],
    ["valueEquals", { kind: "page", assertion: { kind: "valueEquals", target: { name: "Email" }, value: "a@b.com" } }, '"Email" has the value "a@b.com"'],
    [
      "attr with a value",
      { kind: "page", assertion: { kind: "attr", target: first, name: "data-state", value: "open" } },
      'first has data-state="open"',
    ],
    ["attr present", { kind: "page", assertion: { kind: "attr", target: first, name: "data-state" } }, 'first has data-state'],
    ["attr absent", { kind: "page", assertion: { kind: "attr", target: first, name: "data-state", absent: true } }, 'first has no data-state'],
    [
      "style",
      { kind: "page", assertion: { kind: "style", target: saveButton, property: "color", op: "=", value: "rgb(255, 0, 0)" } },
      'the "Save" button has color = rgb(255, 0, 0)',
    ],
    [
      "style with a channel",
      { kind: "page", assertion: { kind: "style", target: saveButton, property: "color", channel: "alpha", op: ">=", value: "0.5" } },
      'the "Save" button has color (alpha) >= 0.5',
    ],
    ["inViewport", { kind: "page", assertion: { kind: "inViewport", target: saveButton } }, 'the "Save" button is on screen'],
    ["box", { kind: "page", assertion: { kind: "box", target: saveButton, maxWidth: 100 } }, 'the "Save" button fits the size bounds'],
    [
      "overlap",
      { kind: "page", assertion: { kind: "overlap", target: first, other: second, overlapping: true } },
      'first overlaps the element .second',
    ],
    [
      "no overlap",
      { kind: "page", assertion: { kind: "overlap", target: first, other: second, overlapping: false } },
      'first does not overlap the element .second',
    ],
    ["flashed", { kind: "page", assertion: { kind: "flashed", target: saveButton, className: "saved" } }, 'the "Save" button flashed after the action'],
    [
      "reloadThen",
      { kind: "reloadThen", assertion: { kind: "visible", target: statusText } },
      'after a reload, "Status" is visible',
    ],
    ["requestMade", { kind: "requestMade", method: "POST", pathGlob: "/api/save" }, "a POST request to /api/save is sent"],
    ["responseStatus class", { kind: "responseStatus", method: "GET", pathGlob: "/api/items", status: { class: 2 } }, "GET /api/items answers 2xx"],
    ["responseStatus code", { kind: "responseStatus", method: "GET", pathGlob: "/api/items", status: { code: 201 } }, "GET /api/items answers 201"],
    [
      "long text is cut",
      { kind: "page", assertion: { kind: "urlIncludes", text: LONG } },
      `the URL contains "${LONG_CUT}"`,
    ],
    [
      "long value is cut",
      { kind: "page", assertion: { kind: "valueEquals", target: { name: "Email" }, value: LONG } },
      `"Email" has the value "${LONG_CUT}"`,
    ],
  ])("words a %s check", (_name, check, expected) => {
    expect(explainCheck(check).text).toBe(expected);
  });
});

describe("explainCheck weakness", () => {
  it.each<[string, SuccessCheck, boolean]>([
    ["an unbounded count", { kind: "page", assertion: { kind: "count", target: row } }, true],
    ["a count with min 0", { kind: "page", assertion: { kind: "count", target: row, min: 0 } }, true],
    ["a count with a min", { kind: "page", assertion: { kind: "count", target: row, min: 1 } }, false],
    ["a count with a max", { kind: "page", assertion: { kind: "count", target: row, max: 3 } }, false],
    ["a visible check", { kind: "page", assertion: { kind: "visible", target: saveButton } }, false],
    ["a reloadThen of an unbounded count", { kind: "reloadThen", assertion: { kind: "count", target: row } }, true],
    ["a reloadThen of a visible check", { kind: "reloadThen", assertion: { kind: "visible", target: saveButton } }, false],
    ["a requestMade check", { kind: "requestMade", method: "POST", pathGlob: "/api/save" }, false],
  ])("marks a %s as weak=%s", (_name, check, expected) => {
    expect(explainCheck(check).weak).toBe(expected);
  });
});
