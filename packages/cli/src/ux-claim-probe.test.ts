import { describe, expect, it } from "vitest";
import { looksDestructive } from "./ux-claim-probe.js";

describe("#198 guard probe: destructive-looking requests are aborted whatever their method", () => {
  it("matches destructive verbs in the path, the query, RPC names and the body", () => {
    expect(looksDestructive("https://app.test/delete?id=1")).toBe(true);
    expect(looksDestructive("https://app.test/items?action=remove&id=3")).toBe(true);
    expect(looksDestructive("https://app.test/rpc/acme.v1.UserService/DeleteUser")).toBe(true);
    expect(looksDestructive("https://app.test/api/projects/7/archive")).toBe(true);
    expect(looksDestructive("https://app.test/api/x", '{"method":"purgeCache"}')).toBe(true);
    expect(looksDestructive("https://app.test/api/x?op=revoke%20token")).toBe(true);
  });

  it("leaves ordinary reads alone", () => {
    expect(looksDestructive("https://app.test/settings/danger")).toBe(false);
    expect(looksDestructive("https://app.test/api/users?page=2")).toBe(false);
    expect(looksDestructive("https://app.test/api/x", '{"name":"Ada"}')).toBe(false);
  });
});
