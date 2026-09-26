import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, coveredByInterceptors, failureLine, occluderOf, snapshot } from "./index.js";
import { withSession } from "./testkit.js";

/**
 * #90 — an sr-only input whose visible label is the real click target (the node-inspector overlay
 * in Preveti J2). The input's own box is pulled off-screen, so probing it says nothing about the
 * label a user actually clicks: the occlusion check runs at the label, the click goes through the
 * label, and a covered label is refused in well under Playwright's 30s default — never waited out.
 */

const SR_ONLY = "position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden";

const PAGES: Record<string, string> = {
  "/sr": `<!doctype html><html><body>
    <p id="state">unchecked</p>
    <div style="margin:40px">
      <input type="checkbox" id="agree" style="${SR_ONLY}"
        onchange="document.getElementById('state').textContent = this.checked ? 'checked' : 'unchecked'" />
      <label for="agree" data-testid="agree-label" style="display:inline-block;padding:12px 24px;background:#cde">I agree</label>
    </div>
    <div id="inspector" data-testid="inspector"
      style="display:none;position:fixed;top:0;left:0;bottom:0;width:70%;background:rgba(255,255,255,.95)">
      <button type="button">Close inspector</button>
    </div>
  </body></html>`,
  // The same sr-only input wrapped by its label.
  "/wrap": `<!doctype html><html><body>
    <p id="state">off</p>
    <label style="display:inline-block;padding:12px 24px;margin:40px;background:#cde">
      <input type="radio" name="plan" id="pro" style="${SR_ONLY}"
        onchange="document.getElementById('state').textContent = 'pro'" /> Pro plan
    </label>
  </body></html>`,
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("#90 — an sr-only input is judged and clicked at its visible label", () => {
  it("clicks an uncovered sr-only checkbox through its label, fast", async () => {
    await withSession(
      "sr-only-click-",
      async (session) => {
        await session.page.goto(`${origin}/sr`, { waitUntil: "domcontentloaded" });
        const agree = (await snapshot(session.page)).controls.find((c) => c.name === "I agree");
        if (agree === undefined) throw new Error("the sr-only checkbox must be offered (its label is visible and uncovered)");
        const actor = CastActor.named("sr-only").whoCan(new BrowseTheWeb(session, [origin]));
        const started = Date.now();
        const r = await act(actor, { op: "click", control: agree });
        expect(r).toEqual({ ok: true, mutated: true });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await session.page.locator("#state").textContent()).toBe("checked");
      },
      origin,
    );
  });

  it("clicks an sr-only radio wrapped by its label", async () => {
    await withSession(
      "sr-only-wrap-",
      async (session) => {
        await session.page.goto(`${origin}/wrap`, { waitUntil: "domcontentloaded" });
        const pro = (await snapshot(session.page)).controls.find((c) => /Pro plan/.test(c.name));
        if (pro === undefined) throw new Error("the wrapped sr-only radio must be offered");
        const actor = CastActor.named("sr-only").whoCan(new BrowseTheWeb(session, [origin]));
        expect(await act(actor, { op: "click", control: pro })).toEqual({ ok: true, mutated: true });
        expect(await session.page.locator("#state").textContent()).toBe("pro");
      },
      origin,
    );
  });

  it("an overlay over the LABEL covers the input: not offered, and a stale decision is refused fast (no 30s timeout)", async () => {
    await withSession(
      "sr-only-covered-",
      async (session) => {
        await session.page.goto(`${origin}/sr`, { waitUntil: "domcontentloaded" });
        const agree = (await snapshot(session.page)).controls.find((c) => c.name === "I agree");
        if (agree === undefined) throw new Error("offered while uncovered");
        // The inspector panel opens over the label (the input's own off-screen box is not under it).
        await session.page.evaluate(() => {
          const o = document.getElementById("inspector");
          if (o !== null) o.style.display = "block";
        });
        const names = (await snapshot(session.page)).controls.map((c) => c.name);
        expect(names).not.toContain("I agree");
        expect(names).toContain("Close inspector");
        const covered = await session.page.locator("#agree").evaluate(occluderOf);
        expect(covered).toBe("[data-testid=inspector]");

        const actor = CastActor.named("sr-only").whoCan(new BrowseTheWeb(session, [origin]));
        const started = Date.now();
        const r = await act(actor, { op: "click", control: agree });
        expect(r).toEqual({ ok: false, mutated: false, reason: "target obscured by [data-testid=inspector]" });
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(await session.page.locator("#state").textContent()).toBe("unchecked");
      },
      origin,
    );
  });

  it("an sr-only input with no visible label is refused up front, never clicked blind", async () => {
    await withSession(
      "sr-only-nolabel-",
      async (session) => {
        await session.page.goto(`${origin}/sr`, { waitUntil: "domcontentloaded" });
        const agree = (await snapshot(session.page)).controls.find((c) => c.name === "I agree");
        if (agree === undefined) throw new Error("offered while its label is visible");
        await session.page.evaluate(() => {
          const l = document.querySelector<HTMLElement>("[data-testid=agree-label]");
          if (l !== null) l.style.visibility = "hidden";
        });
        const actor = CastActor.named("sr-only").whoCan(new BrowseTheWeb(session, [origin]));
        const started = Date.now();
        const r = await act(actor, { op: "click", control: agree });
        expect(r.ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(await session.page.locator("#state").textContent()).toBe("unchecked");
      },
      origin,
    );
  });
});

describe("failureLine — a Playwright click failure names what intercepted it (#90)", () => {
  it("appends the 'intercepts pointer events' log line to the first line", () => {
    const msg = [
      "locator.click: Timeout 5000ms exceeded.",
      "Call log:",
      "  - waiting for getByRole('radio', { name: 'Yes' })",
      '    - <div class="inspector">…</div> intercepts pointer events',
      "  - retrying click action",
    ].join("\n");
    expect(failureLine(msg)).toBe('locator.click: Timeout 5000ms exceeded. (<div class="inspector">…</div> intercepts pointer events)');
    expect(failureLine("boom\nmore")).toBe("boom");
  });

  it("#188: a timeout keeps the call log's last actionability state (why Playwright never clicked)", () => {
    const msg = [
      "locator.click: Timeout 5000ms exceeded.",
      "Call log:",
      "  - waiting for getByTestId('login-verify-2fa')",
      "    - locator resolved to <button type=\"submit\">Verify</button>",
      "  - attempting click action",
      "    2 × waiting for element to be visible, enabled and stable",
      "      - element is not stable",
      "    - retrying click action",
      "    - waiting 20ms",
    ].join("\n");
    expect(failureLine(msg)).toBe("locator.click: Timeout 5000ms exceeded. (element is not stable)");
    expect(failureLine("locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByText('x')")).toBe(
      "locator.click: Timeout 5000ms exceeded.",
    );
  });
});

describe("coveredByInterceptors — geometric deprioritisation after a proven click failure (#90)", () => {
  it("a control under the interceptor's live box is covered — checked at its LABEL for an sr-only input", async () => {
    await withSession(
      "sr-only-interceptor-covered-",
      async (session) => {
        await session.page.goto(`${origin}/sr`, { waitUntil: "domcontentloaded" });
        await session.page.evaluate(() => {
          const o = document.getElementById("inspector");
          if (o !== null) o.style.display = "block";
        });
        const covered = await session.page.locator("#agree").evaluate(coveredByInterceptors, ['[data-testid="inspector"]']);
        expect(covered).toBe(true);
      },
      origin,
    );
  });

  it("not covered once the interceptor is hidden again (display:none) — the geometric fallback still respects visibility", async () => {
    await withSession(
      "sr-only-interceptor-hidden-",
      async (session) => {
        await session.page.goto(`${origin}/sr`, { waitUntil: "domcontentloaded" });
        // The inspector starts hidden (display:none) on this fixture — the interceptor is still
        // present in the DOM (as it would be for a closed-but-not-removed modal) but not visible.
        const covered = await session.page.locator("#agree").evaluate(coveredByInterceptors, ['[data-testid="inspector"]']);
        expect(covered).toBe(false);
      },
      origin,
    );
  });

  it("not covered when the tracked selector matches nothing on the page", async () => {
    await withSession(
      "sr-only-interceptor-nomatch-",
      async (session) => {
        await session.page.goto(`${origin}/sr`, { waitUntil: "domcontentloaded" });
        await session.page.evaluate(() => {
          const o = document.getElementById("inspector");
          if (o !== null) o.style.display = "block";
        });
        const covered = await session.page.locator("#agree").evaluate(coveredByInterceptors, ['[data-testid="nope"]']);
        expect(covered).toBe(false);
      },
      origin,
    );
  });
});
