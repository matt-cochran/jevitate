import { expect, test } from "vitest";
import { z } from "zod";
import { defineAction, ActionRegistry } from "@jevitate/site-sdk";
import { BrowseTheWebToken, PaceInteractionsToken, tryAbility } from "@jevitate/screenplay";
import type { SitePolicy } from "@jevitate/domain";
import type { ActivityRepository, BudgetLimits, BudgetRepository, SitePolicyRepository } from "@jevitate/application";
import { openDatabase, migrateToLatest, SqliteActivityRepository, SqliteBudgetRepository, SqliteSitePolicyRepository } from "@jevitate/storage-sqlite";
import { ActionRunner, PolicyEnforcementError } from "./runner.js";

const NOW = "2026-09-17T12:00:00.000Z";

let openCalls = 0;
function makeFakeBrowser() {
  openCalls = 0;
  return {
    open: async () => {
      openCalls++;
      return {
        page: { url: () => "about:blank" } as any,
        startTracing: async () => {},
        stopTracingToFile: async () => {},
        saveStorageState: async () => {},
        close: async () => {},
      };
    },
  };
}

const Echo = defineAction({
  id: "diag.echo", version: "1.0.0",
  input: z.object({ msg: z.string() }), output: z.object({ echoed: z.string(), hasBrowser: z.boolean(), hasPace: z.boolean() }),
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    return {
      echoed: input.msg,
      hasBrowser: !!actor.ability(BrowseTheWebToken),
      hasPace: tryAbility(actor, PaceInteractionsToken) !== undefined,
    };
  },
});

let executeCalls = 0;
const CountingEcho = defineAction({
  id: "diag.counting-echo", version: "1.0.0",
  input: z.object({ msg: z.string() }), output: z.object({ echoed: z.string() }),
  risk: "read", throttleClass: "read",
  async execute(_actor, input) {
    executeCalls++;
    return { echoed: input.msg };
  },
});

function makeRegistry() {
  const reg = new ActionRegistry();
  reg.register("example-network", Echo);
  reg.register("example-network", CountingEcho);
  return reg;
}

class FakePolicyRepo implements SitePolicyRepository {
  calls = 0;
  constructor(private readonly policy: SitePolicy | null) {}
  async get(): Promise<SitePolicy | null> {
    this.calls++;
    return this.policy;
  }
  async set(): Promise<void> {}
}

class FakeBudgetRepo implements BudgetRepository {
  calls: Array<{ site: string; account: string; cls: string; limits: BudgetLimits; nowIso: string }> = [];
  constructor(private readonly allowed: boolean) {}
  async reserve(site: string, account: string, cls: string, limits: BudgetLimits, nowIso: string) {
    this.calls.push({ site, account, cls, limits, nowIso });
    return { allowed: this.allowed };
  }
}

class ThrowingBudgetRepo implements BudgetRepository {
  async reserve(): Promise<{ allowed: boolean }> {
    throw new Error("budget.reserve should not have been called");
  }
}

class FakeActivityRepo implements ActivityRepository {
  stamped: Array<{ site: string; account: string; cls: string; nowIso: string }> = [];
  constructor(private readonly lastAtValue: string | null = null) {}
  async lastAt(): Promise<string | null> {
    return this.lastAtValue;
  }
  async stamp(site: string, account: string, cls: string, nowIso: string): Promise<void> {
    this.stamped.push({ site, account, cls, nowIso });
  }
}

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    site: "example-network", account: "primary", actionId: "diag.echo", version: "1.0.0",
    input: { msg: "hi" }, storageStatePath: "/nonexistent-jevitate-test/state.json", baseUrl: "about:blank", headless: true, allowedOrigins: [],
    runId: "run-1",
    ...overrides,
  };
}

test("runner resolves, validates, executes, and returns typed output", async () => {
  const reg = makeRegistry();
  const runner = new ActionRunner(makeFakeBrowser() as any, reg);
  const res = await runner.run(baseReq());
  expect(res.outcome).toBe("ok");
  if (res.outcome !== "ok") throw new Error("expected ok");
  expect(res.output).toEqual({ echoed: "hi", hasBrowser: true, hasPace: false });
});

test("runner rejects invalid input", async () => {
  const reg = makeRegistry();
  const runner = new ActionRunner(makeFakeBrowser() as any, reg);
  await expect(runner.run(baseReq({ input: { msg: 123 } }))).rejects.toThrow();
});

test("(a) no policies repo at all: fast path, ok, zero sleep calls, no repo overhead", async () => {
  const reg = makeRegistry();
  const sleepCalls: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };
  const runner = new ActionRunner(makeFakeBrowser() as any, reg); // no opts at all
  const res = await runner.run(baseReq({ sleep: fakeSleep }));
  expect(res.outcome).toBe("ok");
  if (res.outcome !== "ok") throw new Error("expected ok");
  expect(res.output).toEqual({ echoed: "hi", hasBrowser: true, hasPace: false });
  expect(sleepCalls).toEqual([]);
  expect(openCalls).toBe(1);
});

test("(a2) policies repo returns null: also fast path, ok, zero sleep calls", async () => {
  const reg = makeRegistry();
  const policies = new FakePolicyRepo(null);
  const sleepCalls: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };
  const runner = new ActionRunner(makeFakeBrowser() as any, reg, { policies });
  const res = await runner.run(baseReq({ sleep: fakeSleep }));
  expect(res.outcome).toBe("ok");
  expect(sleepCalls).toEqual([]);
  expect(policies.calls).toBe(1);
});

test("(b) quiet hours currently closed: throttled, action NOT executed", async () => {
  executeCalls = 0;
  const reg = makeRegistry();
  const policy: SitePolicy = {
    version: "v1",
    // Closed nearly the entire day in UTC, which covers NOW (12:00 UTC).
    quietHours: { timezone: "UTC", windows: [{ start: "00:00", end: "23:59" }] },
  };
  const policies = new FakePolicyRepo(policy);
  const budgets = new ThrowingBudgetRepo(); // must not be reached
  const fakeBrowser = makeFakeBrowser();
  const runner = new ActionRunner(fakeBrowser as any, reg, {
    policies,
    budgets,
    clock: { nowIso: () => NOW },
  });
  const res = await runner.run(baseReq({ actionId: "diag.counting-echo", sleep: async () => {} }));
  expect(res.outcome).toBe("throttled");
  if (res.outcome !== "throttled") throw new Error("expected throttled");
  expect(res.reason).toBe("quiet_hours");
  expect(executeCalls).toBe(0);
  expect(openCalls).toBe(0);
});

test("(c) budget exhausted: denied, action NOT executed", async () => {
  executeCalls = 0;
  const reg = makeRegistry();
  const policy: SitePolicy = { version: "v1" };
  const policies = new FakePolicyRepo(policy);
  const budgets = new FakeBudgetRepo(false);
  const fakeBrowser = makeFakeBrowser();
  const runner = new ActionRunner(fakeBrowser as any, reg, {
    policies,
    budgets,
    clock: { nowIso: () => NOW },
  });
  const res = await runner.run(baseReq({ actionId: "diag.counting-echo", sleep: async () => {} }));
  expect(res.outcome).toBe("denied");
  if (res.outcome !== "denied") throw new Error("expected denied");
  expect(res.reason).toBe("budget");
  expect(executeCalls).toBe(0);
  expect(openCalls).toBe(0);
  expect(budgets.calls.length).toBe(1);
  // retryAfter must be an actionable future bound, not "right now" (NOW itself) --
  // specifically the start of the next UTC calendar day (both hourly and daily
  // budget windows will have reset by then).
  expect(res.retryAfter).not.toBe(NOW);
  expect(new Date(res.retryAfter).getTime()).toBeGreaterThan(new Date(NOW).getTime());
  expect(res.retryAfter).toBe("2026-09-18T00:00:00.000Z");
});

test("(d) min-interval shortfall within maxInlineWaitMs: sleep called with the shortfall, then ok", async () => {
  const reg = makeRegistry();
  const policy: SitePolicy = { version: "v1", throttles: { read: { minIntervalSeconds: 60 } } };
  const policies = new FakePolicyRepo(policy);
  // 55s before NOW -> elapsed 55s, min interval 60s -> shortfall 5000ms.
  const activity = new FakeActivityRepo("2026-09-17T11:59:05.000Z");
  const budgets = new FakeBudgetRepo(true);
  const sleepCalls: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };
  const runner = new ActionRunner(makeFakeBrowser() as any, reg, {
    policies,
    activity,
    budgets,
    clock: { nowIso: () => NOW },
    maxInlineWaitMs: 60_000,
  });
  const res = await runner.run(baseReq({ sleep: fakeSleep }));
  expect(sleepCalls).toEqual([5000]);
  expect(res.outcome).toBe("ok");
});

test("(e) happy paced path: ok, activity stamped, budget reserved, PaceInteractions attached", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const clock = { nowIso: () => NOW, monotonicMs: () => Date.now() };
  const policies = new SqliteSitePolicyRepository(db, clock);
  const budgets = new SqliteBudgetRepository(db);
  const activity = new SqliteActivityRepository(db);

  const policy: SitePolicy = { version: "v1", throttles: { read: { hourlyLimit: 100, dailyLimit: 1000 } } };
  await policies.set("example-network", "primary", policy);

  const reg = makeRegistry();
  const runner = new ActionRunner(makeFakeBrowser() as any, reg, {
    policies,
    budgets,
    activity,
    clock,
  });

  expect(await activity.lastAt("example-network", "primary", "read")).toBeNull();

  const res = await runner.run(baseReq({ sleep: async () => {} }));

  expect(res.outcome).toBe("ok");
  if (res.outcome !== "ok") throw new Error("expected ok");
  expect(res.output).toEqual({ echoed: "hi", hasBrowser: true, hasPace: true });

  expect(await activity.lastAt("example-network", "primary", "read")).toBe(NOW);

  const budgetRow = await db.selectFrom("budget_counter").selectAll()
    .where("site", "=", "example-network").where("throttle_class", "=", "read").executeTakeFirst();
  expect(budgetRow?.used).toBe(1);

  await db.destroy();
});

test("(f) min-interval declared but no ActivityRepository wired: fails closed, action NOT executed", async () => {
  executeCalls = 0;
  const reg = makeRegistry();
  const policy: SitePolicy = { version: "v1", throttles: { read: { minIntervalSeconds: 90 } } };
  const policies = new FakePolicyRepo(policy);
  const fakeBrowser = makeFakeBrowser();
  // No `activity` repo provided, even though the policy declares a min-interval limit.
  const runner = new ActionRunner(fakeBrowser as any, reg, {
    policies,
    clock: { nowIso: () => NOW },
  });
  await expect(
    runner.run(baseReq({ actionId: "diag.counting-echo", sleep: async () => {} })),
  ).rejects.toThrow(PolicyEnforcementError);
  expect(executeCalls).toBe(0);
  expect(openCalls).toBe(0);
});

test("(g) daily limit declared but no BudgetRepository wired: fails closed, action NOT executed", async () => {
  executeCalls = 0;
  const reg = makeRegistry();
  const policy: SitePolicy = { version: "v1", throttles: { read: { dailyLimit: 5 } } };
  const policies = new FakePolicyRepo(policy);
  const fakeBrowser = makeFakeBrowser();
  // No `budgets` repo provided, even though the policy declares a daily limit.
  const runner = new ActionRunner(fakeBrowser as any, reg, {
    policies,
    clock: { nowIso: () => NOW },
  });
  await expect(
    runner.run(baseReq({ actionId: "diag.counting-echo", sleep: async () => {} })),
  ).rejects.toThrow(PolicyEnforcementError);
  expect(executeCalls).toBe(0);
  expect(openCalls).toBe(0);
});

test("(h) quiet-hours-only policy with no repos at all: does not fail-close (quiet hours needs no repo)", async () => {
  executeCalls = 0;
  const reg = makeRegistry();
  const policy: SitePolicy = {
    version: "v1",
    quietHours: { timezone: "UTC", windows: [{ start: "00:00", end: "23:59" }] },
  };
  const policies = new FakePolicyRepo(policy);
  const fakeBrowser = makeFakeBrowser();
  // No activity/budgets repos, and no throttle limits declared -- only quietHours.
  const runner = new ActionRunner(fakeBrowser as any, reg, {
    policies,
    clock: { nowIso: () => NOW },
  });
  // Must not throw PolicyEnforcementError -- quiet hours needs no repo to enforce.
  // It IS currently quiet hours, so the gate itself throttles the run (a different,
  // expected outcome -- not a fail-closed rejection).
  const res = await runner.run(baseReq({ actionId: "diag.counting-echo", sleep: async () => {} }));
  expect(res.outcome).toBe("throttled");
  expect(executeCalls).toBe(0);
});
