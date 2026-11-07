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
    readRequests: z.array(z.string()).optional(),
  })
  .strict();
export type JourneyProofContext = z.infer<typeof JourneyProofContextSchema>;

/** Canonical, secret-free execution context for a verify receipt. */
export function journeyProofContext(browser: BrowserRunOptions | undefined, emulation: EmulationSpec | undefined, readRequests: readonly string[] = []): JourneyProofContext | undefined {
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
    ...(readRequests.length === 0 ? {} : { readRequests: [...new Set(readRequests)].sort() }),
  };
  return Object.keys(context).length === 0 ? undefined : JourneyProofContextSchema.parse(context);
}

/** Backward compatible without overrides; context-shaped proofs cannot be reused under another context. */
export function journeyProofHashForContext(journey: Journey, context: JourneyProofContext | undefined): string {
  const executableHash = journeyProofHash(journey);
  return context === undefined ? executableHash : contentHash({ v: 1, executableHash, context });
}

/** Unknown planner identity or a different effective read policy cannot be fresh evidence. */
export function currentJourneyProof(journey: Journey, record: { readonly journeyId: string; readonly proofHash?: string; readonly proofContext?: JourneyProofContext }, readRequests: readonly string[] = []): boolean {
  return record.journeyId === journey.metadata.id && record.proofHash !== undefined &&
    JSON.stringify([...new Set(readRequests)].sort()) === JSON.stringify([...new Set(record.proofContext?.readRequests ?? [])].sort()) &&
    record.proofHash === journeyProofHashForContext(journey, record.proofContext);
}


/** Native executable identity only: neither a successful proof nor owner approval. */
export interface JourneyExecutionIdentity {
  readonly kind: "journey-execution-identity";
  readonly version: 1;
  readonly journeyId: string;
  readonly proofHash: string;
}

/** Uses the same canonical source/context digest as the persisted native proof. */
export function journeyExecutionIdentity(journey: Journey, context: JourneyProofContext | undefined): JourneyExecutionIdentity {
  return { kind: "journey-execution-identity", version: 1, journeyId: journey.metadata.id, proofHash: journeyProofHashForContext(journey, context) };
}
