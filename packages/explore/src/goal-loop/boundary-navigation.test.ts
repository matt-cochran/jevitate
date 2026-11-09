import { describe, expect, it } from "vitest";
import { newTabBoundary, offAllowlistBoundary, offAllowlistOrigin, opensNewTab, watchNewTab } from "./boundary-navigation.js";

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
  it("opensNewTab reads a link's target from the DOM; a failed read is false", async () => {
    const el = (target: string | null) => ({ closest: () => ({ getAttribute: () => target }) }) as unknown as Element;
    const at = (e: Element) => ({ evaluate: async <R>(fn: (el: Element) => R) => fn(e) });
    expect(await opensNewTab(at(el("_blank")))).toBe(true);
    expect(await opensNewTab(at(el("reports-window")))).toBe(true);
    expect(await opensNewTab(at(el("_self")))).toBe(false);
    expect(await opensNewTab(at(el(null)))).toBe(false);
    expect(await opensNewTab({ evaluate: async () => Promise.reject(new Error("gone")) })).toBe(false);
  });
  it("names the tab boundary found before the click as not followed", () => {
    expect(newTabBoundary(1, "http://127.0.0.1:5000", { beforeClick: true }).reason).toMatch(/stopped before following it/);
  });
});
