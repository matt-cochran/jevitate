import { describe, expect, it } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { journeyWriteSteps, namedWritesNotMapped, planJourneyMutations, type Journey } from "./index.js";

/**
 * A Journey with no recorded delta, whose `networkChecks` name a request with a required status. Page
 * timing shows which step sent it. Read RPCs are POSTs too, so neither the method nor the name alone
 * makes a write: the classifier decides, and the timing has to point at exactly one action.
 */
const check = (path: string) => ({ kind: "responseStatus" as const, method: "POST", pathGlob: path, status: { class: 2 as const } });
const timing = (paths: readonly string[], count = paths.length) => ({
  atMs: 0,
  durationMs: 0,
  gapBeforeMs: 0,
  page: { route: "/", kind: "transition" as const, settled: true, requests: { count, pending: 0, slowest: paths.map((p) => ({ endpoint: `POST ${p}`, url: `http://127.0.0.1:1${p}?x=1`, status: 200, durationMs: 5 })) } },
});
const nav = (paths: readonly string[] = [], count?: number): RecordedStep => ({ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } }, timing: timing(paths, count) }) as RecordedStep;
const click = (name: string, paths: readonly string[], count?: number, claim?: string): RecordedStep =>
  ({ step: { kind: "click", target: { role: "button", name }, expect: claim === undefined ? { kind: "visible", target: { role: "button", name } } : { kind: "textIncludes", target: { css: "#out" }, text: claim } }, timing: timing(paths, count) }) as RecordedStep;
const journey = (steps: readonly RecordedStep[], networkChecks: readonly ReturnType<typeof check>[]): Journey =>
  ({ metadata: { id: "j", name: "J", promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00Z", networkChecks }, recording: { version: "1", site: "http://127.0.0.1:1", pages: [{ url: "/", steps }] } }) as unknown as Journey;

const SAVE = "/board.v1.Items/SaveItem";
const LOAD = "/board.v1.Items/GetItem";
const INVITE = "/board.v1.Members/InviteMember";

describe("a request a networkCheck names, on a Journey with no delta", () => {
  it("is a write of the one action step whose timing shows it", () => {
    const j = journey([nav([LOAD]), click("Save", [SAVE, LOAD])], [check(SAVE)]);
    expect(journeyWriteSteps(j)).toEqual([{ step: 2, requests: [`POST ${SAVE}`] }]);
    expect(planJourneyMutations(j).pairs).toContainEqual({ site: "end-state:0", mutation: "block-write:2" });
    expect(namedWritesNotMapped(j)).toEqual([]);
  });

  it("is paired with its own step, not the last write: another step's mutation can't break it", () => {
    const j = journey([nav(), click("Save", [SAVE]), click("Invite", [INVITE])], [check(SAVE), check(INVITE)]);
    const pairs = planJourneyMutations(j).pairs.filter((p) => p.site.startsWith("end-state"));
    expect(pairs).toEqual([
      { site: "end-state:0", mutation: "skip:2" },
      { site: "end-state:0", mutation: "block-write:2" },
      { site: "end-state:1", mutation: "skip:3" },
      { site: "end-state:1", mutation: "block-write:3" },
    ]);
  });

  it("is no write when the classifier calls it a read, though it is a POST", () => {
    const j = journey([nav(), click("Open", [LOAD])], [check(LOAD)]);
    expect(journeyWriteSteps(j)).toEqual([]);
    expect(namedWritesNotMapped(j)).toEqual([]);
    const configured = journey([nav(), click("Save", [SAVE])], [check(SAVE)]);
    expect(journeyWriteSteps(configured, { readRequests: ["SaveItem"] })).toEqual([]);
    expect(namedWritesNotMapped(configured, { readRequests: ["SaveItem"] })).toEqual([]);
  });

  it("is not guessed when two steps show it", () => {
    const j = journey([nav(), click("A", [SAVE]), click("B", [SAVE])], [check(SAVE)]);
    expect(journeyWriteSteps(j)).toEqual([]);
    expect(namedWritesNotMapped(j)).toEqual([{ site: "end-state:0", line: `POST ${SAVE}`, why: "steps 2, 3 all show it in their recorded timing" }]);
  });

  it("is not guessed when no step shows it", () => {
    const j = journey([nav(), { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "urlIncludes", text: "/" } } } as RecordedStep], [check(SAVE)]);
    expect(journeyWriteSteps(j)).toEqual([]);
    expect(namedWritesNotMapped(j)).toEqual([{ site: "end-state:0", line: `POST ${SAVE}`, why: "no step's recorded timing shows it" }]);
  });

  it("is not guessed when only a step that is not an action shows it", () => {
    const j = journey([nav([SAVE])], [check(SAVE)]);
    expect(journeyWriteSteps(j)).toEqual([]);
    expect(namedWritesNotMapped(j)[0]!.why).toBe("only step 1, a navigate, shows it in its recorded timing");
  });

  it("is not guessed when another action's timing is cut short and could hide it", () => {
    const j = journey([nav(), click("A", [LOAD, LOAD, LOAD], 5), click("B", [SAVE])], [check(SAVE)]);
    expect(journeyWriteSteps(j)).toEqual([]);
    expect(namedWritesNotMapped(j)[0]!.why).toBe("step 3 shows it, but step 2's recorded timing lists only 3 of its 5 requests");
  });

  it("leaves a step with a recorded delta to that delta", () => {
    const withDelta = { ...click("Save", [SAVE]), delta: { verdict: "no-change", why: "n", changes: [], requests: [], overheadMs: 1 } } as RecordedStep;
    expect(journeyWriteSteps(journey([nav(), withDelta], [check(SAVE)]))).toEqual([]);
  });

  it("needs a required status: a requestMade check declares no write", () => {
    const j = { ...journey([nav(), click("Save", [SAVE])], []), metadata: { ...journey([], []).metadata, networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: SAVE }] } } as unknown as Journey;
    expect(journeyWriteSteps(j)).toEqual([]);
  });
});

describe("a delta line that names an end-state request", () => {
  it("pairs that check with its own step, while the last write keeps the page's end state", () => {
    const write = (name: string, path: string): RecordedStep => ({ ...click(name, [], 0, "ok"), delta: { verdict: "relevant-change", why: "w", changes: [], requests: [`POST ${path} → 200`], overheadMs: 1 } }) as RecordedStep;
    const j = { ...journey([nav(), write("Save", SAVE), write("Invite", INVITE)], [check(SAVE)]) };
    j.metadata = { ...j.metadata, endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "#out" }, text: "ok" } }] } as Journey["metadata"];
    const pairs = planJourneyMutations(j).pairs.filter((p) => p.site.startsWith("end-state")).map((p) => `${p.site} ${p.mutation}`);
    expect(pairs.sort()).toEqual(["end-state:0 block-write:3", "end-state:0 skip:3", "end-state:1 block-write:2", "end-state:1 skip:2"]);
  });
});
