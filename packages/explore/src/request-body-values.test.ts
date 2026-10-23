import { describe, expect, it } from "vitest";
import { bodyValues } from "./request-body-values.js";

/**
 * #649: what a write sent, whoever typed it — the string values in its request body, so a prefilled
 * or generated value the app answered 2xx for awaits read-back like a typed one.
 */
describe("bodyValues (#649)", () => {
  it("collects a JSON body's nested string values", () => {
    const body = JSON.stringify({ contacts: [{ name: "Ada Lovelace", email: "ada@example.com" }] });
    expect(bodyValues(body, "application/json")).toEqual(["Ada Lovelace", "ada@example.com"]);
  });

  it("collects a form-encoded body's values", () => {
    expect(bodyValues("name=Ada+Byron&email=ada.byron%40example.com", "application/x-www-form-urlencoded")).toEqual(["Ada Byron", "ada.byron@example.com"]);
  });

  it("skips a value under a sensitive key", () => {
    expect(bodyValues(JSON.stringify({ user: "ada", password: "hunter2-long", apiToken: "tok-12345" }), "application/json")).toEqual(["ada"]);
  });

  it("keeps a value whose key only contains a credential word's letters", () => {
    expect(bodyValues(JSON.stringify({ author: "Ada Lovelace", mapping: "name,email" }), "application/json")).toEqual(["Ada Lovelace", "name,email"]);
  });

  it("skips values too short to identify anything", () => {
    expect(bodyValues(JSON.stringify({ id: "c1", flag: "y", note: "Hi there" }), "application/json")).toEqual(["Hi there"]);
  });

  it("skips numbers and booleans", () => {
    expect(bodyValues(JSON.stringify({ count: 12345, ok: true, label: "Weekly" }), "application/json")).toEqual(["Weekly"]);
  });

  it("returns nothing for a body that is neither JSON nor form-encoded", () => {
    expect(bodyValues("------boundary\r\nContent-Disposition: form-data", "multipart/form-data; boundary=----boundary")).toEqual([]);
  });

  it("returns nothing for no body", () => {
    expect(bodyValues(null, "application/json")).toEqual([]);
  });

  it("keeps at most 50 values", () => {
    const body = JSON.stringify(Array.from({ length: 80 }, (_, i) => `value number ${i}`));
    expect(bodyValues(body, "application/json")).toHaveLength(50);
  });

  it("reads a JSON body sent without a content type", () => {
    expect(bodyValues(JSON.stringify({ message: "Hello from Acme" }), undefined)).toEqual(["Hello from Acme"]);
  });
});
