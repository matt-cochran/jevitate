import { describe, it, expect } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIdLock } from "./lock.js";

describe("withIdLock", () => {
  it("serializes concurrent critical sections on the same id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-lock-"));
    const order: string[] = [];
    let inside = 0;
    const crit = (tag: string) =>
      withIdLock(dir, "item", async () => {
        inside++;
        expect(inside).toBe(1); // never two at once
        order.push(`${tag}-in`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`${tag}-out`);
        inside--;
      });
    await Promise.all([crit("a"), crit("b")]);
    // serialized — either order is fine, but the two critical sections NEVER interleave
    expect(order.join(",")).toMatch(/^(a-in,a-out,b-in,b-out|b-in,b-out,a-in,a-out)$/);
  });

  it("releases the lock file after the critical section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-lock-"));
    await withIdLock(dir, "x", async () => {});
    expect((await readdir(dir)).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  it("releases the lock even when fn throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-lock-"));
    await expect(withIdLock(dir, "x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await readdir(dir)).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });
});
