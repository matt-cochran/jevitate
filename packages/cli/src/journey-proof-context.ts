import { contentHash } from "@jevitate/domain";
import { journeyLegacyReviewHash, journeyProofHash, journeyReviewHash, type Journey } from "@jevitate/journey";
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

/** Unknown planner identity or a different effective read policy cannot be fresh evidence. */
export function currentJourneyProof(journey: Journey, record: { readonly journeyId: string; readonly proofHash?: string; readonly proofContext?: JourneyProofContext }, readRequests: readonly string[] | undefined): boolean {
  return record.journeyId === journey.metadata.id && record.proofHash !== undefined &&
    record.proofHash === currentJourneyProofHash(journey, record.proofContext, readRequests);
}


/** #816: why a receipt is not current (see `ReviewVerifySchema.staleCause`). */
export type JourneyProofStaleCause = "journey-changed" | "engine" | "engine-unknown" | "read-policy" | "no-planner-identity";

/**
 * #816: why a receipt that `currentJourneyProof` refuses is stale. A Journey is only said to have changed
 * when its content differs from what the receipt bound. A receipt whose review hash still matches, under
 * the same read requests, is `engine` when it names the engine that recorded it (0.30.0 receipts do), and
 * `engine-unknown` when it names none.
 */
export function journeyProofStaleCause(journey: Journey, record: { readonly journeyId: string; readonly contentHash: string; readonly proofHash?: string; readonly proofContext?: JourneyProofContext; readonly engine?: { readonly version: string; readonly commit: string } }, readRequests: readonly string[] | undefined): JourneyProofStaleCause {
  if (record.journeyId !== journey.metadata.id) return "journey-changed";
  if (record.proofHash === undefined) return "no-planner-identity";
  if (JSON.stringify(canonicalReadRequests(record.proofContext?.readRequests) ?? null) !== JSON.stringify(canonicalReadRequests(readRequests) ?? null)) return "read-policy";
  const unchanged = record.contentHash === journeyReviewHash(journey) || record.contentHash === journeyLegacyReviewHash(journey);
  if (!unchanged) return "journey-changed";
  // Grounded in the receipt's stored producer; a receipt that names none cannot say the engine differed.
  return typeof record.engine?.version === "string" && typeof record.engine.commit === "string" ? "engine" : "engine-unknown";
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
