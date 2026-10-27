import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { preflightVerifyRecord, verifyRecordPath, VerifyReceiptPreflightError, writePreflightedVerifyRecord, writeVerifyRecord } from "./journey-review-store.js";
import { verifyJourneyMutations } from "./journey-verify.js";

let dir: string;
const record = () => ({ journeyId: "receipt", contentHash: "a".repeat(64), proofHash: "b".repeat(64), verdict: "proven" as const, summary: {}, at: "2026-10-26T00:00:00.000Z" });
const journey = (): Journey => ({ metadata: { id: "receipt", name: "Receipt", params: [], promoted: false, createdAtIso: "2026-10-26T00:00:00.000Z" }, recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [] }] } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-711-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("#711 verify receipt destinations", () => {
  it("writes a private receipt through the preflighted atomic destination", async () => {
    await writeVerifyRecord(dir, record());
    const path = verifyRecordPath(dir, "receipt");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ verdict: "proven" });
    const stat = await lstat(path);
    expect(stat.mode & 0o777).toBe(0o600);
    if (process.getuid !== undefined) expect(stat.uid).toBe(process.getuid());
  });

  it("refuses a symlink receipt without following it", async () => {
    const path = verifyRecordPath(dir, "receipt");
    const target = join(dir, "outside.json");
    await mkdir(join(dir, ".verify"), { recursive: true });
    await writeFile(target, "preserve");
    await symlink(target, path);
    await expect(preflightVerifyRecord(dir, "receipt")).rejects.toBeInstanceOf(VerifyReceiptPreflightError);
    expect(await readFile(target, "utf8")).toBe("preserve");
  });

  it("refuses a foreign-owned 0600 receipt before any proof spend", async () => {
    const path = verifyRecordPath(dir, "receipt");
    await mkdir(join(dir, ".verify"), { recursive: true });
    await writeFile(path, "stale", { mode: 0o600 });
    if (process.getuid === undefined) return;
    const actual = (await lstat(path)).uid;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(actual + 1);
    await expect(preflightVerifyRecord(dir, "receipt")).rejects.toMatchObject({ code: "E_VERIFY_RECEIPT_PREFLIGHT" });
    getuid.mockRestore();
  });

  it("refuses a concurrent destination replacement rather than clobbering it", async () => {
    const destination = await preflightVerifyRecord(dir, "receipt");
    await writeFile(destination.path, "another writer");
    await expect(writePreflightedVerifyRecord(destination, record())).rejects.toBeInstanceOf(VerifyReceiptPreflightError);
  });

  it("refuses the receipt before a mutation runner can spend browser work", async () => {
    await new FsJourneyStore(dir).put(journey());
    const path = verifyRecordPath(dir, "receipt");
    const target = join(dir, "outside.json");
    await mkdir(join(dir, ".verify"), { recursive: true });
    await writeFile(target, "preserve");
    await symlink(target, path);
    let calls = 0;
    await expect(verifyJourneyMutations({ dir, id: "receipt" }, (async () => { calls += 1; return { outcome: "ok", output: {} }; }) as never)).rejects.toBeInstanceOf(VerifyReceiptPreflightError);
    expect(calls).toBe(0);
  });
});
