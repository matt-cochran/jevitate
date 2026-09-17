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
}

export type RedactedValue =
  | { redacted: true; length: number }
  | { redacted: false; value: string };

export type ValueOrVar = RedactedValue | { var: string };

export type Assertion =
  | { kind: "visible"; target: TargetDescriptor }
  | { kind: "urlIncludes"; text: string }
  | { kind: "textIncludes"; target: TargetDescriptor; text: string }
  | { kind: "count"; target: TargetDescriptor; min?: number; max?: number };

export type Step =
  | { kind: "navigate"; label?: string; url: string; expect: Assertion }
  | { kind: "click"; label?: string; target: TargetDescriptor; expect: Assertion }
  | { kind: "fill"; label?: string; target: TargetDescriptor; value: ValueOrVar; expect: Assertion }
  | { kind: "waitFor"; label?: string; target: TargetDescriptor; state: "visible" | "hidden" | "attached" }
  | { kind: "extract"; label?: string; target: TargetDescriptor; as: string; attr?: string; expect: Assertion }
  | { kind: "forEach"; label?: string; items: TargetDescriptor; as: string; steps: Step[] }
  | { kind: "assert"; label?: string; check: Assertion }
  | { kind: "handback"; label?: string; prompt: string; resume: Assertion; timeoutMs?: number };

export interface StepTiming {
  atMs: number;
  durationMs: number;
  gapBeforeMs: number;
}

export interface RecordedStep {
  step: Step;
  timing?: StepTiming;
  marker?: "narration" | "checkpoint";
  variableName?: string;
  enumerationId?: string;
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

const TargetDescriptorSchema = z.object({
  testId: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
  frameUrl: z.string().optional(),
});

const RedactedValueSchema = z.discriminatedUnion("redacted", [
  z.object({ redacted: z.literal(true), length: z.number() }).strict(),
  z.object({ redacted: z.literal(false), value: z.string() }).strict(),
]);

const ValueOrVarSchema = z.union([
  RedactedValueSchema,
  z.object({ var: z.string() }).strict(),
]);

const AssertionSchema: z.ZodType<Assertion> = z.discriminatedUnion("kind", [
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
]);

// Forward declaration for recursive Step schema
const StepSchema: z.ZodType<Step> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("navigate"),
      label: z.string().optional(),
      url: z.string(),
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

const StepTimingSchema = z.object({
  atMs: z.number(),
  durationMs: z.number(),
  gapBeforeMs: z.number(),
});

const RecordedStepSchema = z.object({
  step: StepSchema,
  timing: StepTimingSchema.optional(),
  marker: z.enum(["narration", "checkpoint"]).optional(),
  variableName: z.string().optional(),
  enumerationId: z.string().optional(),
});

const PageSegmentSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  steps: z.array(RecordedStepSchema),
});

export const RecordingSchema: ZodType<Recording> = z.object({
  version: z.string(),
  site: z.string(),
  startedAtIso: z.string().optional(),
  intent: z.string().optional(),
  retro: z.string().optional(),
  pages: z.array(PageSegmentSchema),
});
