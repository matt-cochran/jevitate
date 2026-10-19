import { z, type ZodType } from "zod";
import {
  AssertionSchema,
  assertionRefs,
  navigateUrlParams,
  NetworkCheckSchema,
  OutcomeCheckSchema,
  RecordingSchema,
  STEP_ID_RE,
  TargetDescriptorSchema,
  type Assertion,
  type NetworkCheck,
  type OutcomeCheck,
  type Recording,
  type Step,
  type StatusSpec,
  type TargetDescriptor,
} from "@jevitate/recording";
import { MAX_DECLARED_RELAXATIONS, mutationPairIssues, targetedProofPlanIssues } from "./mutation-proof.js";
import { SECRET_PARAM_NAME_RE, secretParamNames } from "./intent.js";
import { ApprovalProposalSchema } from "./proposal-schema.js";
import { ApprovalProvenanceSchema, type ApprovalProvenance } from "./approval-schema.js";
import { anchorRuleIssues } from "./anchor-rules.js";
import { handoffSchemaIssues, JourneyInputsSchema, JourneyOutputsSchema, type HandoffInputsDecl, type HandoffOutputsDecl } from "./handoff.js";

export { ANCHOR_NAME_RE } from "./anchor-rules.js";

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
  /**
   * #542 — the normalized origins the Journey was authored against when that was more than its own
   * site (a split-origin app: UI on one origin, API on another). A replay's allowlist is the union of
   * the recorded site (or the environment's origins), these, and `journey run|verify --allow`; it is
   * what lets `journey verify --mutate` block a step's cross-origin write. Absent when the authoring
   * allowlist was only the site's own origin. Under `--env`/`--base-url` these are NOT remapped.
   */
  allowedOrigins?: string[];
  /**
   * #544: the mission-fixtures file the Journey was authored under (`explore-author-journey
   * --fixtures`) — `file` relative to the repository root (POSIX separators), `specHash` the content
   * hash of the spec. `journey run`/`verify`/`annotate` load it when no `--fixtures` flag is given.
   * Shell hooks (`--before`/`--after`) are never recorded: they need an explicit opt-in per run.
   */
  fixtures?: { file: string; specHash: string };
  /*
   * #246 intent — every field optional and additive: a Journey without them validates and runs
   * exactly as before. Documentation for people, demos and models; nothing here changes a replay.
   */
  /** What the Journey achieves, in one sentence. */
  goal?: string;
  /**
   * Who does it. #433: when it equals a persona id in `.jevitate/personas.json` it LINKS the Journey
   * to that catalog persona (whose approval `journey promote` then requires); otherwise it is the
   * free-text description of a person it always was (a Journey with a `job` must name a catalog persona).
   */
  persona?: string;
  /**
   * #433 — the job (a job story in `.jevitate/jobs.json`, by id) this Journey is how a persona does.
   * `journey promote` requires the linked job and persona to be approved (or a recorded waiver,
   * `--accept-unvetted`). Additive: an unlinked Journey promotes exactly as before.
   */
  job?: string;
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
  /**
   * #402 — declared negative-proof pairs for `journey verify --mutate`: the assertion at `check`
   * (`step:<n>`, `step-request:<n>:<i>`, `end-state:<i>`) must FAIL when the Journey is replayed
   * with `mustFailWhen` (`skip:<n|anchor>`, `block-write:<n|anchor>`, `stale-value:<n|anchor>`).
   * Validated at load: an unknown site, step or anchor is refused. Additive.
   */
  mutationPairs?: JourneyMutationPair[];
  /**
   * #616 — DECLARED targeted-proof plans for `journey verify --mutate`: an assertion the automatic
   * #609 proof cannot reach because more than its bound of earlier defenses catch the mutation first,
   * with the earlier postconditions a human reviewed and allows the proof to relax. Validated at
   * load; the target assertion is never relaxed. Additive.
   */
  targetedProofs?: JourneyTargetedProofPlan[];
  /**
   * #432 — the last human approval (`journey promote`, `demo approve`): the review hash of the
   * Journey that was approved (`journeyReviewHash`: the content hash without the approval
   * bookkeeping — `promoted`, `approval`, `acceptedWeak`), when, and the assertion-strength waiver
   * given at that approval. Additive: a Journey without it validates and runs exactly as before.
   */
  approval?: JourneyApproval;
  /**
   * #465 (optional, additive): the desired outcomes (ids from the linked job's `desiredOutcomes`)
   * this path is meant to move. Unique. Whether each id is one of the job's is a catalog check, not
   * a schema one.
   */
  serves?: string[];
  /**
   * #465 (optional, additive): an open object of tool-specific fields, keyed by a lowercase
   * namespace (`journeeze`, …), carried verbatim. It counts toward the content hash.
   */
  extensions?: Extensions;
  /**
   * #582: the typed handoff this Journey PRODUCES (docs/contracts/journey-handoff.md §2). Optional and
   * additive: a Journey without it validates, hashes and chains exactly as in 0.17.0. Its fields are
   * `extract` outputs of this Journey and its `contract` is the record a consuming Journey accepts.
   */
  outputs?: HandoffOutputsDecl;
  /**
   * #582: the typed handoff this Journey CONSUMES (§3) — the contract it accepts, the caller's request
   * and how both bind to its params. Optional and additive.
   */
  inputs?: HandoffInputsDecl;
  /**
   * #583 — a prepare-only boundary: the Journey prepares a value and stops before the action a
   * person takes (Send). Load-time rules refuse a Journey whose steps would cross it
   * (`E_BOUNDARY_SCHEMA`); a run reports a typed `handback` state (§4 of the contract). Additive.
   */
  boundary?: HandbackBoundary;
}

/**
 * #583 — the control a person uses after a prepare-only handback: declared and shown, never acted
 * on. `blockWrites` aborts every first-party write request during the run (the #402 write guard).
 */
export interface HandbackBoundary {
  kind: "prepare-only";
  stopBefore: { target: TargetDescriptor; label: string };
  /** The exact human next step (1–500 chars), shown wherever the state is shown. */
  nextStep: string;
  /** Optional: `true` aborts every first-party write request during the run. Default `false`. */
  blockWrites?: boolean;
}

/** #465: namespaced tool-specific fields (`{ "<namespace>": … }`), carried verbatim and hashed. */
export type Extensions = Record<string, unknown>;

/** #432: one recorded approval — see `JourneyMetadata.approval`. */
export interface JourneyApproval {
  contentHash: string;
  at: string;
  /**
   * #437: how the approval was made — channel (`tty` | `non-interactive` | `mcp` | `ci` | #469 `pr-review`), the agent
   * marker NAMES detected, the OS user. Absent on approvals recorded before 0.8.0.
   */
  provenance?: ApprovalProvenance;
  acceptedWeak?: { reason: string; rules: string[]; provenance?: ApprovalProvenance };
  /**
   * #433: what the approver waived — `unvetted`: promoted while its linked job/persona was not
   * approved (`--accept-unvetted "<reason>"`), with the links as they stood (`job:<id> (draft)`).
   */
  waivers?: JourneyApprovalWaiver[];
  /** #433: the pre-approval findings that needed an acknowledgment, and the reason (`--accept-findings`). */
  acceptedFindings?: AcceptedFindings;
  /** #453: the self-heal proposal this approval accepted — its id, the hash it was made against, the flat 0-based steps it changed. */
  proposal?: { id: string; baseHash: string; steps: number[] };
}

/** #433: one waiver recorded with an approval — see `JourneyApproval.waivers`. */
export interface JourneyApprovalWaiver {
  kind: "unvetted";
  reason: string;
  items: string[];
  /** #437: how this waiver was confirmed (the approval's provenance). */
  provenance?: ApprovalProvenance;
}

/** #433: pre-approval findings acknowledged at an approval (`--accept-findings "<reason>"`), by `<analyzer>/<code>`. */
export interface AcceptedFindings {
  reason: string;
  findings: string[];
  /** #437: how this acknowledgment was confirmed (the approval's provenance). */
  provenance?: ApprovalProvenance;
}

/** #402: one declared pair — see `JourneyMetadata.mutationPairs`. */
export interface JourneyMutationPair {
  check: string;
  mustFailWhen: string;
}

/** #616: one declared targeted-proof plan — see `JourneyMetadata.targetedProofs`. */
export interface JourneyTargetedProofPlan {
  check: string;
  mustFailWhen: string;
  relax: string[];
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
  /**
   * The state AFTER this many top-level steps — 1-based, counted the way `--at-step <n>` counts.
   * Kept for compatibility (the bundle contract keys `link.anchors[].step` by it); `stepId`, when
   * present, is authoritative.
   */
  step: number;
  /** #467 (optional): the stable id of the step this anchor follows (`RecordedStep.stepId`). Authoritative going forward. */
  stepId?: string;
  /** #465 (optional): the linked job's step (`job.steps[].id`) this anchor marks. */
  jobStep?: string;
  /** #465 (optional): whether the anchor marks the `start` or the `end` of `jobStep` (needs `jobStep`). */
  boundary?: AnchorBoundary;
  /** What this state is, in words. */
  description?: string;
  /**
   * #519 (optional): the page region this state's missions attack - a descriptor in the `--success` syntax
   * (`testId=import-view`, `role=region;name=Import`). `--from-journey --at-step <this anchor>` scopes control
   * coverage to it; a per-run `--scope-region` cannot override it. Part of the reviewed content: changing it
   * stales the approval.
   */
  region?: string;
  /** Suggested adversarial probes at this state (e.g. "double submit", "swap the tenant id"). */
  probes?: string[];
}

/** #465: which edge of a job step an anchor marks. */
export const ANCHOR_BOUNDARIES = ["start", "end"] as const;
export type AnchorBoundary = (typeof ANCHOR_BOUNDARIES)[number];

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
 *
 * #579: `mutationValues` are alternative values a human reviewed as valid but WRONG for this
 * parameter. They are non-secret, are persisted in the Journey file and are never a credential;
 * `journey verify --mutate` may substitute one when proving an assertion on the parameter can fail.
 */
export interface JourneyParameter {
  name: string;
  description?: string;
  secret?: boolean;
  mutationValues?: string[];
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

// #583: the prepare-only boundary — strict, and the only kind. Its section-2 refusals run in the
// Journey's superRefine below (`boundaryRuleIssues`).
const HandbackBoundarySchema = z
  .object({
    kind: z.literal("prepare-only"),
    stopBefore: z
      .object({
        target: TargetDescriptorSchema,
        label: z.string().min(1).max(200),
      })
      .strict(),
    nextStep: z.string().min(1).max(500),
    blockWrites: z.boolean().optional(),
  })
  .strict();

const JourneyParameterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  secret: z.boolean().optional(),
  // #579: reviewed, non-secret alternative values — at most 20 distinct 1..2000-char strings.
  mutationValues: z
    .array(TEXT)
    .min(1)
    .max(20)
    .refine((vs) => new Set(vs).size === vs.length, { message: "mutationValues: duplicate value" })
    .optional(),
}).strict();

/** #465: a catalog id (job, job step, desired outcome) — the catalog's id rule (`CATALOG_ID_RE`). */
const CATALOG_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CatalogRefSchema = z.string().regex(CATALOG_REF_RE, "a catalog id: 1-64 of [A-Za-z0-9._-], starting alphanumeric");

/** #465: an `extensions` namespace — a lowercase slug (`journeeze`). */
export const EXTENSION_NAMESPACE_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** #465: the open, namespaced `extensions` object on a job and on Journey metadata (at most 16 namespaces). */
export const ExtensionsSchema = z
  .record(z.string().regex(EXTENSION_NAMESPACE_RE, "extensions: a namespace is a lowercase slug (a-z, 0-9, -; at most 32)"), z.unknown())
  .refine((e) => Object.keys(e).length <= 16, { message: "extensions: at most 16 namespaces" });

// Name rules (pattern, length, uniqueness, step range) live in `anchorRuleIssues` (anchor-rules.ts),
// run by the Journey's superRefine below.
const JourneyAnchorSchema = z.object({
  name: z.string(),
  step: z.number().int().min(1),
  stepId: z.string().regex(STEP_ID_RE, "anchor stepId: 1-64 of [a-z0-9._:-]").optional(),
  jobStep: CatalogRefSchema.optional(),
  boundary: z.enum(ANCHOR_BOUNDARIES).optional(),
  description: z.string().max(2000).optional(),
  region: z.string().min(1).max(200).optional(),
  probes: z.array(z.string().min(1).max(500)).max(20).optional(),
}).strict()
  .refine((a) => a.boundary === undefined || a.jobStep !== undefined, { message: "anchor boundary: needs a jobStep (the job step it bounds)", path: ["boundary"] });

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

/** #433: an `--accept-findings` acknowledgment, as a Journey's, a persona's or a job's approval records it. */
export const AcceptedFindingsSchema = z
  .object({ reason: z.string().min(1), findings: z.array(z.string()).max(200), provenance: ApprovalProvenanceSchema.optional() })
  .strict();

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
    allowedOrigins: z.array(z.string().max(2048)).max(50).optional(),
    fixtures: z.object({ file: z.string().min(1).max(1024), specHash: z.string().min(1).max(128) }).strict().optional(),
    goal: TEXT.optional(),
    persona: z.string().max(500).optional(),
    role: z.string().max(200).optional(),
    job: z.string().regex(SAFE_ID_RE, "job: a job id from .jevitate/jobs.json").max(64).optional(),
    preconditions: z.array(JourneyPreconditionSchema).max(50).optional(),
    successCriteria: z.array(JourneySuccessCriterionSchema).max(50).optional(),
    parameters: z
      .array(JourneyParameterSchema)
      .max(100)
      .refine((ps) => new Set(ps.map((p) => p.name)).size === ps.length, { message: "parameters: duplicate name" })
      .optional(),
    anchors: z.array(JourneyAnchorSchema).max(50).optional(),
    networkChecks: z.array(JourneyNetworkCheckSchema).max(20).optional(),
    endState: z.array(OutcomeCheckSchema).max(50).optional(),
    acceptedWeak: z
      .object({ reason: z.string().min(1), rules: z.array(z.string()) })
      .strict()
      .optional(),
    mutationPairs: z
      .array(z.object({ check: z.string().min(1).max(100), mustFailWhen: z.string().min(1).max(200) }).strict())
      .max(100)
      .optional(),
    // #616: a declared targeted-proof plan; the relax list is bounded tighter than the automatic proof.
    targetedProofs: z
      .array(
        z
          .object({
            check: z.string().min(1).max(100),
            mustFailWhen: z.string().min(1).max(200),
            relax: z.array(z.string().min(1).max(60)).min(1).max(MAX_DECLARED_RELAXATIONS),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    approval: z
      .object({
        contentHash: z.string().regex(/^[0-9a-f]{64}$/, "approval.contentHash: a sha256 hex digest"),
        at: z.string().min(1),
        provenance: ApprovalProvenanceSchema.optional(),
        acceptedWeak: z.object({ reason: z.string().min(1), rules: z.array(z.string()), provenance: ApprovalProvenanceSchema.optional() }).strict().optional(),
        waivers: z
          .array(z.object({ kind: z.literal("unvetted"), reason: z.string().min(1), items: z.array(z.string()), provenance: ApprovalProvenanceSchema.optional() }).strict())
          .max(20)
          .optional(),
        acceptedFindings: AcceptedFindingsSchema.optional(),
        proposal: ApprovalProposalSchema.optional(),
      })
      .strict()
      .optional(),
    serves: z
      .array(CatalogRefSchema)
      .max(50)
      .refine((ss) => new Set(ss).size === ss.length, { message: "serves: duplicate id" })
      .optional(),
    extensions: ExtensionsSchema.optional(),
    // #582: the optional typed handoff blocks (§2 producing, §3 consuming).
    outputs: JourneyOutputsSchema.optional(),
    inputs: JourneyInputsSchema.optional(),
    boundary: HandbackBoundarySchema.optional(),
  }).strict(),
  recording: RecordingSchema,
}).superRefine((j, ctx) => {
  // #583 §2: a prepare-only boundary may not be crossed by the steps it declares.
  for (const issue of boundaryRuleIssues(j)) ctx.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
  // #293/#466: anchor names, uniqueness and step range (anchor-rules.ts).
  for (const issue of anchorRuleIssues(j)) ctx.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
  // #402: a declared mutation pair must name an assertion and a step (or anchor) the Journey has.
  for (const issue of mutationPairIssues(j)) {
    ctx.addIssue({ code: "custom", path: ["metadata", "mutationPairs", issue.index, issue.field], message: issue.message });
  }
  // #616: a declared targeted-proof plan must name an assertion, a resolvable mutation and relaxable steps.
  for (const issue of targetedProofPlanIssues(j)) {
    ctx.addIssue({ code: "custom", path: ["metadata", "targetedProofs", issue.index, issue.field], message: issue.message });
  }
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
  // #562/#565: an assertion's `${name}` / `{ var }` must name something the run binds when it is checked.
  for (const issue of assertionRefIssues(j as Journey)) ctx.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
  // #582: handoff outputs/inputs load-time refusals (§2-§3), reported as E_HANDOFF_SCHEMA issues.
  for (const issue of handoffSchemaIssues(j as Journey)) ctx.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
  // #579: mutationValues are reviewed, non-secret values — never a credential.
  (j.metadata.parameters ?? []).forEach((p, i) => {
    if (p.mutationValues === undefined) return;
    if (p.secret === true || SECRET_PARAM_NAME_RE.test(p.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["metadata", "parameters", i, "mutationValues"],
        message: `E_MUTATION_VALUES_SECRET: parameter "${p.name}" is a secret (secret: true or a credential-like name) — mutationValues are reviewed, non-secret values and may never carry a credential`,
      });
    }
  });
});

/**
 * #583 §2: the load-time refusals of a prepare-only boundary, each message starting
 * `E_BOUNDARY_SCHEMA` and naming the offending step's path. A Journey with a prepare-only boundary
 * may not: click the `stopBefore` control (top level or a `forEach` child), press Enter/NumpadEnter,
 * click after the last `fill`/`editText`/`select`, or contain a `handback` step.
 */
function boundaryRuleIssues(j: Journey): { path: (string | number)[]; message: string }[] {
  const boundary = j.metadata.boundary;
  if (boundary === undefined) return [];
  const out: { path: (string | number)[]; message: string }[] = [];
  const stop = boundary.stopBefore.target;
  // The flat walk: a `forEach`'s children run at the `forEach`'s own position, so a click after the
  // last prepare step is a click after it however deeply it is nested.
  const entries: { step: Step; path: (string | number)[] }[] = [];
  j.recording.pages.forEach((page, pi) => {
    page.steps.forEach((rs, si) => {
      const base: (string | number)[] = ["recording", "pages", pi, "steps", si, "step"];
      entries.push({ step: rs.step, path: base });
      if (rs.step.kind === "forEach") rs.step.steps.forEach((child, ci) => entries.push({ step: child, path: [...base, "steps", ci] }));
    });
  });
  let lastPrepare = -1;
  entries.forEach((e, i) => {
    if (e.step.kind === "fill" || e.step.kind === "editText" || e.step.kind === "select") lastPrepare = i;
  });
  entries.forEach((e, i) => {
    const where = `${boundaryPathName(e.path)} (step ${i + 1})`;
    if (e.step.kind === "handback") {
      out.push({ path: e.path, message: `E_BOUNDARY_SCHEMA: ${where} is a handback step — a prepare-only boundary IS the handback` });
      return;
    }
    if (e.step.kind === "press" && (e.step.key === "Enter" || e.step.key === "NumpadEnter")) {
      out.push({ path: e.path, message: `E_BOUNDARY_SCHEMA: ${where} presses ${e.step.key} — a prepare-only boundary never submits` });
      return;
    }
    if (e.step.kind !== "click") return;
    if (sameHandbackTarget(e.step.target, stop)) {
      out.push({ path: e.path, message: `E_BOUNDARY_SCHEMA: ${where} clicks the stopBefore target — the boundary control is never acted on` });
      return;
    }
    if (i > lastPrepare) {
      out.push({ path: e.path, message: `E_BOUNDARY_SCHEMA: ${where} clicks after the last fill/editText/select — nothing is clicked once the value is prepared` });
    }
  });
  return out;
}

/** `recording.pages[0].steps[2].step` — how a boundary issue names the offending step. */
function boundaryPathName(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");
}

/**
 * #583: do two descriptors identify the same control? The highest rung present in either decides
 * (testId, then role+name, then label, then text, then css) — so a recorded click on
 * `{ testId, role, name }` still equals the boundary's `{ testId }`, while a different control with
 * its own rung never does.
 */
function sameHandbackTarget(a: TargetDescriptor, b: TargetDescriptor): boolean {
  if (a.testId !== undefined || b.testId !== undefined) return a.testId !== undefined && a.testId === b.testId;
  if (a.role !== undefined || b.role !== undefined) return a.role !== undefined && a.role === b.role && (a.name ?? "") === (b.name ?? "");
  if (a.label !== undefined || b.label !== undefined) return a.label !== undefined && a.label === b.label;
  if (a.text !== undefined || b.text !== undefined) return a.text !== undefined && a.text === b.text && (a.textMatch ?? "") === (b.textMatch ?? "");
  if (a.css !== undefined || b.css !== undefined) return a.css !== undefined && a.css === b.css;
  return false;
}

/** A step's own assertions with their field names (a `forEach`'s children are walked separately). */
/** A step's own assertions (its `check`, `resume` or `expect`), each with the field that holds it. */
export function ownAssertions(step: Step): { field: string; assertion: Assertion }[] {
  if (step.kind === "assert") return [{ field: "check", assertion: step.check }];
  if (step.kind === "handback") return [{ field: "resume", assertion: step.resume }];
  return "expect" in step ? [{ field: "expect", assertion: step.expect }] : [];
}

/**
 * #562/#565: every assertion reference that is not bound where it is checked. A step's expectation
 * may name a declared parameter (`params` / `parameters`), an `extract` output bound by an EARLIER
 * step (or by the step itself, which binds before it checks), or a `setup.x` fixture output; the end
 * state may name a parameter, any step's `extract` output, or `setup.x`. A secret parameter is never
 * allowed: its value would be expanded into model-visible text.
 */
function assertionRefIssues(j: Journey): { path: (string | number)[]; message: string }[] {
  const declared = new Set([...j.metadata.params, ...(j.metadata.parameters ?? []).map((p) => p.name)]);
  const secret = new Set(secretParamNames(j));
  const extracted = new Set<string>();
  const out: { path: (string | number)[]; message: string }[] = [];
  const check = (a: Assertion, path: (string | number)[], where: "step" | "end-state"): void => {
    for (const name of assertionRefs(a)) {
      if (secret.has(name)) {
        out.push({ path, message: `assertion reference \${${name}} names a secret parameter — an assertion's expected text is model-visible and persisted, so it may not use one` });
      } else if (!name.startsWith("setup.") && SECRET_PARAM_NAME_RE.test(name)) {
        // #564: an `extract` output (or undeclared name) that reads as a credential is a secret too.
        out.push({ path, message: `E_ASSERTION_REF_SECRET: assertion reference \${${name}} names a credential-like value — an assertion's expected text is model-visible and persisted, so it may not use one` });
      } else if (!declared.has(name) && !extracted.has(name) && !(name.startsWith("setup.") && name.length > "setup.".length)) {
        out.push({
          path,
          message:
            where === "step"
              ? `assertion reference \${${name}} is not bound here — declare it in metadata.params / metadata.parameters, or extract it in an earlier step`
              : `end-state reference \${${name}} is not bound — declare it in metadata.params / metadata.parameters, or extract it in a step`,
        });
      }
    }
  };
  j.recording.pages.forEach((page, pi) =>
    page.steps.forEach((rs, si) => {
      const base = ["recording", "pages", pi, "steps", si, "step"];
      const step = rs.step;
      if (step.kind === "extract") extracted.add(step.as);
      for (const { field, assertion } of ownAssertions(step)) check(assertion, [...base, field], "step");
      if (step.kind === "forEach") {
        step.steps.forEach((child, ci) => {
          if (child.kind === "extract") extracted.add(child.as);
          for (const { field, assertion } of ownAssertions(child)) check(assertion, [...base, "steps", ci, field], "step");
        });
      }
    }),
  );
  (j.metadata.endState ?? []).forEach((c, i) => {
    if (c.kind === "page" || c.kind === "reloadThen") check(c.assertion, ["metadata", "endState", i, "assertion"], "end-state");
  });
  return out;
}
