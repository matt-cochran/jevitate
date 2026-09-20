import { z } from "zod";
import { defineAction } from "@jevitate/site-sdk";
import { Navigate, Enter, Click } from "@jevitate/screenplay";
import { NormalizedThreadSchema } from "@jevitate/domain";
import { AuthenticatedUser, InboxThreads, ThreadDetail } from "./questions.js";
import { UsernameField, SignInButton } from "./targets.js";

export const SessionStatus = defineAction({
  id: "session.status", version: "1.0.0",
  input: z.object({}),
  output: z.object({ authenticated: z.boolean(), account: z.string().nullable() }),
  risk: "read", throttleClass: "read",
  async execute(actor) {
    return actor.asks(AuthenticatedUser);
  },
});

export const InboxList = defineAction({
  id: "inbox.list", version: "1.0.0",
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({ items: z.array(NormalizedThreadSchema) }),
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    await actor.attemptsTo(Navigate.to("/inbox"));
    const items = await actor.asks(InboxThreads);
    return { items: items.slice(0, input.limit) };
  },
});

export const ThreadGet = defineAction({
  id: "thread.get", version: "1.0.0",
  input: z.object({ threadId: z.string().min(1) }),
  output: NormalizedThreadSchema,
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    await actor.attemptsTo(Navigate.to(`/thread/${input.threadId}`));
    return actor.asks(ThreadDetail(input.threadId));
  },
});

// Fixture/dev convenience for M2: real sites have the user log in interactively (per the CONOPS),
// so this action only exists to drive the example-network fixture through auth in tests/dev,
// not as a pattern for how production sites authenticate.
export const AuthLogin = defineAction({
  id: "auth.login", version: "1.0.0",
  input: z.object({ username: z.string().min(1) }),
  output: z.object({ authenticated: z.boolean() }),
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    await actor.attemptsTo(
      Navigate.to("/login"),
      Enter.theText(input.username).into(UsernameField),
      Click.on(SignInButton),
    );
    const who = await actor.asks(AuthenticatedUser);
    return { authenticated: who.authenticated };
  },
});

export const EXAMPLE_NETWORK_ACTIONS = [SessionStatus, InboxList, ThreadGet, AuthLogin];
