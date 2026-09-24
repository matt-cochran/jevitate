import { z, ZodType } from "zod";

// === Interfaces - TypeScript types matching the brief exactly ===

export interface TargetDescriptor {
  testId?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  css?: string;
  frameUrl?: string;
  /**
   * 0-based index of the acted element among the siblings that share the
   * same higher-priority selector (the testId/role+name/label/text rung that
   * didn't uniquely resolve). Only meaningful alongside another rung — never
   * set on its own — and only ever populated when uniqueness genuinely
   * failed, so a descriptor's absence of `ordinal` still means "this
   * selector alone was unique."
   */
  ordinal?: number;
  /**
   * A descriptor for the nearest stable ancestor of the target, used by
   * self-healing to re-anchor a broken selector within the right region of
   * the page rather than the whole document. Recursive: a container may
   * itself carry `ordinal`/`container`.
   */
  container?: TargetDescriptor;
  /**
   * How many elements matched the rung when `ordinal` was recorded. At replay a different count
   * means the page changed around the target: the step fails as `ambiguous` instead of clicking
   * whichever element now sits at that index. Absent on older recordings (then `ordinal` alone).
   */
  candidates?: number;
  /**
   * A stable attribute anchor captured at record time (a document-unique, non-generated `id` or
   * `name` attribute that resolved to the very element acted on). Replay prefers it; when it no
   * longer resolves to exactly one element, replay falls back to the rung (exact name + nth).
   * Identifiers only — never a field's value.
   */
  anchor?: { id?: string; name?: string };
}

export type RedactedValue =
  | { redacted: true; length: number }
  | { redacted: false; value: string };

export type ValueOrVar = RedactedValue | { var: string };

export type Assertion =
  | { kind: "visible"; target: TargetDescriptor }
  | { kind: "urlIncludes"; text: string }
  | { kind: "textIncludes"; target: TargetDescriptor; text: string }
  | { kind: "count"; target: TargetDescriptor; min?: number; max?: number }
  /** A form control's current VALUE (input, textarea, select) equals `value` exactly — never its text content. */
  | { kind: "valueEquals"; target: TargetDescriptor; value: string };

export type Step =
  | { kind: "navigate"; label?: string; url: string; expect: Assertion }
  | { kind: "click"; label?: string; target: TargetDescriptor; expect: Assertion }
  | { kind: "fill"; label?: string; target: TargetDescriptor; value: ValueOrVar; expect: Assertion }
  | { kind: "waitFor"; label?: string; target: TargetDescriptor; state: "visible" | "hidden" | "attached" }
  | { kind: "extract"; label?: string; target: TargetDescriptor; as: string; attr?: string; expect: Assertion }
  | { kind: "select"; label?: string; target: TargetDescriptor; value: ValueOrVar; expect: Assertion }
  /**
   * Attach a local file to an `<input type=file>`. `file` is the fixture's
   * path as a `ValueOrVar` (same discipline as `fill.value`): a plain path
   * replays by re-attaching that same file; a `{ var }` binds a different one;
   * a `{ redacted:true }` path (it contained a registered secret) cannot be
   * replayed and fails closed.
   */
  | { kind: "upload"; label?: string; target: TargetDescriptor; file: ValueOrVar; expect: Assertion }
  | { kind: "press"; label?: string; key: string; expect: Assertion }
  | { kind: "forEach"; label?: string; items: TargetDescriptor; as: string; steps: Step[] }
  | { kind: "assert"; label?: string; check: Assertion }
  | { kind: "handback"; label?: string; prompt: string; resume: Assertion; timeoutMs?: number };

/**
 * How the page reached the state after a step — a MEASUREMENT recorded alongside the step (never a
 * postcondition, never replayed): navigation timing for a new document, action-to-settled time for
 * an in-place transition, and the page's network in that window (URLs redacted + normalized).
 */
export interface PageTimingRecord {
  route: string;
  kind: "navigation" | "transition" | "idle";
  navigation?: { ttfbMs: number; domContentLoadedMs: number; loadMs: number | null };
  settleMs?: number;
  settled: boolean;
  requests: {
    count: number;
    pending: number;
    slowest: Array<{ endpoint: string; url: string; status: number | null; durationMs: number }>;
  };
  lcpMs?: number;
}

export interface StepTiming {
  atMs: number;
  durationMs: number;
  gapBeforeMs: number;
  /** The page timing observed after this step (optional; measurement only). */
  page?: PageTimingRecord;
}

export interface RecordedStep {
  step: Step;
  timing?: StepTiming;
  marker?: "narration" | "checkpoint";
  variableName?: string;
  enumerationId?: string;
  /**
   * Postdoc (RxD Phase A.3b Task 5) chunk-grouping tag: a human-assigned
   * name for the higher-level Screenplay Task/Action this step belongs to
   * (design spec §6a "combine/merge consecutive low-level steps into a
   * named higher-level chunk"). Purely a metadata annotation at this stage
   * — it does not restructure/merge the `pages`/`steps` arrays; consumers
   * (the postdoc TUI, later chunk-aware tooling) group steps that share a
   * `chunk` value. Same RecordedStep-level-tag pattern as `variableName`/
   * `enumerationId` above.
   */
  chunk?: string;
}

export interface PageSegment {
  url: string;
  title?: string;
  steps: RecordedStep[];
}

export interface Recording {
  version: string;
  site: string;
  startedAtIso?: string;
  intent?: string;
  retro?: string;
  pages: PageSegment[];
}

// === Zod Schemas ===

/**
 * `.strict()` rejects unknown/typo'd keys (e.g. `{testid: "send"}` — lowercase
 * `d` — would otherwise silently parse as `{}` instead of being caught at
 * authoring time). The `.refine()` requires at least one of `testId`, `role`,
 * `label`, `text`, `css` to be a non-empty truthy value, so a fully-empty (or
 * `frameUrl`-only) descriptor — which has no usable selector at all — fails
 * validation instead of only failing much later at interpreter runtime.
 *
 * Deliberately NOT required here: `role`+`name` pairing. A descriptor with
 * `role` set but no `name` is still schema-valid (this refine is satisfied by
 * `role` alone) — it just won't hit the role+name ladder rung at resolution
 * time and falls through to lower rungs. That pairing rule lives in the
 * interpreter's selector-ladder fallthrough logic, not the schema.
 *
 * `ordinal` and `container` are both optional and additive: neither counts
 * toward the refine's "has a usable selector" check, so `{ordinal: 0}` alone
 * still fails (an ordinal with nothing to index into is meaningless) and a
 * closed-schema recording from before these fields existed still parses
 * unchanged. `container` is declared with `z.lazy(...)` because it is itself
 * a `TargetDescriptor` — the same recursive-schema pattern `StepSchema` uses
 * for `forEach.steps` below — which is also why this const now carries an
 * explicit `z.ZodType<TargetDescriptor>` annotation: a lazy reference to
 * `TargetDescriptorSchema` from inside its own definition needs the binding
 * to already have a declared type to close over.
 */
export const TargetDescriptorSchema: z.ZodType<TargetDescriptor> = z
  .object({
    testId: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    css: z.string().optional(),
    frameUrl: z.string().optional(),
    ordinal: z.number().int().nonnegative().optional(),
    candidates: z.number().int().positive().optional(),
    anchor: z.object({ id: z.string().optional(), name: z.string().optional() }).strict().optional(),
    container: z.lazy(() => TargetDescriptorSchema).optional(),
  })
  .strict()
  .refine(
    (d) => Boolean(d.testId || d.role || d.label || d.text || d.css),
    {
      message:
        "TargetDescriptor must set at least one of testId, role, label, text, or css",
    },
  );

const RedactedValueSchema = z.discriminatedUnion("redacted", [
  z.object({ redacted: z.literal(true), length: z.number() }).strict(),
  z.object({ redacted: z.literal(false), value: z.string() }).strict(),
]);

const ValueOrVarSchema = z.union([
  RedactedValueSchema,
  z.object({ var: z.string() }).strict(),
]);

export const AssertionSchema: z.ZodType<Assertion> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("visible"),
      target: TargetDescriptorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("urlIncludes"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("textIncludes"),
      target: TargetDescriptorSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("count"),
      target: TargetDescriptorSchema,
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("valueEquals"),
      target: TargetDescriptorSchema,
      value: z.string(),
    })
    .strict(),
]);

/**
 * `navigate.url` must be either a relative path (starting with `/`) or an
 * absolute `http://`/`https://` URL — never a dangerous scheme like
 * `javascript:`/`data:`/`file:`, and never a bare string with no leading
 * `/` (which would be ambiguous/unactionable navigation intent). This is
 * the schema-level half of the design's "no undeclared origins" closed-
 * schema guardrail; actual origin/allowlist enforcement against the site's
 * declared origin happens at the browser-port level (pre-existing, tracked
 * separately as TODO(M3) — not addressed here).
 */
const SAFE_NAVIGATE_URL = /^(\/|https?:\/\/)/;

const NavigateUrlSchema = z
  .string()
  .refine((url) => SAFE_NAVIGATE_URL.test(url), {
    message: "navigate.url must be a relative path starting with '/' or an absolute http(s):// URL",
  });

// Forward declaration for recursive Step schema
const StepSchema: z.ZodType<Step> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("navigate"),
      label: z.string().optional(),
      url: NavigateUrlSchema,
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("click"),
      label: z.string().optional(),
      target: TargetDescriptorSchema,
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      label: z.string().optional(),
      target: TargetDescriptorSchema,
      value: ValueOrVarSchema,
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("waitFor"),
      label: z.string().optional(),
      target: TargetDescriptorSchema,
      state: z.enum(["visible", "hidden", "attached"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extract"),
      label: z.string().optional(),
      target: TargetDescriptorSchema,
      as: z.string(),
      attr: z.string().optional(),
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("select"),
      label: z.string().optional(),
      target: TargetDescriptorSchema,
      value: ValueOrVarSchema,
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("upload"),
      label: z.string().optional(),
      target: TargetDescriptorSchema,
      file: ValueOrVarSchema,
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("press"),
      label: z.string().optional(),
      key: z.string(),
      expect: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("forEach"),
      label: z.string().optional(),
      items: TargetDescriptorSchema,
      as: z.string(),
      steps: z.lazy(() => z.array(StepSchema)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assert"),
      label: z.string().optional(),
      check: AssertionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("handback"),
      label: z.string().optional(),
      prompt: z.string(),
      resume: AssertionSchema,
      timeoutMs: z.number().optional(),
    })
    .strict(),
]);

const PageTimingRecordSchema = z
  .object({
    route: z.string(),
    kind: z.enum(["navigation", "transition", "idle"]),
    navigation: z
      .object({ ttfbMs: z.number(), domContentLoadedMs: z.number(), loadMs: z.number().nullable() })
      .strict()
      .optional(),
    settleMs: z.number().optional(),
    settled: z.boolean(),
    requests: z
      .object({
        count: z.number(),
        pending: z.number(),
        slowest: z.array(
          z
            .object({ endpoint: z.string(), url: z.string(), status: z.number().nullable(), durationMs: z.number() })
            .strict(),
        ),
      })
      .strict(),
    lcpMs: z.number().optional(),
  })
  .strict();

const StepTimingSchema = z
  .object({
    atMs: z.number(),
    durationMs: z.number(),
    gapBeforeMs: z.number(),
    page: PageTimingRecordSchema.optional(),
  })
  .strict();

const RecordedStepSchema = z
  .object({
    step: StepSchema,
    timing: StepTimingSchema.optional(),
    marker: z.enum(["narration", "checkpoint"]).optional(),
    variableName: z.string().optional(),
    enumerationId: z.string().optional(),
    chunk: z.string().optional(),
  })
  .strict();

const PageSegmentSchema = z
  .object({
    url: z.string(),
    title: z.string().optional(),
    steps: z.array(RecordedStepSchema),
  })
  .strict();

export const RecordingSchema: ZodType<Recording> = z.object({
  version: z.string(),
  site: z.string(),
  startedAtIso: z.string().optional(),
  intent: z.string().optional(),
  retro: z.string().optional(),
  pages: z.array(PageSegmentSchema),
});
