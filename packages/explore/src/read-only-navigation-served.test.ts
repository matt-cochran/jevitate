import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeClassifier } from "@jevitate/recording";
import { ReadOnlyGuard } from "./read-only.js";
import { useSkippingTime, withSession } from "./testkit.js";

useSkippingTime({ per: "all" });

/**
 * #402: a mutation proof blocks a step's writes but must never answer one with anything that can
 * read as a success. `navigationWrites: "abort"` aborts a native form POST navigation instead of
 * answering it `204 No Content` (the find-out guard's default, which keeps the page put).
 */

const APP = `<!doctype html><html><body><form method="post" action="/api/save"><button>Save</button></form></body></html>`;
let server: Server;
let origin: string;
let posts = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "text/html" }).end(APP);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function submitUnder(navigationWrites: "no-content" | "abort" | undefined): Promise<{ status: number | null; failed: boolean; blocked: number }> {
  return withSession(
    "guard-nav",
    async (session) => {
      const page = session.page;
      await page.goto(`${origin}/`);
      const guard = new ReadOnlyGuard(writeClassifier({}), { allowlist: [origin], ...(navigationWrites === undefined ? {} : { navigationWrites }) });
      await guard.arm(page);
      let status: number | null = null;
      let failed = false;
      page.on("response", (r) => {
        if (r.request().method() === "POST") status = r.status();
      });
      page.on("requestfailed", (r) => {
        if (r.method() === "POST") failed = true;
      });
      guard.beginAction();
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForLoadState().catch(() => undefined);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 50))).catch(() => undefined);
      guard.settled();
      const blocked = guard.drain().length;
      await guard.disarm();
      return { status, failed, blocked };
    },
    origin,
  );
}

describe("ReadOnlyGuard navigationWrites (#402, served)", () => {
  it("default: a held form POST navigation is answered 204 in the browser", async () => {
    const r = await submitUnder(undefined);
    expect(r.status).toBe(204);
    expect(r.blocked).toBe(1);
  }, 60_000);

  it("abort: the same navigation is aborted, never answered", async () => {
    const r = await submitUnder("abort");
    expect(r).toEqual({ status: null, failed: true, blocked: 1 });
    expect(posts).toBe(0);
  }, 60_000);
});
