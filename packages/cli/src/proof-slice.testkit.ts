import { describe } from "vitest";

/**
 * #858: the real-clock proof files split across CI legs. `JEV_PROOF_SLICE=k/n` runs slice `k` of `n`;
 * unset, it is `1/1` and everything runs, as before. A file's proofs all run in one test process, where
 * eight at once contend for one event loop and one browser (a proof alone takes a fifth of its time in
 * the pool), so a slice on its own runner is real parallelism. Every slice of a list is a fixed
 * round-robin of it, so together the slices run each item exactly once.
 */
export interface ProofSlice {
  readonly k: number;
  readonly n: number;
}

export function proofSlice(raw: string | undefined = process.env["JEV_PROOF_SLICE"]): ProofSlice {
  if (raw === undefined || raw === "") return { k: 1, n: 1 };
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  const k = Number(m?.[1]);
  const n = Number(m?.[2]);
  if (m === null || !(n >= 1) || !(k >= 1 && k <= n)) throw new Error(`JEV_PROOF_SLICE must be k/n with 1 <= k <= n, not ${JSON.stringify(raw)}`);
  return { k, n };
}

/** The items of `items` in this slice: every `n`th, starting at `k - 1`. */
export function sliced<T>(items: readonly T[], slice: ProofSlice = proofSlice()): T[] {
  return items.filter((_, i) => i % slice.n === slice.k - 1);
}

/**
 * A `describe` per file that deals its top-level suites round-robin over the slices, in declaration
 * order; a suite outside this slice is skipped, its `beforeAll` with it.
 */
export function slicedDescribe(slice: ProofSlice = proofSlice()): (name: string, fn: () => void) => void {
  let next = 0;
  return (name, fn) => {
    const mine = next++ % slice.n === slice.k - 1;
    (mine ? describe : describe.skip)(name, fn);
  };
}
