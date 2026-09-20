import { z, type ZodType } from "zod";
import { RecordingSchema, type Recording } from "@jevitate/recording";

export interface SecretRef { manager: string; key: string; origin: string; field: string }
export interface JourneyMetadata {
  id: string;
  name: string;
  description?: string;
  promoted: boolean;
  params: string[];
  secretRefs?: SecretRef[];
  createdAtIso: string;
}
export interface Journey { metadata: JourneyMetadata; recording: Recording }

const SecretRefSchema = z.object({
  manager: z.string(), key: z.string(), origin: z.string(), field: z.string(),
}).strict();

export const JourneySchema: ZodType<Journey> = z.object({
  metadata: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    promoted: z.boolean(),
    params: z.array(z.string()),
    secretRefs: z.array(SecretRefSchema).optional(),
    createdAtIso: z.string(),
  }).strict(),
  recording: RecordingSchema,
});
