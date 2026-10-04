import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { SuccessCheck } from "../success-checks.js";
import { runGoalBasedMission, type GoalBasedMissionConfig, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #376 — `textIncludes:text=Coming soon|Coming soon` "did not hold" on a page showing several
 * `<span>Coming soon</span>` badges: the text was read only when the target matched exactly ONE
 * element, so two matches (one in a closed `<details>`) read as nothing. It now holds when any
 * visible match's text includes it.
 *
 * #377 — `--success-when held|each` + `--allow-vacuous-checks` on a start page that already shows the
 * goal: the hold never counted (only a not-holding → holding change did), and the model's `blocked`
 * was refused as "nothing tried yet" (#237) until the run ended inconclusive.
 */
const page = (body: string): string => `<!doctype html><html><body>
<nav><a href="/home">Home</a> <a href="/settings">Settings</a></nav>${body}</body></html>`;
const PAGES: Record<string, string> = {
  "/badges": page(`<h1>Allowances</h1>
<details><summary>Archived</summary><span>Coming soon</span></details>
<ul><li>Travel <span class="badge">Coming soon</span></li><li>Meals <span class="badge">Coming soon</span></li></ul>`),
  "/hidden-only": page(`<h1>Allowances</h1><details><summary>Archived</summary><span>Coming soon</span></details>`),
  "/launch": page(`<h1>Welcome</h1><p>Acme is getting set up</p>`),
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) =>
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[req.url ?? ""] ?? page("<h1>Other</h1>")),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const exactText = (t: string): SuccessCheck => ({ kind: "page", assertion: { kind: "textIncludes", target: { text: t }, text: t } });
const bodyText = (t: string): SuccessCheck => ({ kind: "page", assertion: { kind: "textIncludes", target: { css: "body" }, text: t } });

async function run(
  path: string,
  successChecks: SuccessCheck[],
  opts: Pick<GoalBasedMissionConfig, "successWhen" | "allowVacuousChecks">,
  gives: "blocked" | "done" = "blocked",
): Promise<GoalBasedResult> {
  // A model that never acts: it always gives up (#237's insisting model), or always says done.
  const judge = new PreferenceJudge(() => [], gives);
  judge.goalMetProbability = 0.1;
  return withSession(
    "success-376-377-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin])),
        judge,
        gen: new FakeGenerationGateway({}),
        goal: "Check that the page says the site is getting set up",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successChecks,
        ...opts,
        oracleTimeoutMs: 500,
        waitOpMs: 300,
        bounds: { maxDecisions: 8 },
      }),
    origin,
  );
}

const refusedEarly = (r: GoalBasedResult): boolean => r.transcript.some((e) => /nothing was tried yet/.test(e.reason ?? ""));

describe("#376 — text= over several matching elements", () => {
  it("holds when a visible element's whole text is exactly the text, even with a hidden copy first", async () => {
    const r = await run("/badges", [exactText("Coming soon")], { successWhen: "held", allowVacuousChecks: true });
    expect(r.checks.map((c) => [c.check, c.passed])).toEqual([["textIncludes:text=Coming soon|Coming soon", true]]);
    expect(r.outcome).toBe("succeeded");
  }, 60_000);

  it("does not hold when the only match is hidden (a closed <details>)", async () => {
    const r = await run("/hidden-only", [exactText("Coming soon")], { allowVacuousChecks: true }, "done");
    expect(r.checks[0]?.passed).toBe(false);
    expect(r.outcome).not.toBe("succeeded");
  }, 60_000);
});

describe("#377 — --allow-vacuous-checks under held/each, and an early blocked while the checks hold", () => {
  it("held + --allow-vacuous-checks: a start page that already shows the goal succeeds without acting", async () => {
    const r = await run("/launch", [bodyText("is getting set up")], { successWhen: "held", allowVacuousChecks: true });
    expect(r.outcome).toBe("succeeded");
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(refusedEarly(r)).toBe(false);
    expect(r.transcript.filter((e) => e.op === "click" || e.op === "type")).toHaveLength(0);
    // Named, but only as allowed — never "vacuous, not counted".
    expect((r.warnings ?? []).every((w) => /allowed by --allow-vacuous-checks/.test(w))).toBe(true);
  }, 60_000);

  it("each + --allow-vacuous-checks: the same", async () => {
    const r = await run("/launch", [bodyText("is getting set up"), bodyText("Welcome")], { successWhen: "each", allowVacuousChecks: true });
    expect(r.outcome).toBe("succeeded");
    expect(refusedEarly(r)).toBe(false);
  }, 60_000);

  it("held without --allow-vacuous-checks: `blocked` while the checks hold is not refused; the run ends inconclusive (vacuous)", async () => {
    const r = await run("/launch", [bodyText("is getting set up")], { successWhen: "held" });
    expect(refusedEarly(r)).toBe(false);
    expect(r.run.stop).toBe("blocked");
    expect(r.outcome).toBe("inconclusive");
    expect(r.checks[0]?.detail).toMatch(/^vacuous:/);
  }, 60_000);

  it("#237 still applies when the checks do not hold: an early `blocked` is refused", async () => {
    const r = await run("/launch", [bodyText("Payments ready")], { successWhen: "held", allowVacuousChecks: true });
    expect(refusedEarly(r)).toBe(true);
    expect(r.outcome).not.toBe("succeeded");
  }, 60_000);
});
