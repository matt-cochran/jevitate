// judgment.ts — typed DRIVING decisions (Jev shape: Choice / Noul / Score)
export interface ChoiceQuestion<T extends string> {
  kind: "choice";
  options: readonly T[];
  /** Optional human-readable meaning per option (e.g. a control's role/name), shown to the model. */
  descriptions?: Readonly<Partial<Record<T, string>>>;
  /** What the question asks, in plain language. Defaults to the question's name. */
  instructions?: string;
}
export interface NoulQuestion { kind: "noul" }          // boolean-ish judgment
export interface ScoreQuestion { kind: "score" }         // 0..1
export type Question = ChoiceQuestion<string> | NoulQuestion | ScoreQuestion;

export interface JudgmentState { goal: string; url: string; controls: string[]; history: string[] }
export interface ChoiceAnswer<T extends string> { kind: "choice"; value: T; confidence: number }
export interface NoulAnswer { kind: "noul"; value: boolean; probability: number }
export interface ScoreAnswer { kind: "score"; value: number }
export type Answer = ChoiceAnswer<string> | NoulAnswer | ScoreAnswer;

export interface JudgmentPort {
  systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>>;
}

/** Deterministic fake — scripted answers; used by ALL CI tests, no key. */
export class FakeJudgmentGateway implements JudgmentPort {
  constructor(private readonly scripted: Record<string, Answer>) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const out: Record<string, Answer> = {};
    for (const name of Object.keys(args.questions)) {
      const a = this.scripted[name];
      if (!a) throw new Error(`no scripted answer for question '${name}'`);
      out[name] = a;
    }
    return out;
  }
}
