import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { ActionRunner } from "@doit/runtime";
import { ActionRegistry, defineAction } from "@doit/site-sdk";
import { openDatabase, migrateToLatest, SqliteIncomingMessageRepository } from "@doit/storage-sqlite";
import { startServer } from "@doit/example-site";
import { EXAMPLE_NETWORK_ACTIONS } from "./actions.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() };

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "doit-e2e-"));
});
afterAll(async () => {
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

function runner() {
  const reg = new ActionRegistry();
  for (const a of EXAMPLE_NETWORK_ACTIONS) reg.register("example-network", a);
  return new ActionRunner(new PlaywrightBrowserPort(), reg);
}
const base = () => ({
  site: "example-network",
  account: "primary",
  profileDir,
  baseUrl: site.url,
  headless: true,
  allowedOrigins: [site.url],
});

test(
  "session.status is unauthenticated before login",
  async () => {
    const res = await runner().run({ ...base(), actionId: "session.status", version: "1.0.0", input: {} });
    expect(res.output).toMatchObject({ authenticated: false });
  },
  60_000,
);

test(
  "auth.login authenticates and session.status reflects it via the persisted profile",
  async () => {
    const r = runner();
    const login = await r.run({ ...base(), actionId: "auth.login", version: "1.0.0", input: { username: "jane" } });
    expect(login.output).toMatchObject({ authenticated: true });

    const status = await r.run({ ...base(), actionId: "session.status", version: "1.0.0", input: {} });
    expect(status.output).toMatchObject({ authenticated: true, account: "jane" });
  },
  60_000,
);

test(
  "inbox.list normalizes threads and dedups on re-run; thread.get returns a thread",
  async () => {
    const db = openDatabase(":memory:");
    await migrateToLatest(db);
    const repo = new SqliteIncomingMessageRepository(db, clock);

    const r = runner();
    // Re-authenticate defensively: test order should not matter for this test's correctness.
    await r.run({ ...base(), actionId: "auth.login", version: "1.0.0", input: { username: "jane" } });

    const first = await r.run({ ...base(), actionId: "inbox.list", version: "1.0.0", input: { limit: 10 } });
    const threads = (first.output as any).items;
    for (const t of threads) for (const m of t.messages) await repo.upsert("example-network", "primary", m);

    const second = await r.run({ ...base(), actionId: "inbox.list", version: "1.0.0", input: { limit: 10 } });
    for (const t of (second.output as any).items) for (const m of t.messages) await repo.upsert("example-network", "primary", m);

    const stored = await repo.listBySite("example-network", "primary");
    const totalMessages = threads.reduce((n: number, t: any) => n + t.messages.length, 0);
    expect(stored.length).toBe(totalMessages);

    const thread = await r.run({ ...base(), actionId: "thread.get", version: "1.0.0", input: { threadId: "t-1" } });
    expect(thread.output).toMatchObject({ sourceThreadId: "t-1", subject: "Welcome" });

    await db.destroy();
  },
  90_000,
);

test(
  "a runner failure captures a trace to traceDir",
  async () => {
    const Boom = defineAction({
      id: "diag.boom",
      version: "1.0.0",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      throttleClass: "read",
      async execute() {
        throw new Error("boom");
      },
    });
    const reg = new ActionRegistry();
    reg.register("example-network", Boom);
    const r = new ActionRunner(new PlaywrightBrowserPort(), reg);

    await expect(
      r.run({ ...base(), actionId: "diag.boom", version: "1.0.0", input: {}, traceDir: profileDir }),
    ).rejects.toThrow("boom");

    const traceFile = join(profileDir, "trace-diag.boom.zip");
    const stats = await stat(traceFile);
    expect(stats.isFile()).toBe(true);
  },
  60_000,
);
