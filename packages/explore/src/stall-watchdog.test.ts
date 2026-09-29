import { afterEach, describe, expect, test, vi } from "vitest";
import { StallWatchdog, StalledError } from "./stall-watchdog.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("StallWatchdog (#114)", () => {
  test("a guarded wait that never ends is cut off with the reason once no step completed within the bound", async () => {
    vi.useFakeTimers();
    const w = new StallWatchdog(1_000);
    w.during("returning to the seed after a departure");
    const never = w.guard(new Promise<void>(() => undefined));
    const caught = never.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const e = await caught;
    expect(e).toBeInstanceOf(StalledError);
    expect((e as StalledError).reason).toBe("no step completed within 1s (while returning to the seed after a departure)");
  });

  test("every kick restarts the countdown; stop disarms it", async () => {
    vi.useFakeTimers();
    const w = new StallWatchdog(1_000);
    let fired = false;
    void w.stalled.then(() => {
      fired = true;
    });
    await vi.advanceTimersByTimeAsync(900);
    w.kick();
    await vi.advanceTimersByTimeAsync(900);
    expect(fired).toBe(false);
    w.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toBe(false);
  });

  test("a guarded wait that settles in time passes its value through", async () => {
    const w = new StallWatchdog(1_000);
    await expect(w.guard(Promise.resolve(7))).resolves.toBe(7);
    w.stop();
  });

  test("a non-positive bound is a setup error", () => {
    expect(() => new StallWatchdog(0)).toThrow(/positive/);
  });
});
