// evidence-file.ts — the usability run's EVIDENCE SIDECAR (#134).
//
// A Recording carries only the controls a run touched and each page's url — no visible text, no
// untouched controls, no requests. So an offline `jevitate ux <recording>` of a live usability run
// Skipped most rubric items and ran no signal oracle, and showed 0 findings where the live run
// showed 2. The live run now writes `<stamp>.evidence.json` next to its Recording: every screen's
// evidence exactly as the analyzer saw it AFTER the redaction door (`redactEvidence`), plus the
// run-signal capture (already redacted by the capture layer) and the run's outcome. Offline review
// re-reads it and reproduces the live findings.
//
// Nothing here holds a secret: screens pass `redactEvidence` (which proves no registered secret
// survives) before they are serialized, the capture stores only redacted urls/text and one-way
// payload digests, and the file is written only after that door.
import { z } from "zod";
import { redactEvidence } from "./redact.js";
import type { JourneyOutcome } from "./friction.js";
import type { RunSignalCapture } from "./signals.js";
import type { AppContext, Control, UxEvidence } from "./types.js";

export const UX_EVIDENCE_FILE_VERSION = 1 as const;

/** One screen as the model saw it (redacted; no durable descriptors). */
export type PersistedScreen = Omit<UxEvidence, "controls"> & { readonly controls: readonly Omit<Control, "descriptor">[] };

export interface UxEvidenceFile {
  readonly version: typeof UX_EVIDENCE_FILE_VERSION;
  readonly appContext: AppContext;
  readonly job?: string;
  readonly screens: readonly PersistedScreen[];
  readonly signals: RunSignalCapture;
  readonly outcome?: JourneyOutcome;
}

export class UxEvidenceFileError extends Error {
  readonly code = "E_UX_EVIDENCE_FILE" as const;
  constructor(message: string) {
    super(message);
    this.name = "UxEvidenceFileError";
  }
}

/** A screen through the redaction door, in the shape that is written to disk. */
export function persistableScreen(evidence: UxEvidence, secrets: readonly string[]): PersistedScreen {
  const r = redactEvidence(evidence, secrets);
  return {
    screenId: r.screenId,
    url: r.url,
    controls: evidence.controls.map((c, i) => ({
      index: c.index,
      role: c.role,
      name: r.controls[i]!.name,
      tag: c.tag,
      inputType: c.inputType,
      enabled: c.enabled,
      summary: r.controls[i]!.summary,
    })),
    visibleText: r.visibleText,
    appContext: r.appContext,
    ...(r.job === undefined ? {} : { job: r.job }),
    history: r.history,
    behavior: r.behavior,
    a11yFacts: r.a11yFacts,
    ...(r.typedValues.length > 0 ? { typedValues: r.typedValues } : {}),
  };
}

const ControlSchema = z.object({
  index: z.number(),
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  inputType: z.string().nullable(),
  enabled: z.boolean(),
  summary: z.string(),
});
const ScreenSchema = z.object({
  screenId: z.string(),
  url: z.string(),
  controls: z.array(ControlSchema),
  visibleText: z.string(),
  appContext: z.object({ appClass: z.string(), persona: z.string().optional(), job: z.string().optional() }),
  job: z.string().optional(),
  history: z.array(z.object({ screenId: z.string(), url: z.string() })),
  behavior: z.object({ noProgress: z.boolean(), backtracks: z.number(), formReentry: z.number(), dwellMs: z.number(), errors: z.number() }),
  a11yFacts: z.object({
    controls: z.array(
      z.object({
        controlRef: z.string(),
        accessibleName: z.string().nullable(),
        focusOrder: z.number().nullable(),
        targetSize: z.object({ width: z.number(), height: z.number() }).nullable(),
        contrastRatio: z.number().nullable(),
      }),
    ),
  }),
  typedValues: z.array(z.string()).optional(),
});
const StepSchema = z.object({
  step: z.number(),
  op: z.string().nullable(),
  target: z.string().nullable(),
  actOk: z.boolean(),
  url: z.string(),
  descriptor: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
  value: z.string().optional(),
  message: z.string().optional(),
  reply: z.string().optional(),
});
const RequestSchema = z.object({
  id: z.number(),
  method: z.string(),
  endpoint: z.string(),
  url: z.string(),
  resourceType: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.number().nullable(),
  failed: z.boolean().optional(),
  step: z.number(),
  payloadKey: z.string().optional(),
});
const SignalScreenSchema = z.object({
  index: z.number(),
  step: z.number(),
  at: z.number(),
  url: z.string(),
  signature: z.string(),
  visibleText: z.string(),
  busy: z.boolean(),
  screenshot: z.string().optional(),
  heading: z.string().optional(),
});
const FileSchema = z.object({
  version: z.literal(UX_EVIDENCE_FILE_VERSION),
  appContext: z.object({ appClass: z.string(), persona: z.string().optional(), job: z.string().optional() }),
  job: z.string().optional(),
  screens: z.array(ScreenSchema),
  signals: z.object({
    steps: z.array(StepSchema),
    requests: z.array(RequestSchema),
    screens: z.array(SignalScreenSchema),
    endedAt: z.number(),
    typedValues: z.array(z.string()).optional(),
  }),
  outcome: z.union([z.object({ status: z.literal("completed") }).passthrough(), z.object({ status: z.literal("incomplete"), reason: z.string() }).passthrough()]).optional(),
});

/** Parses and validates an evidence sidecar; a wrong shape throws `UxEvidenceFileError`, never a silent partial read. */
export function parseUxEvidenceFile(raw: unknown): UxEvidenceFile {
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) throw new UxEvidenceFileError(`not a usability evidence file: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data as unknown as UxEvidenceFile;
}

/**
 * The persisted screens as analyzer input. The offline review's own app context wins field by
 * field (its `--app-class` is required); what it leaves unset (the job, a persona) comes from the
 * live run, so the same screens are judged in the same framing.
 */
export function evidenceFromFile(file: UxEvidenceFile, appContext: AppContext): { screens: UxEvidence[]; appContext: AppContext } {
  const defined = Object.fromEntries(Object.entries(appContext).filter(([, v]) => v !== undefined)) as Partial<AppContext>;
  const ctx: AppContext = { ...file.appContext, ...defined };
  const job = defined.job ?? file.job;
  return { appContext: ctx, screens: file.screens.map((s) => ({ ...s, controls: [...s.controls], appContext: ctx, ...(job === undefined ? {} : { job }) })) };
}
