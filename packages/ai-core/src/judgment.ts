// judgment.ts — typed DRIVING decisions (Jev shape: Choice / Noul / Score)
import { FAKE_CALL_USAGE, type UsageSink } from "./usage.js";
export interface ChoiceQuestion<T extends string> {
  kind: "choice";
  options: readonly T[];
  /** Optional human-readable meaning per option (e.g. a control's role/name), shown to the model. */
  descriptions?: Readonly<Partial<Record<T, string>>>;
  /** What the question asks, in plain language. Defaults to the question's name. */
  instructions?: string;
}
/** Boolean-ish judgment. `instructions` is the plain-language question (defaults to the question's name). */
export interface NoulQuestion { kind: "noul"; instructions?: string }
/** 0..1 judgment. `criteria` = [what "low" means, what "high" means] (defaults to the bare labels). */
export interface ScoreQuestion { kind: "score"; instructions?: string; criteria?: readonly [string, string] }
export type Question = ChoiceQuestion<string> | NoulQuestion | ScoreQuestion;

export interface JudgmentState {
  goal: string;
  url: string;
  controls: string[];
  history: string[];
  /** Optional redacted page text (e.g. a UX review judging copy). Callers redact before the model. */
  visibleText?: string;
}
export interface ChoiceAnswer<T extends string> { kind: "choice"; value: T; confidence: number }
export interface NoulAnswer { kind: "noul"; value: boolean; probability: number }
export interface ScoreAnswer { kind: "score"; value: number }
export type Answer = ChoiceAnswer<string> | NoulAnswer | ScoreAnswer;

export interface JudgmentPort {
  systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>>;
}

/**
 * Deterministic fake — scripted answers; used by ALL CI tests, no key. `usage` is optional (#100):
 * when supplied, every call reports 1 judgment at 0 tokens — so a test can assert usage counting
 * end-to-end without a real Jev call.
 */
export class FakeJudgmentGateway implements JudgmentPort {
  constructor(
    private readonly scripted: Record<string, Answer>,
    private readonly usage?: UsageSink,
  ) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const out: Record<string, Answer> = {};
    for (const name of Object.keys(args.questions)) {
      const a = this.scripted[name];
      if (!a) throw new Error(`no scripted answer for question '${name}'`);
      out[name] = a;
    }
    this.usage?.recordJudgment(FAKE_CALL_USAGE);
    return out;
  }
}
