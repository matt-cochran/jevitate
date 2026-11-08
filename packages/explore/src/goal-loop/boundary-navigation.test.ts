import { describe, expect, it } from "vitest";
import { newTabBoundary, offAllowlistBoundary, offAllowlistOrigin, watchNewTab } from "./boundary-navigation.js";

const allow = ["http://127.0.0.1:5000"];

describe("boundary-navigation (#807)", () => {
  it("names the origin of a link off the allowlist, and nothing for one that stays", () => {
    expect(offAllowlistOrigin("http://localhost:6000/authorize?x=1", allow)).toBe("http://localhost:6000");
    expect(offAllowlistOrigin("http://127.0.0.1:5000/reports", allow)).toBeNull();
    expect(offAllowlistOrigin("mailto:a@b.c", allow)).toBeNull();
    expect(offAllowlistOrigin(null, allow)).toBeNull();
    expect(offAllowlistOrigin("not a url", allow)).toBeNull();
  });
  it("builds boundaries carrying the origin, with no control JSON in the reason", () => {
    const off = offAllowlistBoundary(2, "https://sso.example.com");
    expect(off).toMatchObject({ kind: "off-allowlist", signal: "write-refused", origin: "https://sso.example.com", step: 2 });
    const tab = newTabBoundary(0, "http://127.0.0.1:5000");
    expect(tab).toMatchObject({ kind: "new-tab", signal: "tab-opened", step: 1 });
    expect(off.reason + tab.reason).not.toContain("{");
  });
  it("watchNewTab closes the tab and prefers the link's origin", async () => {
    let handler: ((p: { url(): string; close(): Promise<void> }) => void) | undefined;
    let closed = false;
    const page = { on: (_e: string, h: typeof handler) => ((handler = h), page), off: () => page } as never;
    const watch = watchNewTab(page);
    handler?.({ url: () => "about:blank", close: async () => void (closed = true) });
    expect(await watch.opened("http://127.0.0.1:5000/reports/q3")).toBe("http://127.0.0.1:5000");
    expect(closed).toBe(true);
    watch.dispose();
  });
});
