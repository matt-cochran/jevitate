import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export class LockTimeoutError extends Error {
  constructor(id: string) { super(`could not acquire inbox lock for '${id}'`); this.name = "LockTimeoutError"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withIdLock<T>(
  dir: string,
  id: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number; retryMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 30_000;
  const retryMs = opts.retryMs ?? 20;
  const maxWaitMs = opts.maxWaitMs ?? 10_000;
  const lockPath = join(dir, `${id}.lock`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const h = await open(lockPath, "wx", 0o600);
      await h.close();
      break;
    } catch (err) {
      if (!isCode(err, "EEXIST")) throw err;
      // Reclaim a stale lock ATOMICALLY (S-B): a blind stat-then-rm can delete
      // a racer's freshly-acquired lock. Only the process whose rename of the
      // stale lock succeeds may remove it and retry; everyone else just retries.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          const claimed = `${lockPath}.reclaim.${randomBytes(6).toString("hex")}`;
          await rename(lockPath, claimed); // throws ENOENT if another proc already reclaimed
          await rm(claimed, { force: true });
          continue; // lock slot is now free — loop retries open("wx")
        }
      } catch { /* lock vanished or was reclaimed by another proc — retry */ }
      if (Date.now() > deadline) throw new LockTimeoutError(id);
      await sleep(retryMs);
    }
  }
  try { return await fn(); }
  finally { await rm(lockPath, { force: true }); }
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}
