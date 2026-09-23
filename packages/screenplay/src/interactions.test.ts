import { expect, test } from "vitest";
import { CastActor } from "./cast-actor.js";
import { BrowseTheWeb } from "./browse-the-web.js";
import { PaceInteractions } from "./pace-interactions.js";
import { Target } from "./target.js";
import { Click, Enter, EnterSecret, Navigate } from "./interactions.js";
import { TextOf } from "./questions.js";
import { Pacer } from "@jevitate/domain";
import type { InteractionPolicy } from "@jevitate/domain";

function fakeSessionWithPage(page: any) {
  return { page, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
}

test("Navigate/Enter/Click drive the page; TextOf reads locator text", async () => {
  const calls: string[] = [];
  const locator = {
    click: async () => { calls.push("click"); },
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    innerText: async () => "hello",
  };
  const page: any = { goto: async (p: string) => { calls.push(`goto:${p}`); }, getByRole: () => locator, getByLabel: () => locator };
  const actor = CastActor.named("T").whoCan(new BrowseTheWeb(fakeSessionWithPage(page), []));
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  const Btn = Target.named("btn").locatedBy((p: any) => p.getByRole("button"));
  await actor.attemptsTo(Navigate.to("/inbox"), Enter.theText("hi").into(Box), Click.on(Btn));
  expect(calls).toEqual(["goto:/inbox", "fill:hi", "click"]);
  expect(await actor.asks(TextOf.target(Box))).toBe("hello");
});

// perKeyJitter: 0 and no word/sentence/hesitation pauses makes typingDelays
// fully deterministic (gaussian sd=0 collapses to the mean), independent of
// rng draws, so the rng function below is never actually consulted.
const TYPING_POLICY: InteractionPolicy = {
  typing: { charsPerSecond: 10, perKeyJitter: 0 },
};

test("Enter.theText types char-by-char with pacing sleeps when actor is paced with a typing model", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async (c: string, opts: { delay: number }) => { calls.push(`type:${c}:${opts.delay}`); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T")
    .whoCan(
      new BrowseTheWeb(fakeSessionWithPage(page), []),
      new PaceInteractions(TYPING_POLICY, new Pacer(() => 0.5), async (ms: number) => { sleeps.push(ms); }),
    );
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  await actor.attemptsTo(Enter.theText("hi").into(Box));
  expect(calls).toEqual(["fill:", "type:h:0", "type:i:0"]);
  expect(sleeps).toEqual([100, 100]);
});

test("Enter.theText clears the field (fill('')) BEFORE any pressSequentially calls when paced with a typing model", async () => {
  const calls: string[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async (c: string) => { calls.push(`type:${c}`); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T")
    .whoCan(
      new BrowseTheWeb(fakeSessionWithPage(page), []),
      new PaceInteractions(TYPING_POLICY, new Pacer(() => 0.5), async () => {}),
    );
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  await actor.attemptsTo(Enter.theText("hi").into(Box));
  expect(calls).toEqual(["fill:", "type:h", "type:i"]);
});

test("Enter.theText('') still clears the field when paced (no longer a no-op)", async () => {
  const calls: string[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async (c: string) => { calls.push(`type:${c}`); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T")
    .whoCan(
      new BrowseTheWeb(fakeSessionWithPage(page), []),
      new PaceInteractions(TYPING_POLICY, new Pacer(() => 0.5), async () => {}),
    );
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  await actor.attemptsTo(Enter.theText("").into(Box));
  expect(calls).toEqual(["fill:"]);
});

test("Enter.theText falls back to fill() with zero sleeps when actor is paced but has no typing model", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async () => { calls.push("type"); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T")
    .whoCan(
      new BrowseTheWeb(fakeSessionWithPage(page), []),
      new PaceInteractions({}, new Pacer(() => 0.5), async (ms: number) => { sleeps.push(ms); }),
    );
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  await actor.attemptsTo(Enter.theText("hi").into(Box));
  expect(calls).toEqual(["fill:hi"]);
  expect(sleeps).toEqual([]);
});

test("Enter.theText uses fill() with zero sleeps when actor is unpaced (no PaceInteractions ability)", async () => {
  const calls: string[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async () => { calls.push("type"); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T").whoCan(new BrowseTheWeb(fakeSessionWithPage(page), []));
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  await actor.attemptsTo(Enter.theText("hi").into(Box));
  expect(calls).toEqual(["fill:hi"]);
});

// Floor #6 fix (Slice 1b review round 1, Finding 1): Enter.theText's
// description interpolates the raw value, which would leak a secret's
// plaintext into any Activity.description if used for a credential fill
// (e.g. a future console.debug(activity.description) in attemptsTo).
// EnterSecret is a REDACTED sibling — its description NEVER contains the
// wrapped value, no matter what performAs types into the page.
test("EnterSecret.theSecret's description never contains the revealed secret value", () => {
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  const secret = { reveal: () => "hunter2" };
  const activity = EnterSecret.theSecret(secret).into(Box);
  expect(activity.description).not.toContain("hunter2");
  expect(activity.description).toContain("box");
});

test("EnterSecret.theSecret fills the target with the secret's revealed value (unpaced)", async () => {
  const calls: string[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async () => { calls.push("type"); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T").whoCan(new BrowseTheWeb(fakeSessionWithPage(page), []));
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  const secret = { reveal: () => "hunter2" };
  await actor.attemptsTo(EnterSecret.theSecret(secret).into(Box));
  expect(calls).toEqual(["fill:hunter2"]);
});

test("EnterSecret.theSecret types char-by-char with pacing sleeps when actor is paced with a typing model", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const locator = {
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async (c: string, opts: { delay: number }) => { calls.push(`type:${c}:${opts.delay}`); },
  };
  const page: any = { getByRole: () => locator };
  const actor = CastActor.named("T")
    .whoCan(
      new BrowseTheWeb(fakeSessionWithPage(page), []),
      new PaceInteractions(TYPING_POLICY, new Pacer(() => 0.5), async (ms: number) => { sleeps.push(ms); }),
    );
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  const secret = { reveal: () => "hi" };
  await actor.attemptsTo(EnterSecret.theSecret(secret).into(Box));
  expect(calls).toEqual(["fill:", "type:h:0", "type:i:0"]);
  expect(sleeps).toEqual([100, 100]);
});
