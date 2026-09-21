import { describe, expect, test } from "vitest";
import { isNon5xxResourceConsoleError } from "./defect-oracle.js";

// Ticket #29: Chromium logs a browser-generated console "error" for EVERY
// failed resource load — including a legitimate 4xx the app returns by design
// during misuse. The spec scopes the HTTP hard-signal to 5xx, so a 4xx
// resource-load console error is NOT a defect signal, while real app
// console.error() calls, unhandled page errors and 5xx must still gate.
describe("isNon5xxResourceConsoleError (spec §9: HTTP signal is 5xx-only)", () => {
  test("a 4xx resource-load console error is scoped OUT (not a defect)", () => {
    expect(
      isNon5xxResourceConsoleError("Failed to load resource: the server responded with a status of 404 (Not Found)"),
    ).toBe(true);
    expect(
      isNon5xxResourceConsoleError("Failed to load resource: the server responded with a status of 403 (Forbidden)"),
    ).toBe(true);
    expect(
      isNon5xxResourceConsoleError("Failed to load resource: the server responded with a status of 400 (Bad Request)"),
    ).toBe(true);
  });

  test("a 5xx resource-load console error is NOT scoped out — 5xx must still gate", () => {
    expect(
      isNon5xxResourceConsoleError("Failed to load resource: the server responded with a status of 500 (Internal Server Error)"),
    ).toBe(false);
    expect(
      isNon5xxResourceConsoleError("Failed to load resource: the server responded with a status of 503 (Service Unavailable)"),
    ).toBe(false);
  });

  test("a real app console.error is NOT scoped out — genuine errors must still gate", () => {
    expect(isNon5xxResourceConsoleError("synthetic-boom")).toBe(false);
    expect(isNon5xxResourceConsoleError("Uncaught TypeError: x is not a function")).toBe(false);
    expect(isNon5xxResourceConsoleError("")).toBe(false);
  });
});
