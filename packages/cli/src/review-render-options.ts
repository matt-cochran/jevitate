import type { RenderOptions } from "./journey-review.js";

/** The terminal facts the decision reads (injectable for tests). */
export interface ReviewTerminal {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** #496: the live process's stdout and environment. */
export function processTerminal(): ReviewTerminal {
  return { isTTY: process.stdout.isTTY === true, ...(process.stdout.columns === undefined ? {} : { columns: process.stdout.columns }), env: process.env };
}

/**
 * #496: how a review sheet is rendered for people. Width is the terminal's when stdout is a TTY, else 100;
 * colour only on a TTY with NO_COLOR unset/empty and never in a file (`--out`); `full` adds the detail sections.
 */
export function reviewRenderOptions(opts: { full?: boolean; toFile?: boolean }, term: ReviewTerminal = processTerminal()): RenderOptions {
  const noColor = (term.env.NO_COLOR ?? "") !== "";
  return {
    width: term.isTTY && term.columns !== undefined && term.columns > 0 ? term.columns : 100,
    color: term.isTTY && !noColor && opts.toFile !== true,
    ...(opts.full === true ? { full: true } : {}),
  };
}
