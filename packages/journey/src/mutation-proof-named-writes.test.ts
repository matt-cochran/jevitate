import { describe, expect, it } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { journeyWriteSteps, planJourneyMutations, type Journey } from "./index.js";

/** A check names a request, not the step that sends it. Neither page timing nor a delta line can say which step really did: a timer's write lands under the next click. */
const check = (path: string) => ({ kind: "responseStatus" as const, method: "POST", pathGlob: path, status: { class: 2 as const } });
const timing = (paths: readonly string[]) => ({
  atMs: 0,
  durationMs: 0,
  gapBeforeMs: 0,
  page: { route: "/", kind: "transition" as const, settled: true, requests: { count: paths.length, pending: 0, slowest: paths.map((p) => ({ endpoint: `POST ${p}`, url: `http://127.0.0.1:1${p}`, status: 200, durationMs: 5 })) } },
});
const nav = (): RecordedStep => ({ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }) as RecordedStep;
const click = (name: string, paths: readonly string[]): RecordedStep => ({ step: { kind: "click", target: { role: "button", name }, expect: { kind: "textIncludes", target: { css: "#out" }, text: "ok" } }, timing: timing(paths) }) as RecordedStep;
const write = (name: string, path: string): RecordedStep => ({ ...click(name, []), delta: { verdict: "relevant-change", why: "w", changes: [], requests: [`POST ${path} → 200`], overheadMs: 1 } }) as RecordedStep;
const journey = (steps: readonly RecordedStep[], networkChecks: readonly ReturnType<typeof check>[]): Journey =>
  ({ metadata: { id: "j", name: "J", promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00Z", networkChecks }, recording: { version: "1", site: "http://127.0.0.1:1", pages: [{ url: "/", steps }] } }) as unknown as Journey;

const SAVE = "/board.v1.Items/SaveItem";
const INVITE = "/board.v1.Members/InviteMember";

describe("a request a networkCheck names", () => {
  it("makes no write step, though a step's page timing shows it", () => {
    const j = journey([nav(), click("Save", [SAVE])], [check(SAVE)]);
    expect(journeyWriteSteps(j)).toEqual([]);
    const plan = planJourneyMutations(j);
    // The click's own checked UI effect still gets its skip (#811); nothing blocks a write or pairs the check.
    expect(plan.mutations.some((m) => m.kind === "block-write")).toBe(false);
    expect(plan.pairs.filter((p) => p.site.startsWith("end-state"))).toEqual([]);
  });

  it("pairs with the one step whose own delta sent it, not the last write (#811)", () => {
    const j = journey([nav(), write("Save", SAVE), write("Invite", INVITE)], [check(SAVE)]);
    const pairs = planJourneyMutations(j).pairs.filter((p) => p.site.startsWith("end-state")).map((p) => p.mutation);
    expect(pairs.sort()).toEqual(["block-write:2", "skip:2"]);
  });
});
