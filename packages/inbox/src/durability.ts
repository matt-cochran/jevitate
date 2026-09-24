import type { FileHandle } from "node:fs/promises";

/**
 * Whether inbox writes are flushed to stable storage (fsync) before they are acknowledged.
 *
 * ON by default — the inbox is a durable message bus and a crash must not lose a queued command.
 * `JEVITATE_DURABLE_WRITES=off` turns the flush off. It exists for the TEST SUITE only (set in
 * vitest.config.ts): the tests exercise the store's logic, atomicity and locking, none of which
 * depends on the flush — while the flush makes a test's duration depend on how fast the HOST's disk
 * writeback is at that moment (seconds under memory pressure), which is what turned fast inbox
 * tests into timeouts on a loaded machine. Never set it in production.
 */
export function durableWritesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.JEVITATE_DURABLE_WRITES !== "off";
}

/** fsync the handle unless durable writes were turned off (see `durableWritesEnabled`). */
export async function flushIfDurable(handle: Pick<FileHandle, "sync">): Promise<void> {
  if (durableWritesEnabled()) await handle.sync();
}
