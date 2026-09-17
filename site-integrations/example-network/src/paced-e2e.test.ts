import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { ActionRunner } from "@doit/runtime";
import { ActionRegistry } from "@doit/site-sdk";
import {
  openDatabase,
  migrateToLatest,
  SqliteSitePolicyRepository,
  SqliteBudgetRepository,
  SqliteActivityRepository,
} from "@doit/storage-sqlite";
import { startServer } from "@doit/example-site";
import { makeRng, seedFrom, Pacer, type SitePolicy, type TypingModel } from "@doit/domain";
import { EXAMPLE_NETWORK_ACTIONS } from "./actions.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() };

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "doit-paced-e2e-"));
});
afterAll(async () => {
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

function registry() {
  const reg = new ActionRegistry();
  for (const a of EXAMPLE_NETWORK_ACTIONS) reg.register("example-network", a);
  return reg;
}
const base = (account: string) => ({
  site: "example-network",
  account,
  profileDir,
  baseUrl: site.url,
  headless: true,
  allowedOrigins: [site.url],
});

// Modest typing cadence (3 chars/sec) plus a small fixed think-time before the
// action's interactions begin. Chosen so a 4-char username ("jane") plus a couple
// of `attemptsTo` steps produces a clearly-measurable (several-hundred-ms) but not
// painfully slow delta over the unpaced baseline. `sd: 0` on thinkBeforeActionMs
// keeps that component exact; typing still carries jitter (perKeyJitter) but at
// 3 cps even the low end of typing a few chars adds real wall-clock time.
// Deliberately no `throttles`/`quietHours`: evaluateGate always proceeds, and
// budgets.reserve (wired below) has no configured limits to deny against.
const policy: SitePolicy = {
  version: "1",
  interaction: {
    typing: { charsPerSecond: 3, perKeyJitter: 0.2 },
    thinkBeforeActionMs: { mean: 200, sd: 0, min: 200, max: 200 },
  },
};

test(
  "paced auth.login (policy set) is measurably slower than unpaced auth.login (no policy)",
  async () => {
    const db = openDatabase(":memory:");
    await migrateToLatest(db);
    const policies = new SqliteSitePolicyRepository(db, clock);
    const budgets = new SqliteBudgetRepository(db);
    const activity = new SqliteActivityRepository(db);

    await policies.set("example-network", "primary", policy);
    // "primary-unpaced" is never `.set()`, so `policies.get` returns null for it —
    // the runner's fast path with zero added latency.

    try {
      const runner = new ActionRunner(new PlaywrightBrowserPort(), registry(), {
        policies,
        budgets,
        activity,
        maxInlineWaitMs: 5000,
      });

      const pacedStart = Date.now();
      const paced = await runner.run({
        ...base("primary"),
        actionId: "auth.login",
        version: "1.0.0",
        input: { username: "jane" },
        runId: "paced-run-1",
      });
      const pacedElapsed = Date.now() - pacedStart;
      expect(paced.outcome).toBe("ok");

      const unpacedStart = Date.now();
      const unpaced = await runner.run({
        ...base("primary-unpaced"),
        actionId: "auth.login",
        version: "1.0.0",
        input: { username: "jane" },
        runId: "unpaced-run-1",
      });
      const unpacedElapsed = Date.now() - unpacedStart;
      expect(unpaced.outcome).toBe("ok");

      // Threshold (300ms) is set comfortably below the policy's expected minimum
      // added delay (think 200ms + typing ~4 chars * ~333ms base cadence, even with
      // jitter pulling individual chars down to 0.4x), while being large enough that
      // ordinary browser-timing jitter across two real page loads/logins can't
      // plausibly account for it on its own.
      expect(pacedElapsed).toBeGreaterThan(unpacedElapsed + 300);
    } finally {
      await db.destroy();
    }
  },
  60_000,
);

describe("deterministic realism assertion (pure, no browser)", () => {
  // No spaces/sentence-enders/hesitation: isolates the pure per-character base
  // cadence from any boundary-pause extras, so the mean can be compared directly
  // against 1000/charsPerSecond.
  const baseCadenceText = "abcdefghijklmnopqrstuvwxyz".repeat(20); // 520 chars
  const baseCadenceModel: TypingModel = { charsPerSecond: 10, perKeyJitter: 0.2 };

  test("mean typing delay over a large sample approximates 1000/charsPerSecond within tolerance", () => {
    const pacer = new Pacer(makeRng(seedFrom("realism-check", "1")));
    const delays = pacer.typingDelays(baseCadenceText, baseCadenceModel);

    const mean = delays.reduce((sum, d) => sum + d, 0) / delays.length;
    const expected = 1000 / baseCadenceModel.charsPerSecond;

    // perKeyJitter: 0.2 (sd = 20% of base) over a 520-char sample: the sample mean's
    // standard error is tiny relative to a single draw's sd, so a ±20% tolerance on
    // the mean is generous (defensible) while still proving the cadence is neither
    // wildly off nor clamped away from its target by the min/max bounds.
    expect(mean).toBeGreaterThan(expected * 0.8);
    expect(mean).toBeLessThan(expected * 1.2);
  });

  test("typingDelays is fully deterministic for a fixed seed", () => {
    const model: TypingModel = { charsPerSecond: 7, perKeyJitter: 0.3 };
    const text = "Determinism matters here.";
    const d1 = new Pacer(makeRng(seedFrom("realism-check", "1"))).typingDelays(text, model);
    const d2 = new Pacer(makeRng(seedFrom("realism-check", "1"))).typingDelays(text, model);
    expect(d1).toEqual(d2);
  });

  test("word-pause and sentence-pause positions carry measurably extra delay over base cadence, on average", () => {
    const model: TypingModel = {
      charsPerSecond: 10,
      perKeyJitter: 0.2,
      wordPauseMs: { mean: 150, sd: 0, min: 150, max: 150 },
      sentencePauseMs: { mean: 500, sd: 0, min: 500, max: 500 },
    };
    // Repeat a "word word." unit many times so space/period/letter delays each form
    // a large sample: per-draw jitter averages out (CLT), so comparing GROUP MEANS
    // is robust to any single draw's clamp/jitter outcome, unlike comparing one
    // pause-bearing delay against one base-cadence bound would be.
    const unit = "ab cd. ";
    const text = unit.repeat(40);
    const pacer = new Pacer(makeRng(seedFrom("realism-check", "2")));
    const delays = pacer.typingDelays(text, model);

    const letterDelays: number[] = [];
    const spaceDelays: number[] = [];
    const periodDelays: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === " ") spaceDelays.push(delays[i]);
      else if (c === ".") periodDelays.push(delays[i]);
      else letterDelays.push(delays[i]);
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const letterMean = mean(letterDelays);
    const spaceMean = mean(spaceDelays);
    const periodMean = mean(periodDelays);

    // wordPauseMs is fixed at 150 (sd:0) and sentencePauseMs at 500 (sd:0), so the
    // group-mean deltas should land close to those constants; thresholds are set
    // comfortably below (100 and 400) to tolerate the base-cadence component's own
    // jitter-driven mean estimation error over a 40-occurrence sample.
    expect(spaceMean).toBeGreaterThan(letterMean + 100);
    expect(periodMean).toBeGreaterThan(letterMean + 400);
  });
});
