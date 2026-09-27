import { InvalidArgumentError } from "commander";

/**
 * Numeric option parsers (#218), used as commander `argParser`s so a bad number is refused while
 * the command line is parsed — a usage error (exit 64, `useUsageExitCode`), before anything runs —
 * rather than a `NaN` reaching a run and failing it at runtime (exit 2, "proves nothing").
 *
 * Every numeric flag of every command takes one of these; `cli-refusal.test.ts` walks the program
 * and fails when a `<n>`/`<ms>`/`<k>` option has none.
 */

export interface IntArgBounds {
  /** Smallest accepted value (inclusive). */
  readonly min?: number;
  /** Largest accepted value (inclusive). */
  readonly max?: number;
}

function describe(bounds: IntArgBounds): string {
  if (bounds.min !== undefined && bounds.max !== undefined) return `an integer from ${bounds.min} to ${bounds.max}`;
  if (bounds.min === 0) return "a non-negative integer";
  if (bounds.min === 1) return "a positive integer";
  if (bounds.min !== undefined) return `an integer ≥ ${bounds.min}`;
  if (bounds.max !== undefined) return `an integer ≤ ${bounds.max}`;
  return "an integer";
}

/** A commander argParser for an integer option within `bounds` (decimal digits only: no `1e3`, `0x10`, `2.5`). */
export function intArg(bounds: IntArgBounds = {}): (value: string) => number {
  return (value: string): number => {
    const n = /^-?\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || (bounds.min !== undefined && n < bounds.min) || (bounds.max !== undefined && n > bounds.max)) {
      throw new InvalidArgumentError(`must be ${describe(bounds)} (got ${JSON.stringify(value)})`);
    }
    return n;
  };
}

/** `≥ 1`: counts and caps (replays, attempts, takes, actions, concurrency, …). */
export const positiveIntArg = intArg({ min: 1 });
/** `≥ 0`: durations in ms and counts where 0 means "none" (e.g. `--hang-replays 0`). */
export const nonNegativeIntArg = intArg({ min: 0 });

/** A commander argParser for a ratio in [0, 1] (e.g. `--min-control-coverage 0.8`). */
export function ratioArg(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new InvalidArgumentError(`must be a number from 0 to 1 (got ${JSON.stringify(value)})`);
  return n;
}

/** A commander argParser for a number > 0, fractions allowed (e.g. `--stall-timeout 1.5` seconds). */
export function positiveNumberArg(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`must be a positive number (got ${JSON.stringify(value)})`);
  return n;
}

/** A commander argParser for any finite number (e.g. an RNG `--seed`). */
export function finiteNumberArg(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) throw new InvalidArgumentError(`must be a finite number (got ${JSON.stringify(value)})`);
  return n;
}
