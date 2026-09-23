import { describe, expect, it } from "vitest";
import type { ResourceSample } from "@jevitate/playwright";
import { hostProbe } from "./host-pressure.js";
import { buildCrashReport } from "./crash-report.js";
import { draftForCrash, draftForHang, type DraftContext } from "./issue-draft.js";
import type { HangFinding } from "./hang-repro.js";

/** Host resource pressure in hang/crash evidence, with an INJECTED load sampler (round 2d). */

const GB = 1024 ** 3;
const signals = (sample: ResourceSample) => ({ sample: async () => sample });
const PRESSURED: ResourceSample = {
  memPressure: 7.25,
  memMetric: "psi-memory-full-avg10",
  cpuPressure: 30,
  cpuMetric: "psi-cpu-some-avg10",
  memAvailableBytes: 8 * GB,
  source: "test:psi",
};
const CALM: ResourceSample = { ...PRESSURED, memPressure: 0.1, cpuPressure: 5 };

const ctx: DraftContext = { environment: { os: "linux x64", node: "v22", target: "http://app.test" }, secrets: [] };

describe("hostProbe — the admission sample, judged by the admission thresholds", () => {
  it("reports the exceeded threshold, or null within thresholds, or the sampling error", async () => {
    expect((await hostProbe(signals(PRESSURED))()).overThreshold).toMatch(/^memory pressure full avg10=7\.25% > 5%/);
    expect(await hostProbe(signals(CALM))()).toEqual({ sample: CALM, overThreshold: null });
    const broken = await hostProbe({ sample: async () => Promise.reject(new Error("no /proc")) })();
    expect(broken).toEqual({ sample: null, overThreshold: null, error: "no /proc" });
  });
});

describe("attribution under host pressure — uncertain, and the draft says so", () => {
  const hangOf = (host: Awaited<ReturnType<ReturnType<typeof hostProbe>>>): HangFinding => ({
    fingerprint: "0123456789abcdef",
    kind: "hang",
    hangKind: "main-thread-unresponsive",
    title: "Hang",
    route: "/x",
    url: "http://app.test/x",
    signal: {
      kind: "main-thread-unresponsive",
      detail: "probe missed",
      route: "/x",
      url: "http://app.test/x",
      pending: [],
      lastState: { signature: "s", controls: [] },
      host,
    },
    firstSeenStep: 1,
    occurrences: 1,
    occurrenceSteps: [1],
    repro: { steps: [], recordingStepIndex: 0 },
    reproduction: { attempts: 0, ran: 0, reproduced: 0, status: "inconclusive", runs: [] },
  });

  it("a main-thread-unresponsive hang on a pressured host is uncertain → filed to both, with the pressure stated", async () => {
    const d = draftForHang(hangOf(await hostProbe(signals(PRESSURED))()), ctx);
    expect(d.attribution).toBe("uncertain");
    expect(d.targets).toEqual(["jevitate", "system-under-test"]);
    expect(d.body).toContain("**host under resource pressure** — memory pressure full avg10=7.25% > 5%");
    expect(d.body).toContain("Attribution: uncertain — host under resource pressure");
  });

  it("the same hang on a calm host stays the system under test's", async () => {
    const d = draftForHang(hangOf(await hostProbe(signals(CALM))()), ctx);
    expect(d.attribution).toBe("system-under-test");
    expect(d.body).toContain("Host pressure: within thresholds (test:psi)");
  });

  it("a navigation timeout on a pressured host is an uncertain crash", async () => {
    const report = buildCrashReport(
      { kind: "exception", message: "page.goto: Timeout 30000ms exceeded.", stack: "page.goto: Timeout 30000ms exceeded.\n  - navigating to \"http://app.test/\"" },
      { pageCrashed: false, pageClosed: false, browserDisconnected: false },
      [],
      { host: await hostProbe(signals(PRESSURED))() },
    );
    expect(report.attribution.attribution).toBe("uncertain");
    expect(report.evidence.hostUnderPressure).toMatch(/memory pressure full/);
    expect(draftForCrash(report, [], ctx).body).toContain("host under resource pressure");
  });
});
