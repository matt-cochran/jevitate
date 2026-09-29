import { describe, expect, test } from "vitest";
import { seedRedirectReason } from "./seed-redirect.js";

describe("seedRedirectReason (#82)", () => {
  test("null when the landed path matches the seed's — the mission is testing what it was asked to", () => {
    expect(seedRedirectReason("https://app.test/projects", "https://app.test/projects?x=1")).toBeNull();
  });

  test("a login-like landed path gets the specific authentication reason, marked loginLike", () => {
    const r = seedRedirectReason("https://app.test/projects", "https://app.test/login");
    expect(r).toEqual({
      reason: "seed /projects redirected to /login — the --storage-state session is not authenticated",
      loginLike: true,
    });
  });

  test("recognises common login-like path spellings (signin, sign-in, auth, sso)", () => {
    for (const path of ["/signin", "/sign-in", "/auth", "/sso", "/account/login"]) {
      const r = seedRedirectReason("https://app.test/projects", `https://app.test${path}`);
      expect(r?.loginLike).toBe(true);
    }
  });

  test("a non-login different path still reports a redirect, but not loginLike", () => {
    const r = seedRedirectReason("https://app.test/app/old", "https://app.test/");
    expect(r).toEqual({ reason: "seed /app/old redirected to /", loginLike: false });
  });

  test("malformed URLs never throw — treated as no redirect", () => {
    expect(seedRedirectReason("not a url", "also not a url")).toBeNull();
  });
});
