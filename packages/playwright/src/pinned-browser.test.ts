import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { classifyInstalled, installBrowser, installPlan, pinnedBrowserReport, type PinnedBrowser } from "./pinned-browser.js";

const pinned: PinnedBrowser[] = [{ name: "chromium", revision: "10", dirPrefix: "chromium" }];
const fsOf = (...names: string[]) => ({ readdir: () => names });

describe("pinned browser", () => {
  it("classifies the pinned revision present as installed", () => {
    expect(classifyInstalled(pinned, "/d", fsOf("chromium-10"))[0]!.state).toBe("installed");
  });
  it("classifies an empty browsers dir as missing", () => {
    expect(classifyInstalled(pinned, "/d", fsOf())[0]!.state).toBe("missing");
  });
  it("classifies only other revisions as other-revisions-only", () => {
    expect(classifyInstalled(pinned, "/d", fsOf("chromium-9", "chromium_headless_shell-10"))[0]!.state).toBe("other-revisions-only");
  });
  it("offers the install-browser fix when not installed", () => {
    const r = pinnedBrowserReport({ env: { PLAYWRIGHT_BROWSERS_PATH: "/d" }, fs: fsOf(), pinned });
    expect(r.fix).toBe("jevitate install-browser");
  });
  it("reports the executable path playwright reports", () => {
    expect(pinnedBrowserReport({ fs: fsOf() }).executablePath).toBe(chromium.executablePath());
  });
  it("installs with PLAYWRIGHT_SKIP_BROWSER_GC=1", async () => {
    let env: NodeJS.ProcessEnv = {};
    await installBrowser({ env: {}, spawn: (_c, _a, o) => ((env = o.env ?? {}), { on: (e, cb) => void (e === "exit" && (cb as (c: number) => void)(0)) }) });
    expect(env.PLAYWRIGHT_SKIP_BROWSER_GC).toBe("1");
  });
  it("passes PLAYWRIGHT_BROWSERS_PATH through to the install", () => {
    expect(installPlan({ env: { PLAYWRIGHT_BROWSERS_PATH: "/shared" } }).env.PLAYWRIGHT_BROWSERS_PATH).toBe("/shared");
  });
  it("forwards --with-deps to the playwright install", () => {
    expect(installPlan({ withDeps: true }).args).toContain("--with-deps");
  });
});
