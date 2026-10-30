import { describe, expect, it } from "vitest";
import { NetworkCheckSchema, OutcomeCheckSchema } from "./schema.js";

const requestMade = { kind: "requestMade", method: "POST", pathGlob: "/api/orders" };
const responseStatus = { kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } };

describe("network check count bounds (#743)", () => {
  it("accepts a requestMade with an exact count", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, count: { exact: 1 } }).success).toBe(true);
  });

  it("accepts a requestMade with a minimum count", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, count: { min: 2 } }).success).toBe(true);
  });

  it("accepts a responseStatus with a maximum count", () => {
    expect(NetworkCheckSchema.safeParse({ ...responseStatus, count: { max: 3 } }).success).toBe(true);
  });

  it("accepts a requestMade written before count bounds existed", () => {
    expect(NetworkCheckSchema.safeParse(requestMade).success).toBe(true);
  });

  it("accepts a responseStatus written before count bounds existed", () => {
    expect(NetworkCheckSchema.safeParse(responseStatus).success).toBe(true);
  });

  it("refuses a negative count bound", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, count: { exact: -1 } }).success).toBe(false);
  });

  it("refuses a count object that names no bound", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, count: {} }).success).toBe(false);
  });
});

describe("network check request-body field shape (#743)", () => {
  const bodyShape = { fields: [{ name: "orderId", predicate: "string" }, { name: "items", predicate: "array" }] };

  it("accepts a declared shape of field names and predicates", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, bodyShape }).success).toBe(true);
  });

  it("accepts a declared body shape on a responseStatus check", () => {
    expect(NetworkCheckSchema.safeParse({ ...responseStatus, bodyShape }).success).toBe(true);
  });

  it("refuses a body field that carries a literal value", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, bodyShape: { fields: [{ name: "orderId", predicate: "string", value: "acme-42" }] } }).success).toBe(false);
  });

  it("refuses a body field whose name is a credential", () => {
    expect(NetworkCheckSchema.safeParse({ ...requestMade, bodyShape: { fields: [{ name: "password", predicate: "exists" }] } }).success).toBe(false);
  });
});

describe("count-bounded network checks as Journey outcomes (#743)", () => {
  it("accepts a count-bounded responseStatus outcome check", () => {
    expect(OutcomeCheckSchema.safeParse({ ...responseStatus, count: { min: 1 } }).success).toBe(true);
  });
});
