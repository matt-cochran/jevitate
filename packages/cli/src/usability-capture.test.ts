import { describe, expect, it } from "vitest";
import { payloadDigest } from "./usability-capture.js";

// #131: the duplicate-create oracle compares one-way body digests; the body itself is never kept.
describe("payloadDigest", () => {
  const ep = "POST /v1/participants";

  it("is equal for the same payload, ignoring key order and volatile keys (ids, timestamps, nonces)", () => {
    const a = payloadDigest("POST", ep, JSON.stringify({ name: "Dana", email: "d@example.com", clientId: "c1", createdAt: 1 }), []);
    const b = payloadDigest("post", ep, JSON.stringify({ createdAt: 2, email: "d@example.com", clientId: "c2", name: "Dana" }), []);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).not.toContain("Dana");
    expect(payloadDigest("POST", ep, JSON.stringify({ name: "Grace", email: "d@example.com" }), [])).not.toBe(a);
    expect(payloadDigest("POST", "POST /v1/other", JSON.stringify({ name: "Dana", email: "d@example.com" }), [])).not.toBe(a);
  });

  it("digests form bodies too", () => {
    expect(payloadDigest("POST", ep, "name=Dana&email=d%40example.com", [])).toBe(payloadDigest("POST", ep, "email=d%40example.com&name=Dana", []));
  });

  it("never digests a body holding a secret, a credential-named field, or an unparseable/empty/huge body", () => {
    expect(payloadDigest("POST", ep, JSON.stringify({ note: "hunter2-secret" }), ["hunter2-secret"])).toBeUndefined();
    expect(payloadDigest("POST", ep, JSON.stringify({ email: "a@b.c", password: "x" }), [])).toBeUndefined();
    expect(payloadDigest("POST", ep, JSON.stringify({ user: { otp: "123456" } }), [])).toBeUndefined();
    expect(payloadDigest("POST", ep, "\u0000\u0001binary", [])).toBeUndefined();
    expect(payloadDigest("POST", ep, null, [])).toBeUndefined();
    expect(payloadDigest("POST", ep, JSON.stringify({ blob: "x".repeat(70_000) }), [])).toBeUndefined();
  });
});
