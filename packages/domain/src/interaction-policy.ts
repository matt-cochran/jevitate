import { z } from "zod";

const Dist = z.object({
  mean: z.number().min(0),
  sd: z.number().min(0),
  min: z.number().min(0).optional(),
  max: z.number().min(0).optional(),
});

const Typing = z.object({
  charsPerSecond: z.number().positive(),
  perKeyJitter: z.number().min(0).max(1),
  wordPauseMs: Dist.optional(),
  sentencePauseMs: Dist.optional(),
  hesitation: z
    .object({
      probability: z.number().min(0).max(1),
      pauseMs: Dist,
    })
    .optional(),
});

const Interaction = z.object({
  typing: Typing.optional(),
  thinkBeforeActionMs: Dist.optional(),
  readingMsPerChar: z.number().min(0).optional(),
  maxReadingMs: z.number().min(0).optional(),
  interInteractionMs: Dist.optional(),
});

const Throttle = z.object({
  minIntervalSeconds: z.number().min(0).optional(),
  hourlyLimit: z.number().int().min(0).optional(),
  dailyLimit: z.number().int().min(0).optional(),
});

export const SitePolicySchema = z.object({
  version: z.string().min(1),
  interaction: Interaction.optional(),
  throttles: z.record(z.string(), Throttle).optional(),
  quietHours: z
    .object({
      timezone: z.string().min(1),
      windows: z.array(z.object({ start: z.string(), end: z.string() })),
    })
    .optional(),
});

export type SitePolicy = z.infer<typeof SitePolicySchema>;
export type InteractionPolicy = z.infer<typeof Interaction>;
export type TypingModel = z.infer<typeof Typing>;
export type ThrottlePolicy = z.infer<typeof Throttle>;
export type DistParams = z.infer<typeof Dist>;
export type QuietHours = NonNullable<SitePolicy["quietHours"]>;
