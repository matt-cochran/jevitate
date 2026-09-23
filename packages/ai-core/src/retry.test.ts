import { describe, expect, it } from "vitest";
import {
  BACKOFF_SCHEDULE_MS,
  RetryExhaustedError,
  RetryingGenerationPort,
  RetryingJudgmentPort,
  isTransientError,
  retryTransient,
} from "./retry.js";
import { FakeGenerationGateway } from "./generation.js";
import type { JudgmentPort } from "./judgment.js";

/** An injected clock: records every sleep and never really waits. */
function fakeClock() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms), random: () => 0.5 };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("retryTransient — exponential backoff with jitter, injected clock (owner ruling 4)", () => {
  it("walks the full schedule 100,250,500,1s,2s,4s,8s (≈16s) and then fails as a typed result", async () => {
    const clock = fakeClock();
    let calls = 0;
    const r = await retryTransient(async () => {
      calls += 1;
      throw httpError(503);
    }, clock);
    expect(BACKOFF_SCHEDULE_MS).toEqual([100, 250, 500, 1000, 2000, 4000, 8000]);
    expect(clock.slept).toEqual([100, 250, 500, 1000, 2000, 4000, 8000]); // random 0.5 ⇒ no jitter offset
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(15_850);
    expect(calls).toBe(8);
    expect(r).toMatchObject({ ok: false, attempts: 8, exhausted: true });
  });

  it("jitter stays within ±20% of each step", async () => {
    for (const random of [() => 0, () => 0.999]) {
      const slept: number[] = [];
      await retryTransient(async () => Promise.reject(httpError(429)), { sleep: async (ms) => void slept.push(ms), random });
      slept.forEach((ms, i) => {
        const base = BACKOFF_SCHEDULE_MS[i] ?? 0;
        expect(ms).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(ms).toBeLessThanOrEqual(Math.round(base * 1.2));
      });
    }
  });

  it("recovers as soon as a transient failure clears", async () => {
    const clock = fakeClock();
    let calls = 0;
    const r = await retryTransient(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return "ok";
    }, clock);
    expect(r).toEqual({ ok: true, value: "ok", attempts: 3 });
    expect(clock.slept).toEqual([100, 250]);
  });

  it("validation and auth errors fail IMMEDIATELY — no retry, no sleep", async () => {
    for (const err of [httpError(401), httpError(403), httpError(400), Object.assign(new Error("bad"), { name: "ZodError" })]) {
      const clock = fakeClock();
      let calls = 0;
      const r = await retryTransient(async () => {
        calls += 1;
        throw err;
      }, clock);
      expect(calls).toBe(1);
      expect(clock.slept).toEqual([]);
      expect(r).toMatchObject({ ok: false, attempts: 1, exhausted: false });
    }
  });
});

describe("isTransientError — only what is worth retrying", () => {
  it.each<[string, unknown, boolean]>([
    ["429", httpError(429), true],
    ["502", httpError(502), true],
    ["statusCode 504", Object.assign(new Error("x"), { statusCode: 504 }), true],
    ["response.status 503", Object.assign(new Error("x"), { response: { status: 503 } }), true],
    ["ETIMEDOUT", Object.assign(new Error("x"), { code: "ETIMEDOUT" }), true],
    ["undici socket", Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }), true],
    ["rate limit message", new Error("Rate limit exceeded, retry later"), true],
    ["401", httpError(401), false],
    ["404", httpError(404), false],
    ["422", httpError(422), false],
    ["missing credential", Object.assign(new Error("key"), { name: "MissingCredentialError" }), false],
    ["unknown", new Error("something else"), false],
    ["non-error", "string", false],
  ])("%s → %s", (_n, e, want) => {
    expect(isTransientError(e)).toBe(want);
  });
});

describe("Retrying ports — decorators for the model gateways", () => {
  it("a judgment port that stays down becomes a typed RetryExhaustedError", async () => {
    const clock = fakeClock();
    const down: JudgmentPort = { systemOne: async () => Promise.reject(httpError(503)) };
    const port = new RetryingJudgmentPort(down, clock);
    const err = await port.systemOne({ state: { goal: "g", url: "u", controls: [], history: [] }, questions: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect((err as RetryExhaustedError).attempts).toBe(8);
    expect(clock.slept).toHaveLength(7);
  });

  it("a non-transient error passes through unchanged on the first attempt", async () => {
    const clock = fakeClock();
    const auth = httpError(401);
    const port = new RetryingGenerationPort({ generate: async () => Promise.reject(auth) }, clock);
    await expect(port.generate("triage.narrative", { failureSummary: "x", url: "u" })).rejects.toBe(auth);
    expect(clock.slept).toEqual([]);
  });

  it("a healthy port is untouched", async () => {
    const port = new RetryingGenerationPort(new FakeGenerationGateway(), fakeClock());
    expect((await port.generate("triage.narrative", { failureSummary: "x", url: "u" })).output.summary).toBe("fake triage");
  });
});
