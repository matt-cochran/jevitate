import { open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Atomic write the FsMissionQueueStore pattern lacks (verified: every Fs*Store
 * uses bare writeFile). Write to a temp file in the SAME dir, fsync, then
 * rename over the target — rename is atomic on one filesystem, so a concurrent
 * reader never observes a partial file. On ANY failure the temp file is
 * removed so a partial/orphan .tmp never leaks (C-D).
 *
 * NOTE: rename OVERWRITES the target — this helper does NOT provide exclusive
 * create. `enqueue` (Task 4) must guard id-conflict separately via open(final,"wx").
 */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const handle = await open(tmp, "wx", mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
