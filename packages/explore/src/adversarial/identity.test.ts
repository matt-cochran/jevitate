import { describe, expect, test } from "vitest";
import { identityChange, identityEntry, isAuthName, isAuthRequest, type IdentityFingerprint } from "./identity.js";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: unknown): string => `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
const fp = (entries: Record<string, string>): IdentityFingerprint => ({
  entries: new Map(Object.entries(entries).map(([k, v]) => [k, identityEntry(v)])),
  read: new Set(["cookie", "storage"]),
});

describe("#300 identity fingerprint", () => {
  test("keeps hashes only — never the raw value", () => {
    const e = identityEntry("super-secret-session-value");
    expect(JSON.stringify(e)).not.toContain("super-secret");
    expect(e.value).toMatch(/^[0-9a-f]{16}$/);
  });

  test("an auth entry that appears (signed in from a logged-out page) is a change, named by name only", () => {
    const why = identityChange(fp({}), fp({ "cookie:sid": "demo" }), { authRequest: false });
    expect(why).toMatch(/appeared \(cookie:sid\)/);
    expect(why).not.toContain("demo");
  });

  test("a JWT for another subject is a change; a refreshed JWT for the same subject is not", () => {
    const alice = fp({ "local:auth_token": jwt({ sub: "alice", iat: 1 }) });
    const aliceRefreshed = fp({ "local:auth_token": jwt({ sub: "alice", iat: 2 }) });
    const demo = fp({ "local:auth_token": jwt({ sub: "demo", iat: 2 }) });
    expect(identityChange(alice, aliceRefreshed, { authRequest: true })).toBeNull();
    expect(identityChange(alice, demo, { authRequest: false })).toMatch(/subject/);
  });

  test("a swapped tenant claim is a change; a JWT nested in a JSON entry is read", () => {
    const a = fp({ "local:sb-auth-token": JSON.stringify({ access_token: jwt({ sub: "u1", tenant: "t1" }) }) });
    const b = fp({ "local:sb-auth-token": JSON.stringify({ access_token: jwt({ sub: "u1", tenant: "t2" }) }) });
    expect(identityChange(a, b, { authRequest: false })).toMatch(/subject/);
  });

  test("an opaque session value re-issued without an auth request is not a change; with one it is", () => {
    const a = fp({ "cookie:sid": "alice" });
    const b = fp({ "cookie:sid": "rotated" });
    expect(identityChange(a, b, { authRequest: false })).toBeNull();
    expect(identityChange(a, b, { authRequest: true })).toMatch(/re-issued/);
  });

  test("a source that could not be read (no document yet) is never read as 'removed'", () => {
    const base = fp({ "local:auth_token": "x", "cookie:sid": "a" });
    const now: IdentityFingerprint = { entries: new Map([["cookie:sid", identityEntry("a")]]), read: new Set(["cookie"]) };
    expect(identityChange(base, now, { authRequest: false })).toBeNull();
  });

  test("auth names and auth requests", () => {
    expect(isAuthName("sid")).toBe(true);
    expect(isAuthName("session_id")).toBe(true);
    expect(isAuthName("theme")).toBe(false);
    expect(isAuthRequest("http://127.0.0.1/api/demo-login")).toBe(true);
    expect(isAuthRequest("http://127.0.0.1/api/v1/auth.Login")).toBe(true);
    expect(isAuthRequest("http://127.0.0.1/api/comments")).toBe(false);
  });
});
