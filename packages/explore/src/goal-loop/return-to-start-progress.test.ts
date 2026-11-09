/**
 * #807 gap 11 — the final no-progress stop in `checkProgress` happens before `decideStep`. With a
 * remembered page that still has untried controls, a stalled run past its last chance returns there
 * (a recorded navigation) instead of stopping; without one it still stops `no-progress`.
 */
import { describe, expect, it, vi } from "vitest";
import { DepthLog } from "../run-depth.js";
import type { Control, Snapshot } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { checkProgress } from "./progress.js";
import { notePage } from "./return-to-start.js";

vi.mock("../status.js", () => ({
  readPageStatus: async () => ({ alerts: [], notices: [], invalid: [] }),
  readFormText: async () => null,
  isEmptyStatus: () => true,
  statusDelta: () => ({ alerts: [], notices: [], invalid: [] }),
  describeStatus: () => "",
  busyOverlay: async () => null,
}));
vi.mock("../conversation.js", () => ({ readPageText: async () => "" }));
vi.mock("./handle-blocked.js", () => ({ collectActionableControlEvidence: async () => [], forwardControls: () => [], armRecoveryTurn: () => false, takeRecoveryTurn: () => null }));

const ctl = (name: string): Control => ({ index: 0, role: "button", name, enabled: true }) as unknown as Control;
const snapOf = (path: string, names: string[]): Snapshot =>
  ({ url: `http://app.test${path}`, signature: `sig:${path}`, controls: names.map(ctl), truncated: false }) as unknown as Snapshot;

function makeCtx() {
  const navigations: string[] = [];
  const ctx = {
    cfg: {},
    auth: { attempted: false },
    depth: new DepthLog(),
    history: [] as string[],
    statusAfter: null,
    status: { alerts: [], notices: [], invalid: [] },
    transcript: { nextStep: 3, record: () => undefined },
    pageText: null,
    replyTold: false,
    lastActedOp: "click",
    deltas: null,
    deltaVerdict: null,
    formBefore: null,
    formMessage: null,
    refusedTurn: false,
    movingScrolls: 0,
    movingScrollsSignature: null,
    scrollStreakSignatures: new Set<string>(),
    lastScrollMoved: false,
    lastChanceTurn: false,
    lastChanceGiven: true,
    noControls: false,
    writeGoal: false,
    cycleAction: null,
    cycleMark: 0,
    track: { lastMutation: null },
    seen: new Set<string>(),
    noProgress: { progress: () => undefined, noteDelta: () => true, stalled: () => true, streak: 3 },
    tracker: { countAction: () => undefined, mayAct: () => true },
    page: { goto: async (u: string) => void navigations.push(u) },
    recorder: { navigate: (u: string) => navigations.push(`recorded:${u}`) },
    livenessOf: () => ({ authorized: () => true }),
    now: () => 0,
  } as unknown as RunContext;
  return { ctx, navigations };
}

const step = (snap: Snapshot) => ({ perceiveStartedAt: 0, perception: { timing: {} } as never, snap });

describe("return-to-start at the no-progress stop (#807, gap 11)", () => {
  it("returns to a remembered page with untried controls instead of stopping", async () => {
    const { ctx, navigations } = makeCtx();
    notePage(ctx, snapOf("/home", ["Library", "Billing"]));
    ctx.depth.noteTried("http://app.test/home", "Billing");
    const flow = await checkProgress(ctx, step(snapOf("/dead", ["Back"])));
    expect(flow).toBe("continue");
    expect(ctx.stop).toBeUndefined();
    expect(navigations).toEqual(["http://app.test/home", "recorded:http://app.test/home"]);
    expect(ctx.history.at(-1)).toContain('"Library"');
  });

  it("with no remembered page it still stops no-progress", async () => {
    const { ctx, navigations } = makeCtx();
    const flow = await checkProgress(ctx, step(snapOf("/dead", ["Back"])));
    expect(flow).toBe("stop");
    expect(ctx.stop).toBe("no-progress");
    expect(navigations).toEqual([]);
  });
});
