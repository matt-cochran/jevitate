import { expect, test } from "vitest";
import { RecordingSchema } from "@doit/recording";
import { assembleRecording, pathOf } from "./assemble.js";
import type { CaptureEvent, DescriptorResolution, DomEventKind } from "./recorder.js";

/**
 * Assembly is pure — every DOM question was answered at capture time — so the
 * shapes a real browser produces rarely (redirect chains, an `about:blank`
 * first navigation, a recording attached to an already-loaded page) are tested
 * here on synthetic buffers rather than by trying to provoke them for real.
 * `recorder.test.ts` covers the same translation against real DOM events.
 */

let seq = 0;
let clock = 1_000;

const nav = (url: string, isMainFrame = true): CaptureEvent => ({
  type: "navigation",
  seq: seq++,
  receivedAt: (clock += 10),
  url,
  isMainFrame,
});

const ok = (descriptor: Record<string, string>): DescriptorResolution => ({
  ok: true,
  descriptor,
  stability: "high",
  alternates: [],
});

const act = (
  kind: DomEventKind,
  eid: string,
  opts: {
    tag?: string;
    typeAttr?: string;
    rawText?: string;
    resolution?: DescriptorResolution;
    frameUrl?: string;
  } = {},
): CaptureEvent => ({
  type: "action",
  seq: seq++,
  receivedAt: (clock += 10),
  frameUrl: opts.frameUrl ?? "http://site.test/a",
  payload: {
    eid,
    kind,
    tag: opts.tag ?? "input",
    ts: clock,
    ...(opts.typeAttr === undefined ? {} : { typeAttr: opts.typeAttr }),
    ...(opts.rawText === undefined ? {} : { rawText: opts.rawText }),
  },
  ...(opts.resolution === undefined ? {} : { resolution: opts.resolution }),
});

const reset = (): void => {
  seq = 0;
  clock = 1_000;
};

const kinds = (r: ReturnType<typeof assembleRecording>): string[][] =>
  r.pages.map((p) => p.steps.map((s) => s.step.kind));

test("collapses a redirect chain onto its final URL instead of emitting a PageSegment per hop", () => {
  reset();
  const recording = assembleRecording(
    [
      nav("about:blank"),
      nav("http://site.test/login"),
      nav("http://site.test/login?redirected=1"),
      act("click", "1", { tag: "button", rawText: "Go", resolution: ok({ role: "button", name: "Go" }) }),
    ],
    { site: "site" },
  );

  // about:blank contributes nothing (it has no usable pathname), and the two
  // real hops are one page, not two.
  expect(recording.pages.map((p) => p.url)).toEqual(["/login?redirected=1"]);
  // The leading navigate step was rewritten to the URL the chain settled on,
  // rather than aiming the replay at a URL that only ever redirects.
  expect(recording.pages[0]!.steps[0]!.step).toEqual({
    kind: "navigate",
    url: "/login?redirected=1",
    expect: { kind: "urlIncludes", text: "/login?redirected=1" },
  });
});

test("a redirect chain after an acting step folds the FINAL url into that step's postcondition", () => {
  reset();
  const recording = assembleRecording(
    [
      nav("http://site.test/login"),
      act("click", "1", { tag: "button", rawText: "Sign in", resolution: ok({ role: "button", name: "Sign in" }) }),
      nav("http://site.test/post-login"),
      nav("http://site.test/inbox"),
      act("click", "1", { tag: "a", rawText: "Thread", resolution: ok({ role: "link", name: "Thread" }) }),
    ],
    { site: "site" },
  );

  expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);
  const signIn = recording.pages[0]!.steps[1]!.step;
  if (signIn.kind !== "click") throw new Error("expected click");
  // Not /post-login: the interpreter would be asserting on a URL the browser
  // only passes through.
  expect(signIn.expect).toEqual({ kind: "urlIncludes", text: "/inbox" });
  expect(kinds(recording)).toEqual([["navigate", "click"], ["click"]]);
});

test("ignores sub-frame navigations when segmenting", () => {
  reset();
  const recording = assembleRecording(
    [
      nav("http://site.test/outer"),
      nav("http://site.test/iframe-inner", false),
      act("click", "1", { tag: "button", rawText: "Go", resolution: ok({ role: "button", name: "Go" }) }),
    ],
    { site: "site" },
  );
  expect(recording.pages.map((p) => p.url)).toEqual(["/outer"]);
});

test("an action with no preceding navigation names its segment from the frame URL and emits no navigate step", () => {
  reset();
  const recording = assembleRecording(
    [act("click", "1", { tag: "button", rawText: "Go", resolution: ok({ role: "button", name: "Go" }) })],
    { site: "site" },
  );
  expect(recording.pages.map((p) => p.url)).toEqual(["/a"]);
  expect(kinds(recording)).toEqual([["click"]]);
});

test("keydown and submit never become steps", () => {
  reset();
  const recording = assembleRecording(
    [
      nav("http://site.test/login"),
      act("keydown", "1", { resolution: ok({ label: "Name" }) }),
      act("input", "1", { rawText: "ada", resolution: ok({ label: "Name" }) }),
      act("keydown", "1", { resolution: ok({ label: "Name" }) }),
      act("submit", "2", { tag: "form", rawText: "Name Go", resolution: ok({ css: "form" }) }),
    ],
    { site: "site" },
  );
  expect(kinds(recording)).toEqual([["navigate", "fill"]]);
});

test("a value event for a field first seen on a previous page starts a new step, not a merge", () => {
  reset();
  // `eid`s restart at 1 in every document, so eid 1 on /b is a different
  // element from eid 1 on /a. Merging them would put /b's typing into /a's step.
  const recording = assembleRecording(
    [
      nav("http://site.test/a"),
      act("input", "1", { rawText: "one", resolution: ok({ label: "First" }) }),
      nav("http://site.test/b"),
      act("input", "1", { rawText: "twotwo", resolution: ok({ label: "Second" }) }),
    ],
    { site: "site" },
  );
  expect(kinds(recording)).toEqual([["navigate", "fill"], ["fill"]]);
  const second = recording.pages[1]!.steps[0]!.step;
  if (second.kind !== "fill") throw new Error("expected fill");
  expect(second.value).toEqual({ redacted: true, length: 6 });
  expect(second.target).toEqual({ label: "Second" });
});

test("an action whose descriptor was never computed becomes a handback resuming on the frame URL", () => {
  reset();
  const recording = assembleRecording(
    [nav("http://site.test/a"), act("click", "1", { tag: "button", rawText: "Go" })],
    { site: "site" },
  );
  const step = recording.pages[0]!.steps[1]!.step;
  expect(step).toEqual({
    kind: "handback",
    prompt: expect.stringContaining("could not be described"),
    resume: { kind: "urlIncludes", text: "/a" },
  });
});

test("carries intent, retro, startedAtIso and site, and omits the optional ones when unset", () => {
  reset();
  const full = assembleRecording([nav("http://site.test/a")], {
    site: "example-site",
    startedAtIso: "2026-09-17T00:00:00.000Z",
    intent: "do the thing",
    retro: "it went fine",
  });
  expect(full).toMatchObject({
    version: "1.0.0",
    site: "example-site",
    startedAtIso: "2026-09-17T00:00:00.000Z",
    intent: "do the thing",
    retro: "it went fine",
  });

  reset();
  const bare = assembleRecording([nav("http://site.test/a")], { site: "example-site" });
  expect("intent" in bare).toBe(false);
  expect("retro" in bare).toBe(false);
  expect("startedAtIso" in bare).toBe(false);
});

test("an empty buffer assembles to a schema-valid recording with no pages", () => {
  reset();
  const recording = assembleRecording([], { site: "site" });
  expect(recording.pages).toEqual([]);
  expect(() => RecordingSchema.parse(recording)).not.toThrow();
});

test("pathOf keeps path and query, and refuses anything that is not http(s)", () => {
  expect(pathOf("http://site.test/inbox?page=2")).toBe("/inbox?page=2");
  expect(pathOf("https://site.test/")).toBe("/");
  // `new URL("about:blank").pathname` is the bare string "blank", which would
  // fail NavigateUrlSchema's leading-slash rule — hence the protocol guard.
  expect(pathOf("about:blank")).toBeNull();
  expect(pathOf("data:text/html,<p>x")).toBeNull();
  expect(pathOf("not a url")).toBeNull();
});
