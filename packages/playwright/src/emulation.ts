import { devices } from "playwright";

/**
 * Per-mission viewport/device emulation (#149) — resolves a CLI-facing `--viewport <W>x<H>` /
 * `--device "<name>"` pair into the Playwright context options that actually change what the
 * browser reports (`viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`).
 *
 * `--device` is validated against Playwright's OWN built-in `devices` registry — never an
 * arbitrary caller-supplied UA string, so emulation can never be used to impersonate an
 * unregistered client (dogfood A12/A24/A25's motivation, spec guardrail).
 */

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** What a caller asks for: at most one of `viewport` / `device` (mutually exclusive). */
export interface EmulationSpec {
  readonly viewport?: ViewportSize;
  readonly device?: string;
}

/** What a spec resolves to — Playwright `BrowserContextOptions` fields, plus the device name (if any) for recording. */
export interface ResolvedEmulation {
  readonly viewport: ViewportSize;
  readonly deviceScaleFactor?: number;
  readonly isMobile?: boolean;
  readonly hasTouch?: boolean;
  readonly userAgent?: string;
  /** The device name this was resolved from (`--device`); absent for a bare `--viewport`. */
  readonly device?: string;
}

export class UnknownDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownDeviceError";
  }
}

export class ConflictingEmulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictingEmulationError";
  }
}

/** Every device name Playwright's registry knows (stable order: as `devices` enumerates them). */
export function knownDeviceNames(): string[] {
  return Object.keys(devices);
}

/** Levenshtein edit distance — small, pure, used only to rank "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  const row = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) row[j] = j;
  for (let i = 1; i <= al; i++) {
    let prevDiag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= bl; j++) {
      const temp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, row[j]!, row[j - 1]!);
      prevDiag = temp;
    }
  }
  return row[bl]!;
}

/** The `limit` closest known device names to `name` (case-insensitive), nearest first. */
export function closestDeviceNames(name: string, limit = 5, names: readonly string[] = knownDeviceNames()): string[] {
  const needle = name.toLowerCase();
  return [...names]
    .map((n) => ({ n, d: editDistance(needle, n.toLowerCase()) }))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map((x) => x.n);
}

/** Parses CLI `--viewport <W>x<H>` (e.g. `375x812`) into a `ViewportSize`. Throws on anything else. */
export function parseViewport(raw: string): ViewportSize {
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (match === null) throw new RangeError(`--viewport must be <width>x<height> (e.g. 375x812), got ${JSON.stringify(raw)}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) throw new RangeError(`--viewport width and height must be positive, got ${JSON.stringify(raw)}`);
  return { width, height };
}

/**
 * Resolves an `EmulationSpec` to the concrete context options, or `undefined` for "use Playwright's
 * default viewport" (no `--viewport`/`--device` given). Refuses BEFORE any browser opens:
 *  - `viewport` and `device` together: `ConflictingEmulationError` (mutually exclusive, #149).
 *  - an unregistered `device` name: `UnknownDeviceError`, listing the closest registered names.
 */
export function resolveEmulation(spec: EmulationSpec | undefined): ResolvedEmulation | undefined {
  if (spec === undefined) return undefined;
  const { viewport, device } = spec;
  if (viewport !== undefined && device !== undefined) {
    throw new ConflictingEmulationError("--viewport and --device are mutually exclusive; pass exactly one");
  }
  if (device !== undefined) {
    const d = (devices as Record<string, ResolvedEmulation | undefined>)[device];
    if (d === undefined) {
      const close = closestDeviceNames(device);
      throw new UnknownDeviceError(`unknown device ${JSON.stringify(device)}; close matches: ${close.join(", ")}`);
    }
    return {
      viewport: d.viewport,
      ...(d.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: d.deviceScaleFactor }),
      ...(d.isMobile === undefined ? {} : { isMobile: d.isMobile }),
      ...(d.hasTouch === undefined ? {} : { hasTouch: d.hasTouch }),
      ...(d.userAgent === undefined ? {} : { userAgent: d.userAgent }),
      device,
    };
  }
  if (viewport !== undefined) return { viewport };
  return undefined;
}

/** The Playwright `BrowserContextOptions` fields a resolved emulation sets — merged into `newContext`/`launchPersistentContext`. */
export function emulationContextOptions(
  e: ResolvedEmulation,
): { viewport: ViewportSize; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean; userAgent?: string } {
  return {
    viewport: e.viewport,
    ...(e.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: e.deviceScaleFactor }),
    ...(e.isMobile === undefined ? {} : { isMobile: e.isMobile }),
    ...(e.hasTouch === undefined ? {} : { hasTouch: e.hasTouch }),
    ...(e.userAgent === undefined ? {} : { userAgent: e.userAgent }),
  };
}
