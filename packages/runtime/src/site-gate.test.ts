import { describe, expect, it } from "vitest";
import type { ActivityRepository, BudgetLimits, BudgetRepository, SitePolicyRepository } from "@jevitate/application";
import type { SitePolicy } from "@jevitate/domain";
import type { Recording } from "@jevitate/recording";
import { enterSiteGate, throttleClassOf, type SiteGateDeps } from "./site-gate.js";

const NOW = "2026-09-25T15:00:00.000Z"; // 10:00 in America/Chicago
const SITE = "https://app.example.test";

function deps(policy: SitePolicy | null, o: { lastAt?: string | null; allowed?: boolean } = {}) {
  const reserved: Array<{ cls: string; limits: BudgetLimits }> = [];
  const stamped: string[] = [];
  const slept: number[] = [];
  const policies: SitePolicyRepository = { get: async () => policy, set: async () => undefined };
  const budgets: BudgetRepository = {
    reserve: async (_s, _a, cls, limits) => {
      reserved.push({ cls, limits });
      return { allowed: o.allowed ?? true };
    },
  };
  const activity: ActivityRepository = {
    lastAt: async () => o.lastAt ?? null,
    stamp: async (_s, _a, cls) => void stamped.push(cls),
  };
  const d: SiteGateDeps = { policies, budgets, activity, nowIso: () => NOW, sleep: async (ms) => void slept.push(ms) };
  return { d, reserved, stamped, slept };
}

const req = (o: Partial<Parameters<typeof enterSiteGate>[1]> = {}) => ({
  site: SITE,
  account: "primary",
  throttleClass: "write" as const,
  runId: "run-1",
  enforceLimits: true,
  ...o,
});

describe("site-policy gate for Journey runs", () => {
  it("no policy for the site: the run proceeds unpaced and nothing is recorded", async () => {
    const { d, reserved, stamped } = deps(null);
    const g = await enterSiteGate(d, req());
    expect(g).toMatchObject({ ok: true, pace: null });
    if (g.ok) await g.done();
    expect(reserved).toEqual([]);
    expect(stamped).toEqual([]);
  });

  it("inside quiet hours: refused before anything runs, retry when the window closes", async () => {
    const { d, reserved } = deps({ version: "v1", quietHours: { timezone: "America/Chicago", windows: [{ start: "09:00", end: "11:30" }] } });
    const g = await enterSiteGate(d, req());
    expect(g).toEqual({ ok: false, reason: "quiet_hours", retryAfter: "2026-09-25T11:30:00-05:00" });
    expect(reserved).toEqual([]);
  });

  it("min interval: a short shortfall is waited out; a long one is refused with when to retry", async () => {
    const policy: SitePolicy = { version: "v1", throttles: { write: { minIntervalSeconds: 60 } } };
    const short = deps(policy, { lastAt: "2026-09-25T14:59:03.000Z" }); // 57s ago: 3s short
    expect(await enterSiteGate(short.d, req())).toMatchObject({ ok: true });
    expect(short.slept).toEqual([3_000]);
    const long = deps(policy, { lastAt: "2026-09-25T14:59:30.000Z" });
    expect(await enterSiteGate(long.d, req())).toEqual({ ok: false, reason: "min_interval", retryAfter: "2026-09-25T15:00:30.000Z" });
  });

  it("budget: reserved per throttle class; a spent budget is refused until the next UTC midnight", async () => {
    const policy: SitePolicy = { version: "v1", throttles: { write: { hourlyLimit: 5, dailyLimit: 20 } } };
    const ok = deps(policy);
    expect(await enterSiteGate(ok.d, req())).toMatchObject({ ok: true });
    expect(ok.reserved).toEqual([{ cls: "write", limits: { hourlyLimit: 5, dailyLimit: 20 } }]);
    const spent = deps(policy, { allowed: false });
    expect(await enterSiteGate(spent.d, req())).toEqual({ ok: false, reason: "budget", retryAfter: "2026-09-26T00:00:00.000Z" });
  });

  it("an admitted run gets the policy's pacing and records its run once done", async () => {
    const policy: SitePolicy = { version: "v1", interaction: { thinkBeforeActionMs: { mean: 400, sd: 50 } } };
    const { d, stamped } = deps(policy);
    const g = await enterSiteGate(d, req({ throttleClass: "read" }));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.pace?.policy).toEqual(policy.interaction);
    await g.done();
    expect(stamped).toEqual(["read"]);
  });

  it("a load run (enforceLimits false) is paced but never refused or recorded", async () => {
    const policy: SitePolicy = {
      version: "v1",
      interaction: { thinkBeforeActionMs: { mean: 400, sd: 50 } },
      throttles: { write: { dailyLimit: 1 } },
      quietHours: { timezone: "America/Chicago", windows: [{ start: "00:00", end: "23:59" }] },
    };
    const { d, reserved, stamped } = deps(policy, { allowed: false });
    const g = await enterSiteGate(d, req({ enforceLimits: false }));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.pace).not.toBeNull();
    await g.done();
    expect(reserved).toEqual([]);
    expect(stamped).toEqual([]);
  });

  it("throttleClassOf: a Journey with any write step is `write`, a read-only one `read`", () => {
    const rec = (kinds: string[]): Recording =>
      ({
        version: "1",
        site: SITE,
        pages: [{ url: `${SITE}/`, steps: kinds.map((kind) => ({ step: kind === "assert" ? { kind, check: { kind: "urlIncludes", text: "/" } } : { kind, target: { role: "button", name: "Go" } } })) }],
      }) as unknown as Recording;
    expect(throttleClassOf(rec(["assert"]))).toBe("read");
    expect(throttleClassOf(rec(["assert", "click"]))).toBe("write");
  });
});
