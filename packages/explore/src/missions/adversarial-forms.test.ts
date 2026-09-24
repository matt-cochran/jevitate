import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { VerifySession } from "../verify-fix.js";
import { runAdversarialMission, type AdversarialMissionParams, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { withSession } from "../testkit.js";

/**
 * #64 — adversarial coverage on an ordinary form. A served profile page (text fields, a select,
 * Cancel and Save; Save PUTs to the API after a short delay, then shows a toast) must get
 * submit-centred misuse: double submits, boundary submits, edit→cancel→save, leaving with unsaved
 * edits, and acting while the save is still pending.
 */

const state = { puts: 0, lastName: "Lovelace" };

const PROFILE = (): string => `<!doctype html><html><body>
  <h1>Profile</h1>
  <a href="#" id="ws" onclick="location.href='/'; return false;">Change workspace</a>
  <form id="profile" onsubmit="return false;">
    <label>First name <input name="first" aria-label="First name" value="Ada" /></label>
    <label>Last name <input name="last" aria-label="Last name" value="${state.lastName}" /></label>
    <label>Email <input name="email" type="email" aria-label="Email" value="ada@example.test" /></label>
    <label>Role <select name="role" aria-label="Role"><option>Admin</option><option>Member</option></select></label>
    <button type="button" id="cancel">Cancel</button>
    <button type="submit" id="save">Save</button>
  </form>
  <div id="toast" role="status"></div>
  <script>
    document.getElementById("profile").addEventListener("submit", async () => {
      const body = JSON.stringify({ last: document.querySelector("[name=last]").value });
      await fetch("/api/profile", { method: "PUT", body, headers: { "content-type": "application/json" } });
      document.getElementById("toast").textContent = "Saved";
    });
  </script>
</body></html>`;

const HOME = `<!doctype html><html><body><h1>Workspaces</h1>
  <button type="button">Acme</button><button type="button">Globex</button></body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/profile" && req.method === "PUT") {
      state.puts += 1;
      // Slow enough that a second action lands while the save is still in flight.
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 300);
      return;
    }
    if (path === "/app/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PROFILE());
      return;
    }
    if (path === "/app/old") {
      res.writeHead(302, { location: "/" }).end();
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOME);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const port = new PlaywrightBrowserPort();
const opened: string[] = [];
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  opened.push("fresh");
  const actor = CastActor.named("fresh").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

async function huntProfile(
  strategies: readonly MisuseStrategy[],
  extra: Partial<AdversarialMissionParams> = {},
): Promise<AdversarialOutcome> {
  return withSession(
    "adv-forms-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}/app/profile`,
        allowlist: [origin],
        strategies,
        ...extra,
      });
    },
    origin,
  );
}

describe("adversarial — form-aware misuse (#64)", () => {
  it(
    "a form page gets submit-centred misuse, including Save clicks, a double submit and a pending-save race",
    async () => {
      state.puts = 0;
      const result = await huntProfile(
        ["double-submit", "boundary-submit", "edit-cancel-save", "navigate-away-unsaved", "act-while-pending"],
        { bounds: { maxDecisions: 5 } },
      );

      expect(result.outcome).not.toBe("crashed");
      const steps = result.transcript;
      const byStrategy = (s: string) => steps.filter((e) => e.strategy === s);

      // Every form strategy found something to do on an ordinary form.
      for (const s of ["double-submit", "boundary-submit", "edit-cancel-save", "navigate-away-unsaved", "act-while-pending"]) {
        expect(byStrategy(s).length, s).toBeGreaterThan(0);
        expect(byStrategy(s).some((e) => e.reason?.includes("strategy found no applicable action")), s).toBe(false);
      }

      const saves = steps.filter((e) => e.op === "click" && e.target?.includes('"Save"') === true && e.actOk);
      expect(saves.length).toBeGreaterThanOrEqual(3);

      // double-submit: two Save clicks, the second before the first settled.
      expect(byStrategy("double-submit").map((e) => e.op)).toEqual(["type", "click", "click"]);
      expect(byStrategy("double-submit")[2]?.reason).toContain("submit again before the first submit settled");

      // edit → cancel → save.
      expect(byStrategy("edit-cancel-save").map((e) => e.target)).toEqual([
        expect.stringMatching(/textbox|combobox/),
        expect.stringContaining("Cancel"),
        expect.stringContaining("Save"),
      ]);

      // leave with an unsaved edit.
      const away = byStrategy("navigate-away-unsaved");
      expect(["type", "select"]).toContain(away[0]?.op);
      expect(away[1]?.op).toBe("reload");
      expect(away[1]?.actOk).toBe(true);

      // act while the save is in flight: the submit left a request pending, then the next action fired.
      const pending = byStrategy("act-while-pending");
      expect(pending.map((e) => e.op)).toEqual(["type", "click", "click"]);
      expect(pending[1]?.reason).toMatch(/request\(s\) in flight/);

      // The server really received the saves (the misuse is real, not simulated).
      expect(state.puts).toBeGreaterThanOrEqual(3);

      // Every executed action is in the Recording (the repro path): fills and clicks by descriptor.
      const kinds = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step.kind));
      expect(kinds.filter((k) => k === "click").length).toBeGreaterThanOrEqual(saves.length);
      expect(kinds).toContain("fill");
    },
    180_000,
  );
});

describe("adversarial — scope containment (#64)", () => {
  it(
    "an action that leaves the target is recorded, the run resets to the start URL in a fresh page, and keeps exploring the target",
    async () => {
      opened.length = 0;
      const result = await huntProfile(["exercise-controls"], {
        bounds: { maxDecisions: 6 },
        openFreshSession: freshSession,
      });
      expect(result.outcome).not.toBe("crashed");

      // "Change workspace" (an in-page link whose script navigates to /) left the scope once.
      expect(result.scope.routeGlobs).toEqual(["/app/profile", "/app/profile/", "/app/profile/**"]);
      expect(result.scope.outOfScopeSteps).toBe(1);
      expect(result.scope.departures).toEqual([
        { step: expect.any(Number), url: `${origin}/`, action: "Change workspace" },
      ]);
      // Reset in a FRESH page (a new context), not by navigating the page it left.
      expect(result.scope.resets).toBe(1);
      expect(opened).toHaveLength(1);

      const t = result.transcript;
      const reset = t.findIndex((e) => e.strategy === "scope-reset");
      expect(reset).toBeGreaterThan(0);
      expect(t[reset]?.reason).toContain("reset to the start URL in a fresh page");
      // After the reset the run is back on the target and goes on exercising ITS controls; the
      // departing control is not clicked again.
      const after = t.slice(reset + 1);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((e) => e.url.endsWith("/app/profile"))).toBe(true);
      expect(after.map((e) => e.target)).toEqual(
        expect.arrayContaining([expect.stringContaining("First name"), expect.stringContaining("Last name")]),
      );
      expect(after.some((e) => e.target?.includes("Change workspace") === true)).toBe(false);
      // No step ever ran on the page outside the scope.
      expect(t.filter((e) => e.strategy === "exercise-controls").every((e) => e.url.endsWith("/app/profile"))).toBe(true);
    },
    180_000,
  );

  it(
    "a start URL that redirects out of its own scope proves nothing: inconclusive, never clean",
    async () => {
      const result = await huntProfile(["exercise-controls"], { seedUrl: `${origin}/app/old`, bounds: { maxDecisions: 3 } });
      expect(result.outcome).toBe("inconclusive");
      expect(result.stop).toBe("scope-unreachable");
      expect(result.failure).toEqual({
        kind: "target-unreachable",
        message: `the start URL left the target scope (landed on ${origin}/)`,
      });
      expect(result.transcript).toHaveLength(1);
    },
    180_000,
  );

  it(
    "extra --route globs widen the scope (the departure target becomes part of it)",
    async () => {
      const result = await huntProfile(["exercise-controls"], { bounds: { maxDecisions: 2 }, routeGlobs: ["/"] });
      expect(result.scope.routeGlobs).toContain("/");
      expect(result.scope.outOfScopeSteps).toBe(0);
    },
    180_000,
  );
});
