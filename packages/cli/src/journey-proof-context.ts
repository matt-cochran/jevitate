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
  })
  .strict();
export type JourneyProofContext = z.infer<typeof JourneyProofContextSchema>;

/** Canonical, secret-free execution context for a verify receipt. */
export function journeyProofContext(browser: BrowserRunOptions | undefined, emulation: EmulationSpec | undefined): JourneyProofContext | undefined {
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
  };
  return Object.keys(context).length === 0 ? undefined : JourneyProofContextSchema.parse(context);
}

/** Backward compatible without overrides; context-shaped proofs cannot be reused under another context. */
export function journeyProofHashForContext(journey: Journey, context: JourneyProofContext | undefined): string {
  const executableHash = journeyProofHash(journey);
  return context === undefined ? executableHash : contentHash({ v: 1, executableHash, context });
}
