import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageStateSnapshotter } from "./storage-state-snapshot.js";
import { persistStorageState } from "./explore-api.js";

/**
 * #159 unit coverage for the pieces `explore-api.ts`/`ux-api.ts`/`kill-signal.ts` build on:
 *  - `StorageStateSnapshotter`: the cheap, best-effort, never-from-a-login-like-page in-memory
 *    snapshot the kill switch writes synchronously and `persistStorageState` falls back to.
 *  - `persistStorageState`: never overwrites a good file with a live capture taken from a
 *    login-like page, and falls back to the last known-good snapshot when a live capture is unsafe
 *    or fails outright (a crashed/closed browser context) — never throwing itself either way.
 */
describe("StorageStateSnapshotter", () => {
  it("does nothing when disabled — the browser is never touched", async () => {
    const capture = vi.fn(async () => "{}");
    const snap = new StorageStateSnapshotter({ captureStorageState: capture }, false);
    snap.noteSettledStep("http://x.test/app");
    await new Promise((r) => setTimeout(r, 10));
    expect(capture).not.toHaveBeenCalled();
    expect(snap.snapshot()).toBeUndefined();
  });

  it("does nothing when the session has no captureStorageState (an older/fake port)", async () => {
    const snap = new StorageStateSnapshotter({}, true);
    snap.noteSettledStep("http://x.test/app");
    await new Promise((r) => setTimeout(r, 10));
    expect(snap.snapshot()).toBeUndefined();
  });

  it("refreshes the snapshot from a non-login-like page", async () => {
    const capture = vi.fn(async () => '{"cookies":["good"],"origins":[]}');
    const snap = new StorageStateSnapshotter({ captureStorageState: capture }, true);
    snap.noteSettledStep("http://x.test/app");
    await vi.waitFor(() => expect(snap.snapshot()).toBe('{"cookies":["good"],"origins":[]}'));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("never refreshes from a login-like page — the last good snapshot is kept", async () => {
    const capture = vi.fn(async () => '{"cookies":["good"],"origins":[]}');
    const snap = new StorageStateSnapshotter({ captureStorageState: capture }, true);
    snap.noteSettledStep("http://x.test/app");
    await vi.waitFor(() => expect(snap.snapshot()).toBe('{"cookies":["good"],"origins":[]}'));
    snap.noteSettledStep("http://x.test/login");
    await new Promise((r) => setTimeout(r, 10));
    expect(capture).toHaveBeenCalledTimes(1); // the login-like step never triggered a second capture
    expect(snap.snapshot()).toBe('{"cookies":["good"],"origins":[]}');
  });

  it("a failed capture leaves the previous snapshot in place", async () => {
    let calls = 0;
    const capture = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return '{"cookies":["first"],"origins":[]}';
      throw new Error("context closed");
    });
    const snap = new StorageStateSnapshotter({ captureStorageState: capture }, true);
    snap.noteSettledStep("http://x.test/app");
    await vi.waitFor(() => expect(snap.snapshot()).toBe('{"cookies":["first"],"origins":[]}'));
    snap.noteSettledStep("http://x.test/app");
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(snap.snapshot()).toBe('{"cookies":["first"],"origins":[]}');
  });
});

describe("persistStorageState", () => {
  let outDir: string;
  let file: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "jev-persist-storage-state-"));
    file = join(outDir, "state.json");
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("is a no-op when no file was asked for", async () => {
    const saveStorageState = vi.fn();
    await persistStorageState({ page: { url: () => "http://x.test/app" }, saveStorageState }, undefined);
    expect(saveStorageState).not.toHaveBeenCalled();
  });

  it("writes a live capture, mode 0600, when the page does not look logged out", async () => {
    const saveStorageState = vi.fn(async (f: string) => {
      await writeFile(f, '{"cookies":["live"],"origins":[]}');
    });
    await persistStorageState({ page: { url: () => "http://x.test/app" }, saveStorageState }, file);
    expect(saveStorageState).toHaveBeenCalledWith(file);
    expect(await readFile(file, "utf8")).toBe('{"cookies":["live"],"origins":[]}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("falls back to the last known-good snapshot when the live capture fails (a crashed/closed context)", async () => {
    const snap = new StorageStateSnapshotter({ captureStorageState: async () => '{"cookies":["good"],"origins":[]}' }, true);
    snap.noteSettledStep("http://x.test/app");
    await vi.waitFor(() => expect(snap.snapshot()).toBeDefined());

    const saveStorageState = vi.fn(async () => {
      throw new Error("Target closed");
    });
    await persistStorageState({ page: { url: () => "http://x.test/app" }, saveStorageState }, file, snap);
    expect(await readFile(file, "utf8")).toBe('{"cookies":["good"],"origins":[]}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("never attempts a live capture from a login-like page — uses the snapshot fallback instead", async () => {
    const snap = new StorageStateSnapshotter({ captureStorageState: async () => '{"cookies":["good"],"origins":[]}' }, true);
    snap.noteSettledStep("http://x.test/app");
    await vi.waitFor(() => expect(snap.snapshot()).toBeDefined());

    const saveStorageState = vi.fn();
    await persistStorageState({ page: { url: () => "http://x.test/login" }, saveStorageState }, file, snap);
    expect(saveStorageState).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe('{"cookies":["good"],"origins":[]}');
  });

  it("writes nothing when the live capture is unsafe/fails and there is no snapshot to fall back to", async () => {
    const saveStorageState = vi.fn(async () => {
      throw new Error("Target closed");
    });
    await persistStorageState({ page: { url: () => "http://x.test/app" }, saveStorageState }, file);
    await expect(stat(file)).rejects.toThrow();
  });

  it("never overwrites a good, pre-existing file with a lost/logged-out session", async () => {
    await writeFile(file, "PRE-EXISTING-GOOD-STATE", { mode: 0o600 });
    const saveStorageState = vi.fn();
    await persistStorageState({ page: { url: () => "http://x.test/login" }, saveStorageState }, file);
    expect(saveStorageState).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("PRE-EXISTING-GOOD-STATE");
  });
});
