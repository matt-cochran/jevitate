import { z, type ZodType } from "zod";
import { AssertionSchema, RecordingSchema, type Assertion, type Recording } from "@jevitate/recording";

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
  /**
   * Declares that this Journey only reaches its steps starting from an authenticated session
   * (#118). When true, a run given no `storageState` fails fast — before any browser launches —
   * with a clear "this Journey needs auth" message, instead of the confusing
   * `replay-target-not-found` a logged-out replay would otherwise hit deep into the steps.
   */
  requiresAuth?: boolean;
  /*
   * #246 intent — every field optional and additive: a Journey without them validates and runs
   * exactly as before. Documentation for people, demos and models; nothing here changes a replay.
   */
  /** What the Journey achieves, in one sentence. */
  goal?: string;
  /** Who does it (a person, in words). */
  persona?: string;
  /** The account role it runs as — the environment's session it needs (e.g. `admin`, `buyer`). */
  role?: string;
  /** The seed data and login it needs, linked to fixtures and hooks. */
  preconditions?: JourneyPrecondition[];
  /** The end state that means it worked; `check`, when given, is the code check for it. */
  successCriteria?: JourneySuccessCriterion[];
  /** Its inputs (`--param` names), with secrets marked for redaction. */
  parameters?: JourneyParameter[];
}

/** A precondition (#246): what must hold before the Journey starts, linked to how it is set up. */
export interface JourneyPrecondition {
  description: string;
  /** The `--fixtures` file (or a setup step's name in it) that establishes this state. */
  fixture?: string;
  /** The `--before` hook that establishes this state (a name or the command, never a secret). */
  hook?: string;
  /** Needs an authenticated session (`--storage-state`). */
  login?: boolean;
}

/** A success criterion (#246): the end state in words, plus the assertion that checks it in code. */
export interface JourneySuccessCriterion {
  description: string;
  check?: Assertion;
}

/**
 * A declared input (#246). `secret: true` marks a value (a password, a token) that is redacted
 * wherever it is shown: `journey run` output, `journey annotate` evidence and drafts, and anything
 * sent to a model. A declared parameter never carries a value — values arrive only as `--param`.
 */
export interface JourneyParameter {
  name: string;
  description?: string;
  secret?: boolean;
}

export interface Journey { metadata: JourneyMetadata; recording: Recording }

const TEXT = z.string().min(1).max(2000);

const JourneyPreconditionSchema = z.object({
  description: TEXT,
  fixture: z.string().max(500).optional(),
  hook: z.string().max(500).optional(),
  login: z.boolean().optional(),
}).strict();

const JourneySuccessCriterionSchema = z.object({
  description: TEXT,
  check: AssertionSchema.optional(),
}).strict();

const JourneyParameterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  secret: z.boolean().optional(),
}).strict();

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
    requiresAuth: z.boolean().optional(),
    goal: TEXT.optional(),
    persona: z.string().max(500).optional(),
    role: z.string().max(200).optional(),
    preconditions: z.array(JourneyPreconditionSchema).max(50).optional(),
    successCriteria: z.array(JourneySuccessCriterionSchema).max(50).optional(),
    parameters: z
      .array(JourneyParameterSchema)
      .max(100)
      .refine((ps) => new Set(ps.map((p) => p.name)).size === ps.length, { message: "parameters: duplicate name" })
      .optional(),
  }).strict(),
  recording: RecordingSchema,
});
