import { expect, test } from "vitest";
import { CastActor } from "./cast-actor.js";
import { BrowseTheWeb } from "./browse-the-web.js";
import { Target } from "./target.js";
import { Click, Enter, Navigate } from "./interactions.js";
import { TextOf } from "./questions.js";

function fakeSessionWithPage(page: any) {
  return { page, startTracing: async () => {}, stopTracingToFile: async () => {}, close: async () => {} };
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
