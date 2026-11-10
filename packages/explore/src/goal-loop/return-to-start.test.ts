/**
 * #807 — return-to-start. A scripted page sequence drives `decideStep` through its `RunContext`
 * seam (the model's decide() is mocked): after a dead end the next decision is a recorded navigation to
 * the remembered page, whose untried control is then offered; a page with nothing untried is never a
 * target, and one page is returned to at most twice.
 */
import { describe, expect, it, vi } from "vitest";
import { DepthLog } from "../run-depth.js";
import type { Control, Snapshot } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { decideStep } from "./decide-step.js";
import { MAX_RETURNS_PER_PAGE, returnTarget } from "./return-to-start.js";

const decideMock = vi.fn();
vi.mock("../decide.js", () => ({ decide: (...a: unknown[]) => decideMock(...a) }));
vi.mock("./handle-blocked.js", () => ({ takeRecoveryTurn: () => null }));

const ctl = (name: string, role = "button"): Control => ({ index: 0, role, name, enabled: true }) as unknown as Control;
const snapOf = (path: string, names: string[]): Snapshot =>
  ({ url: `http://app.test${path}`, signature: `sig:${path}`, controls: names.map((n) => ctl(n)), truncated: false }) as unknown as Snapshot;

function makeCtx() {
  const calls: string[] = [];
  const navigations: string[] = [];
  const ctx = {
    cfg: { goal: "finish", judge: {} },
    auth: { attempted: false },
    depth: new DepthLog(),
    history: [] as string[],
    goalFocus: { noteUrl: () => undefined, offGoal: () => new Map() },
    chrome: [],
    secrets: [],
    fixture: null,
    fixtureAttached: false,
    uploadFixtures: [],
    attachedUploadFixtures: new Set(),
    conversation: { latestReply: null, sent: [] },
    formMessage: null,
    status: { alerts: [], notices: [], invalid: [] },
    deltas: null,
    findOut: false,
    lastChanceTurn: false,
    lastChanceGiven: true,
    noControls: true,
    lastActedOp: "click",
    blockedReported: new Set(),
    tracker: { countDecision: () => undefined, countAction: () => calls.push("action"), mayAct: () => true },
    page: { goto: async (u: string) => void navigations.push(u) },
    recorder: { navigate: (u: string) => navigations.push(`recorded:${u}`) },
    noProgress: { progress: () => undefined },
    livenessOf: () => ({ pageUrl: "", authorized: () => true }),
    now: () => 0,
    transcript: { record: (e: { reason?: string }) => { throw new Error(e.reason); } },
  } as unknown as RunContext;
  return { ctx, navigations };
}

async function turn(ctx: RunContext, snap: Snapshot, op: string) {
  decideMock.mockResolvedValueOnce({ op, control: null, confidence: 1, targetMissing: false, state: {} });
  const view = { offered: [], unsubmitted: [], visibleText: "", modelControls: snap.controls } as never;
  return decideStep(ctx, { perceiveStartedAt: 0, perception: { timing: {} } as never, snap }, view);
}

describe("return-to-start (#807)", () => {
  it("after a dead end the decision is a recorded navigate to the remembered page, and its untried control is offered", async () => {
    const { ctx, navigations } = makeCtx();
    await turn(ctx, snapOf("/home", ["Billing", "Reports"]), "click");
    ctx.depth.noteTried("http://app.test/home", "Billing");
    const dead = await turn(ctx, snapOf("/billing", ["Back"]), "blocked");
    expect(dead).not.toBe("stop");
    expect((dead as { op: string }).op).toBe("wait");
    expect(navigations).toEqual(["http://app.test/home", "recorded:http://app.test/home"]);
    expect(ctx.history.at(-1)).toContain('"Reports"');
    expect(ctx.history.at(-1)).not.toContain('"Billing"');
  });

  it("a page with no untried controls is never a target, and one page is returned to at most twice", async () => {
    const { ctx, navigations } = makeCtx();
    await turn(ctx, snapOf("/done", ["Only"]), "click");
    ctx.depth.noteTried("http://app.test/done", "Only");
    await turn(ctx, snapOf("/done", ["Only"]), "click");
    expect(returnTarget(ctx, "http://app.test/x")).toBeNull();
    const none = await turn(ctx, snapOf("/x", ["Back"]), "blocked");
    expect((none as { op: string }).op).toBe("blocked");
    expect(navigations).toEqual([]);

    ctx.depth.noteTried("http://app.test/x", "Back");
    ctx.depth.noteTried("http://app.test/dead", "Back");
    await turn(ctx, snapOf("/home", ["A", "B", "C"]), "click");
    for (let i = 0; i < MAX_RETURNS_PER_PAGE; i++) {
      const back = await turn(ctx, snapOf("/dead", ["Back"]), "blocked");
      expect((back as { op: string }).op).toBe("wait");
      await turn(ctx, snapOf("/home", ["A", "B", "C"]), "click");
    }
    const third = await turn(ctx, snapOf("/dead", ["Back"]), "blocked");
    expect((third as { op: string }).op).toBe("blocked");
    expect(navigations.filter((n) => n.startsWith("recorded:"))).toHaveLength(MAX_RETURNS_PER_PAGE);
  });

  it("a sign-in page the run typed a credential into is never a target: a signed-in dead end stays put", async () => {
    const { ctx, navigations } = makeCtx();
    await turn(ctx, snapOf("/login", ["Sign In", "Remember this device"]), "click");
    (ctx.auth as { attempted: boolean }).attempted = true;
    const dead = await turn(ctx, snapOf("/", ["Start a new piece"]), "blocked");
    expect((dead as { op: string }).op).toBe("blocked");
    expect(navigations).toEqual([]);
  });
});
