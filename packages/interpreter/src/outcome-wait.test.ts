import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, clock, installClock, resetClock } from "@jevitate/domain";
import type { Assertion, OutcomeWait, Recording, RecordedStep } from "@jevitate/recording";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runStep } from "./run-step.js";
import { RecordingInterpreter } from "./interpreter.js";
import type { StepWait } from "./outcome-wait.js";

/**
 * #409 — a per-step outcome wait for a long-running job. A fake page whose "job" is a function of
 * (fake) time: `previews()` says how many previews are rendered, `status()` what the status line
 * shows (null: no status element). Reloads are counted; `liveUpdates: false` makes the previews
 * appear only after a reload (a page that does not live-update).
 */
interface FakeJob {
  previews(): number;
  status(): string | null;
  liveUpdates?: boolean;
}

function fakeActor(job: FakeJob) {
  let rendered = job.previews();
  const page = {
    reload: vi.fn(async () => {
      rendered = job.previews();
    }),
    url: () => "https://app.test/designs",
    getByTestId: (id: string) => {
      if (id !== "variation-preview") throw new Error(`unexpected testId ${id}`);
      const count = async () => (job.liveUpdates === false ? rendered : job.previews());
      return { count, isVisible: async () => (await count()) > 0, first() { return this; }, innerText: async () => "" };
    },
    locator: (css: string) => {
      if (css !== "[role=status]") throw new Error(`unexpected css ${css}`);
      const loc = {
        count: async () => (job.status() === null ? 0 : 1),
        isVisible: async () => job.status() !== null,
        first: () => loc,
        innerText: async () => {
          const s = job.status();
          if (s === null) throw new Error("no element");
          return s;
        },
      };
      return loc;
    },
  };
  const actor = CastActor.named("t").whoCan(new BrowseTheWeb({ page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as never, []));
  return { actor, page };
}

const previews: Assertion = { kind: "count", target: { testId: "variation-preview" }, min: 3 };
const status: Assertion = { kind: "visible", target: { css: "[role=status]" } };
const assertStep = (waitFor?: OutcomeWait): RecordedStep => ({ step: { kind: "assert", check: previews, ...(waitFor === undefined ? {} : { waitFor }) } });

let fake: FakeClock;
beforeEach(() => {
  fake = new FakeClock();
  installClock(fake);
});
afterEach(() => resetClock());

/** Runs `p` to completion on fake time (every sleep fires in due order). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const out = p.finally(() => (done = true));
  out.catch(() => undefined);
  for (let i = 0; i < 100_000 && !done; i++) await fake.next();
  return out;
}

const at = (ms: number) => () => clock.monotonicMs() >= ms;

describe("#409 waitFor — per-step outcome wait", () => {
  it("holds after several polls: passes and reports the actual wait", async () => {
    const doneAt = at(130_000);
    const { actor } = fakeActor({ previews: () => (doneAt() ? 3 : 0), status: () => (doneAt() ? null : "Generating variations…") });
    const waits: StepWait[] = [];
    const outcome = await settle(runStep(actor as never, assertStep({ maxMs: 240_000, until: "held", progress: status }), new Map(), 4, { onWait: (w) => waits.push(w) }));
    expect(outcome).toEqual({ kind: "done" });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ step: 5, ending: "held", maxMs: 240_000 });
    expect(waits[0]!.waitedMs).toBeGreaterThanOrEqual(130_000);
    expect(waits[0]!.waitedMs).toBeLessThan(131_000);
    expect(waits[0]!.polls).toBeGreaterThan(3);
  });

  it("never holds: fails at maxMs as a postcondition failure, naming the budget", async () => {
    const { actor } = fakeActor({ previews: () => 1, status: () => "Generating variations…" });
    const waits: StepWait[] = [];
    const run = settle(runStep(actor as never, assertStep({ maxMs: 90_000, progress: status }), new Map(), 0, { onWait: (w) => waits.push(w) }));
    await expect(run).rejects.toThrow(/assert: postcondition failed: kind=count .* — waited 90\.0s \(waitFor maxMs 90000\); it never held/);
    expect(waits[0]).toMatchObject({ ending: "timeout", waitedMs: 90_000 });
  });

  it("progress stops: fails early as a hang naming the progress signal, not at maxMs", async () => {
    // The status shows for 20 s, then the job dies silently: no status, no previews.
    const { actor } = fakeActor({ previews: () => 0, status: () => (clock.monotonicMs() < 20_000 ? "Generating variations…" : null) });
    const waits: StepWait[] = [];
    const run = settle(runStep(actor as never, assertStep({ maxMs: 240_000, progress: status }), new Map(), 0, { onWait: (w) => waits.push(w) }));
    await expect(run).rejects.toThrow(/postcondition failed: .* — hang: the progress signal \(kind=visible target=\{"css":"\[role=status\]"\}\) was absent and unchanged for 30\.0s/);
    expect(waits[0]!.ending).toBe("hang");
    expect(waits[0]!.waitedMs).toBeGreaterThanOrEqual(49_500); // 30 s after the last poll that saw the status (19.75 s)
    expect(waits[0]!.waitedMs).toBeLessThan(51_000);
  });

  it("a job that never shows progress fails at the hang threshold (stallMs)", async () => {
    const { actor } = fakeActor({ previews: () => 0, status: () => null });
    const waits: StepWait[] = [];
    const run = settle(runStep(actor as never, assertStep({ maxMs: 240_000, progress: status, stallMs: 10_000 }), new Map(), 0, { onWait: (w) => waits.push(w) }));
    await expect(run).rejects.toThrow(/hang: the progress signal/);
    expect(waits[0]).toMatchObject({ ending: "hang", waitedMs: 10_000 });
  });

  it("a progress signal whose text keeps changing is alive even when its assertion does not hold", async () => {
    // The progress assertion wants "Generating" but the status reads "Step n of 9" — changing every 5 s.
    const doneAt = at(60_000);
    const { actor } = fakeActor({ previews: () => (doneAt() ? 3 : 0), status: () => `Step ${Math.floor(clock.monotonicMs() / 5_000)} of 9` });
    const progress: Assertion = { kind: "textIncludes", target: { css: "[role=status]" }, text: "Generating" };
    const waits: StepWait[] = [];
    await settle(runStep(actor as never, assertStep({ maxMs: 240_000, progress, stallMs: 10_000 }), new Map(), 0, { onWait: (w) => waits.push(w) }));
    expect(waits[0]!.ending).toBe("held");
  });

  it("reloads between polls when requested (a page that does not live-update)", async () => {
    const doneAt = at(30_000);
    const { actor, page } = fakeActor({ previews: () => (doneAt() ? 3 : 0), status: () => "Preparing", liveUpdates: false });
    const waits: StepWait[] = [];
    await settle(runStep(actor as never, assertStep({ maxMs: 120_000, reload: true, pollMs: 5_000 }), new Map(), 0, { onWait: (w) => waits.push(w) }));
    expect(waits[0]).toMatchObject({ ending: "held" });
    expect(page.reload).toHaveBeenCalled();
    expect(waits[0]!.reloads).toBe(page.reload.mock.calls.length);
    // Polls every 5 s from 0: the reload at 30 s is the first to see the finished job.
    expect(page.reload.mock.calls.length).toBe(6);
  });

  it("without reload, a page that does not live-update never shows the result (the reload is what observes it)", async () => {
    const { actor, page } = fakeActor({ previews: () => (clock.monotonicMs() >= 30_000 ? 3 : 0), status: () => "Preparing", liveUpdates: false });
    await expect(settle(runStep(actor as never, assertStep({ maxMs: 60_000 }), new Map()))).rejects.toThrow(/never held/);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("without waitFor nothing changes: the same 5 s bounded check, no wait reported", async () => {
    const { actor } = fakeActor({ previews: () => 0, status: () => null });
    const waits: StepWait[] = [];
    const started = clock.monotonicMs();
    await expect(settle(runStep(actor as never, assertStep(), new Map(), 0, { onWait: (w) => waits.push(w) }))).rejects.toThrow(
      /^assert: postcondition failed: kind=count target=\{"testId":"variation-preview"\} min=3 max=undefined$/,
    );
    expect(clock.monotonicMs() - started).toBeLessThan(5_200);
    expect(waits).toEqual([]);
  });

  it("RecordingInterpreter reports every waited step on its result; a run without waitFor has no `waits`", async () => {
    const doneAt = at(45_000);
    const { actor } = fakeActor({ previews: () => (doneAt() ? 3 : 0), status: () => "Generating" });
    const rec = (steps: RecordedStep[]): Recording => ({ version: "1", site: "https://app.test", pages: [{ url: "/designs", steps }] });
    const waited = await settle(new RecordingInterpreter().run(actor as never, rec([assertStep({ maxMs: 120_000, progress: status }), assertStep()])));
    expect(waited.outcome).toBe("completed");
    expect(waited.waits).toEqual([expect.objectContaining({ step: 1, ending: "held" })]);
    expect(waited.waits![0]!.waitedMs).toBeGreaterThanOrEqual(45_000);

    const plain = await settle(new RecordingInterpreter().run(actor as never, rec([assertStep()])));
    expect(plain).toEqual({ outcome: "completed", vars: {} });
  });

  it("refuses a waitFor on a forEach child before any step runs", async () => {
    const { actor } = fakeActor({ previews: () => 3, status: () => null });
    const rec: Recording = {
      version: "1",
      site: "https://app.test",
      pages: [{ url: "/", steps: [{ step: { kind: "forEach", items: { testId: "row" }, as: "r", steps: [{ kind: "click", target: { text: "Open" }, expect: previews, waitFor: { maxMs: 1_000 } }] } }] }],
    };
    await expect(new RecordingInterpreter().run(actor as never, rec)).rejects.toThrow(/child step with waitFor/);
  });
});
