import { afterEach, beforeEach, expect, test } from "vitest";
import { clock, FakeClock, installClock, resetClock } from "./clock.js";
import { activePhaseRecorder, PhaseRecorder, timePhase, withPhaseRecorder } from "./phase-timings.js";

let fake: FakeClock;
beforeEach(() => {
  fake = new FakeClock();
  installClock(fake);
});
afterEach(() => resetClock());

const work = async (ms: number): Promise<void> => {
  const done = clock.sleep(ms);
  await fake.advanceBy(ms);
  await done;
};

test("#852: phases charge self time, nested phases are not double-counted, the rest is unattributed", async () => {
  const rec = new PhaseRecorder();
  await withPhaseRecorder(rec, async () => {
    await work(10); // unattributed
    await timePhase("stepAction", async () => {
      await work(30);
      await timePhase("stepCheck", () => work(50));
    });
    await timePhase("doneCheck", () => work(20));
  });
  rec.end();
  expect(rec.snapshot()).toEqual({ totalMs: 110, phases: { stepAction: 30, stepCheck: 50, doneCheck: 20 }, unattributedMs: 10 });
});

test("#852: a phase that throws is still charged, and the error passes through", async () => {
  const rec = new PhaseRecorder();
  await expect(
    withPhaseRecorder(rec, () =>
      timePhase("fixtures", async () => {
        await work(15);
        throw new Error("setup failed");
      }),
    ),
  ).rejects.toThrow("setup failed");
  rec.end();
  expect(rec.snapshot().phases).toEqual({ fixtures: 15 });
});

test("#852: with no recorder open, timePhase is a pass-through", async () => {
  expect(activePhaseRecorder()).toBeUndefined();
  await expect(timePhase("stepAction", async () => 7)).resolves.toBe(7);
});

test("#852: concurrent phases on one recorder each charge their own time", async () => {
  const rec = new PhaseRecorder();
  await withPhaseRecorder(rec, async () => {
    const a = timePhase("doneCheck", () => clock.sleep(40));
    const b = timePhase("browserOpen", () => clock.sleep(40));
    await fake.advanceBy(40);
    await Promise.all([a, b]);
  });
  rec.end();
  const s = rec.snapshot();
  expect(s.phases).toEqual({ doneCheck: 40, browserOpen: 40 });
  expect(s.totalMs).toBe(40);
  expect(s.unattributedMs).toBe(0);
});
