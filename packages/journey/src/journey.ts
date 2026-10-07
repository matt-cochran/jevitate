import { z, type ZodType } from "zod";
import {
  AssertionSchema,
  navigateUrlParams,
  NetworkCheckSchema,
  OutcomeCheckSchema,
  RecordingSchema,
  type Assertion,
  type NetworkCheck,
  type OutcomeCheck,
  type Recording,
  type StatusSpec,
} from "@jevitate/recording";

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
  /**
   * #293 — named states worth exploring from. `jevitate explore --from-journey <id> --at-step <name>`
   * replays the Journey up to the anchor's step in one browser context and hands the live page to a
   * mission. Additive: a Journey without anchors validates and runs exactly as before, and nothing
   * here changes a replay.
   */
  anchors?: JourneyAnchor[];
  /**
   * #322 — network checks the replay must satisfy, evaluated over the requests the replay itself
   * sent, after its last step (a state-changing job often has no stable on-page text: the request
   * is its only honest success signal). Authored from `explore-author-journey --success
   * requestMade:…|responseStatus:…`. Additive: a Journey without them runs exactly as before.
   */
  networkChecks?: JourneyNetworkCheck[];
  /**
   * #400 — the Journey's END-STATE assertions: the goal's success checks that held when it was
   * authored (`explore-author-journey --success …`), every kind a goal run takes — `page`
   * (`textIncludes`, `valueEquals`, `count`, `attr`, `flashed`, …), `reloadThen` (persistence),
   * `requestMade`, `responseStatus`. `journey run` evaluates them after the last step with the goal
   * run's own evaluator: page checks on the final page, then ONE reload for the `reloadThen` checks,
   * and network checks over the requests the replay sent. Supersedes `networkChecks` for new
   * Journeys (an old Journey's `networkChecks` still run; see `journeyEndState`). Additive.
   */
  endState?: OutcomeCheck[];
  /**
   * #401 — a weak Journey a reviewer explicitly accepted at `journey promote`: the reason they gave
   * and the assertion-strength rules they waived. Additive: a Journey without it validates and runs
   * exactly as before.
   */
  acceptedWeak?: { reason: string; rules: string[] };
}

/** #322: an expected HTTP status — a class (`2xx`) or an exact code (`201`). */
export type JourneyStatusSpec = StatusSpec;

/** #322: a network check a Journey's replay must satisfy (the `requestMade`/`responseStatus` success checks). */
export type JourneyNetworkCheck = NetworkCheck;

/**
 * A Journey anchor (#293): the state reached after `step` top-level steps, by name, with the
 * adversarial probes worth trying there (text for people and missions; never executed as code).
 */
export interface JourneyAnchor {
  /** Its name (`--at-step <name>`): a safe word, never all digits (a number names a step). */
  name: string;
  /** The state AFTER this many top-level steps — 1-based, counted the way `--at-step <n>` counts. */
  step: number;
  /** What this state is, in words. */
  description?: string;
  /** Suggested adversarial probes at this state (e.g. "double submit", "swap the tenant id"). */
  probes?: string[];
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

/** An anchor name: a safe word that is never all digits (`--at-step 3` is a step number). */
export const ANCHOR_NAME_RE = /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

const JourneyAnchorSchema = z.object({
  name: z.string().max(100).regex(ANCHOR_NAME_RE, "anchor name: letters, digits, . _ - (not all digits)"),
  step: z.number().int().min(1),
  description: z.string().max(2000).optional(),
  probes: z.array(z.string().min(1).max(500)).max(20).optional(),
}).strict();

const JourneyNetworkCheckSchema = NetworkCheckSchema;

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
    anchors: z
      .array(JourneyAnchorSchema)
      .max(50)
      .refine((as) => new Set(as.map((a) => a.name)).size === as.length, { message: "anchors: duplicate name" })
      .optional(),
    networkChecks: z.array(JourneyNetworkCheckSchema).max(20).optional(),
    endState: z.array(OutcomeCheckSchema).max(50).optional(),
    acceptedWeak: z
      .object({ reason: z.string().min(1), rules: z.array(z.string()) })
      .strict()
      .optional(),
  }).strict(),
  recording: RecordingSchema,
}).superRefine((j, ctx) => {
  // #293: an anchor names a state the Journey reaches — its step must be one of the Journey's own.
  const steps = j.recording.pages.reduce((n, p) => n + p.steps.length, 0);
  (j.metadata.anchors ?? []).forEach((a, i) => {
    if (a.step > steps) {
      ctx.addIssue({
        code: "custom",
        path: ["metadata", "anchors", i, "step"],
        message: `anchor ${JSON.stringify(a.name)}: step ${a.step} is past the Journey's last step (${steps})`,
      });
    }
  });
  // #399: a `${name}` in a navigate URL must name a declared parameter (`params` or `parameters`).
  const declared = new Set([...j.metadata.params, ...(j.metadata.parameters ?? []).map((p) => p.name)]);
  j.recording.pages.forEach((page, pi) =>
    page.steps.forEach((rs, si) => {
      if (rs.step.kind !== "navigate") return;
      for (const name of navigateUrlParams(rs.step.url)) {
        if (declared.has(name)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["recording", "pages", pi, "steps", si, "step", "url"],
          message: `navigate placeholder \${${name}} is not a declared parameter — add it to metadata.parameters (secret: true for a token)`,
        });
      }
    }),
  );
});
