import { contentHash } from "@jevitate/domain";
import { journeyProofHash, type Journey } from "@jevitate/journey";
import type { EmulationSpec } from "@jevitate/playwright";
import { z } from "zod";
import type { BrowserRunOptions } from "./browser-run-options.js";

const ViewportSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const GeolocationSchema = z
  .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().nonnegative().optional() })
  .strict();
const ExtensionSchema = z.object({ id: z.string(), name: z.string(), version: z.string(), manifestVersion: z.number().int() }).strict();

/** Material browser/run context a mutation proof is bound to. Demo and artifact-only flags are excluded. */
export const JourneyProofContextSchema = z
  .object({
    browser: z
      .object({
        executablePath: z.string().optional(),
        channel: z.string().optional(),
        args: z.array(z.string()).optional(),
        extensions: z.array(ExtensionSchema).optional(),
        headless: z.boolean().optional(),
      })
      .strict()
      .optional(),
    emulation: z.object({ viewport: ViewportSchema.optional(), device: z.string().optional(), geolocation: GeolocationSchema.optional() }).strict().optional(),
    /** The target's `safety.readRequests` the proof ran under: they decide which steps it mutates as writes. */
    readRequests: z.array(z.string()).optional(),
  })
  .strict();
export type JourneyProofContext = z.infer<typeof JourneyProofContextSchema>;

/** One text for one set of patterns. None at all is no field, so a target that declares none keeps its receipts' hash. */
function canonicalReadRequests(readRequests: readonly string[] | undefined): string[] | undefined {
  return readRequests === undefined || readRequests.length === 0 ? undefined : [...new Set(readRequests)].sort();
}

/** Canonical, secret-free execution context for a verify receipt. */
export function journeyProofContext(browser: BrowserRunOptions | undefined, emulation: EmulationSpec | undefined, readRequests?: readonly string[]): JourneyProofContext | undefined {
  const reads = canonicalReadRequests(readRequests);
  const browserContext = {
    ...(browser?.executablePath === undefined ? {} : { executablePath: browser.executablePath }),
    ...(browser?.channel === undefined ? {} : { channel: browser.channel }),
    ...(browser?.args === undefined || browser.args.length === 0 ? {} : { args: [...browser.args] }),
    ...(browser?.extensions === undefined || browser.extensions.length === 0
      ? {}
      : { extensions: browser.extensions.map(({ id, name, version, manifestVersion }) => ({ id, name, version, manifestVersion })) }),
    ...(browser?.headed === true ? { headless: false } : {}),
  };
  const context = {
    ...(Object.keys(browserContext).length === 0 ? {} : { browser: browserContext }),
    ...(emulation === undefined ? {} : { emulation }),
    ...(reads === undefined ? {} : { readRequests: reads }),
  };
  return Object.keys(context).length === 0 ? undefined : JourneyProofContextSchema.parse(context);
}

/** Backward compatible without overrides; context-shaped proofs cannot be reused under another context. */
export function journeyProofHashForContext(journey: Journey, context: JourneyProofContext | undefined): string {
  const executableHash = journeyProofHash(journey);
  return context === undefined ? executableHash : contentHash({ v: 1, executableHash, context });
}

/**
 * The hash a receipt must hold to be current now. Its browser context is its own, as no reader has a browser to
 * compare with; its read requests are the target's as they stand, so a change to them stales the proof.
 */
export function currentJourneyProofHash(journey: Journey, context: JourneyProofContext | undefined, readRequests: readonly string[] | undefined): string {
  const { readRequests: _recorded, ...rest } = context ?? {};
  const reads = canonicalReadRequests(readRequests);
  const current = { ...rest, ...(reads === undefined ? {} : { readRequests: reads }) };
  return journeyProofHashForContext(journey, Object.keys(current).length === 0 ? undefined : current);
}
