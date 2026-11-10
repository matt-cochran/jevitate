// write-sentinel.ts — Jev's shadow-mode write sentinel (#794). Advisory only: it returns
// judgments for people to read, never blocks or decides, and never throws.

/** Structurally identical to `AdvisoryJudgment` in `@jevitate/adjudicator` (runtime does not depend on it). */
export interface SentinelJudgment {
  advisory: true;
  task: string;
  step?: number;
  probability: number;
  threshold?: number;
}

/** Structural subset of `JudgmentPort` from `@jevitate/ai-core` (not a runtime dependency). */
export interface SentinelGateway {
  systemOne(args: {
    state: { goal: string; url: string; controls: string[]; history: string[]; visibleText?: string };
    questions: Record<string, { kind: "noul"; instructions?: string }>;
  }): Promise<Record<string, { kind: string; probability?: number }>>;
}

/**
 * Structure only (owner decision, #794): the control's role and name, the HTTP method, the path shape and
 * the job's id and title. There is no field for page text or a page summary, so none can be passed.
 */
export interface SentinelInput {
  control: { role: string; name: string };
  method: string;
  pathShape: string;
  job: { id: string; title: string };
}

export interface SentinelResult {
  judgments: SentinelJudgment[];
  /** Code-templated note; `jev-unavailable` when Jev could not answer. */
  note?: string;
}

export const SENTINEL_TASKS = ["write.destructive", "write.outside-intent"] as const;
export const SENTINEL_NOTE_UNAVAILABLE = "jev-unavailable";

const QUESTIONS = {
  "write.destructive": {
    kind: "noul" as const,
    // GAPS 17: about the control's effect, not the job (x-sentinel-measure ablation: P 1.00 / R 0.75 at 0.5).
    instructions: "Does clicking this control delete, erase, overwrite, revoke or cancel saved data or access?",
  },
  "write.outside-intent": {
    kind: "noul" as const,
    instructions: "Is this pending write outside what the job intends the user to do?",
  },
};

export class WriteSentinel {
  /** `redact` is the redaction guard (value-based masking of declared secrets), applied to every outbound string. */
  constructor(
    private readonly gateway: SentinelGateway,
    private readonly redact: (text: string) => string,
  ) {}

  async judge(input: SentinelInput): Promise<SentinelResult> {
    try {
      const r = this.redact;
      const answers = await this.gateway.systemOne({
        state: {
          goal: r(`${input.job.id}: ${input.job.title}`),
          url: r(input.pathShape),
          controls: [r(`${input.method} ${input.control.role} "${input.control.name}"`)],
          history: [],
        },
        questions: QUESTIONS,
      });
      const judgments: SentinelJudgment[] = [];
      for (const task of SENTINEL_TASKS) {
        const a = answers[task];
        if (a && a.kind === "noul" && typeof a.probability === "number" && a.probability >= 0 && a.probability <= 1) {
          judgments.push({ advisory: true, task, probability: a.probability });
        }
      }
      return judgments.length > 0 ? { judgments } : { judgments: [], note: SENTINEL_NOTE_UNAVAILABLE };
    } catch {
      return { judgments: [], note: SENTINEL_NOTE_UNAVAILABLE };
    }
  }
}
