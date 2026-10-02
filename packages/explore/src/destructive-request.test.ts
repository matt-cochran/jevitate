import { describe, expect, it } from "vitest";
import { isDestructiveRequest, looksDestructiveRequest } from "./read-only.js";

describe("#198 × #270 — one destructive-request classifier, two strengths", () => {
  it("the fail-safe reading holds everything the precise one does, plus a destructive verb anywhere", () => {
    expect(isDestructiveRequest("DELETE", "/api/items/1")).toBe(true);
    expect(looksDestructiveRequest("DELETE", "https://app.test/api/items/1")).toBe(true);
    expect(isDestructiveRequest("POST", "/rpc/acme.v1.Team/KickMember")).toBe(true);
    expect(looksDestructiveRequest("POST", "https://app.test/rpc/acme.v1.Team/KickMember")).toBe(true);
    expect(looksDestructiveRequest("GET", "https://app.test/delete?id=1")).toBe(true);
    expect(looksDestructiveRequest("GET", "https://app.test/api/x?state=removing")).toBe(true);
    expect(looksDestructiveRequest("POST", "https://app.test/api/x", '{"op":"deleteAll"}')).toBe(true);
    expect(looksDestructiveRequest("POST", "https://app.test/api/projects/7/archive")).toBe(true);
  });

  it("a longer word that merely starts with a verb is not one", () => {
    expect(looksDestructiveRequest("GET", "https://app.test/assets/banner.png")).toBe(false);
    expect(looksDestructiveRequest("GET", "https://app.test/ui/dropdown?kickoff=1")).toBe(false);
    expect(looksDestructiveRequest("GET", "https://app.test/api/users?page=2")).toBe(false);
  });
});
