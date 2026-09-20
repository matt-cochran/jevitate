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
  authoredBy?: "human-demonstration" | "jev-driven";
  createdAtIso: string;
}
export interface Journey { metadata: JourneyMetadata; recording: Recording }

const SecretRefSchema = z.object({
  manager: z.string(), key: z.string(), origin: z.string(), field: z.string(),
}).strict();

// `id` is used to build a filesystem path (see `FsJourneyStore`), so it is
// constrained to a safe format at the schema level (root-cause fix; the
// `assertSafeId` guards at individual id->path call sites remain as
// defense-in-depth). Must start with an alphanumeric char, then any run of
// alphanumerics/`.`/`_`/`-` — this rejects `/`, `\`, `..`, and the empty
// string, while still accepting existing bare ids like `login`,
// `checkout`, `j`, `gmail-archive-thread`.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const JourneySchema: ZodType<Journey> = z.object({
  metadata: z.object({
    id: z.string().regex(SAFE_ID_RE, "invalid id"),
    name: z.string(),
    description: z.string().optional(),
    promoted: z.boolean(),
    params: z.array(z.string()),
    secretRefs: z.array(SecretRefSchema).optional(),
    authoredBy: z.enum(["human-demonstration", "jev-driven"]).optional(),
    createdAtIso: z.string(),
  }).strict(),
  recording: RecordingSchema,
});
