import { z } from "zod";
import { defineAction } from "@doit/site-sdk";
import { Navigate } from "@doit/screenplay";
import { NormalizedThreadSchema } from "@doit/domain";
import { AuthenticatedUser, InboxThreads, ThreadDetail } from "./questions.js";

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

export const EXAMPLE_NETWORK_ACTIONS = [SessionStatus, InboxList, ThreadGet];
