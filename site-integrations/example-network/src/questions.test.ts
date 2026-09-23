import { expect, test } from "vitest";
import { CastActor } from "@jevitate/screenplay";
import { BrowseTheWeb } from "@jevitate/screenplay";
import { AuthenticatedUser } from "./questions.js";

function actorWithPage(page: any) {
  const session = { page, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
  return CastActor.named("T").whoCan(new BrowseTheWeb(session, []));
}

test("AuthenticatedUser reads /whoami JSON via page.request", async () => {
  const page: any = { request: { get: async (u: string) => ({ json: async () => ({ authenticated: true, account: "jane" }) }) } };
  const actor = actorWithPage(page);
  expect(await actor.asks(AuthenticatedUser)).toEqual({ authenticated: true, account: "jane" });
});
