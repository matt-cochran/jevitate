import { clock } from "@jevitate/domain";

/**
 * #304: bounds `work` on the injectable clock — resolves `onTimeout` once `ms` of clock time pass
 * first. A Playwright wait (`waitForFunction`) carries its own REAL-time timeout; racing it against
 * the clock makes the bound follow the clock tests drive (with the real clock both fire together,
 * so behaviour is unchanged). The timer is always cleared, so it never holds the process open.
 */
export async function clockBounded<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof clock.setTimeout> | undefined;
  const bound = new Promise<T>((resolve) => {
    timer = clock.setTimeout(() => resolve(onTimeout), Math.max(1, ms));
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}
