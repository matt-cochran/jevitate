/**
 * Shared browser/test helpers for @jevitate/explore's Playwright-backed tests.
 * NOT part of the built package (excluded in tsconfig): it depends on
 * `@jevitate/example-site` (a devDependency) and is only ever imported from
 * `*.test.ts`. Vitest resolves it directly via the source alias.
 */
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import type { Op } from "./actions.js";

const port = new PlaywrightBrowserPort();

/**
 * Opens a fresh persistent context (its own profile dir → no shared state),
 * runs `body`, and always tears down. `baseUrl` defaults to a harmless
 * loopback origin so `setContent`-only tests need no server.
 */
export async function withSession<T>(
  prefix: string,
  body: (session: BrowserSession) => Promise<T>,
  baseUrl = "http://127.0.0.1:1/",
): Promise<T> {
  const session = await port.open({
    headless: true,
    allowedOrigins: [baseUrl],
    baseUrl,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

/** A minimal static login-ish DOM for snapshot/act/decide fixtures. */
export const LOGIN_FIXTURE_HTML = `<!doctype html><html><body>
  <h1>Sign in</h1>
  <form>
    <label>Username <input name="username" aria-label="Username" /></label>
    <label>Password <input name="password" type="password" aria-label="Password" /></label>
    <button type="submit">Sign in</button>
  </form>
  <a href="/help">Need help?</a>
</body></html>`;

/** A different DOM, to prove the freshness signature changes across states. */
export const INBOX_FIXTURE_HTML = `<!doctype html><html><body>
  <h1>Inbox</h1>
  <ul><li><a href="/thread/1">First thread</a></li></ul>
  <button type="button">Compose</button>
</body></html>`;

/** One scripted decision: an op and, for a target op, the control index it acts on. */
export interface ScriptedStep {
  readonly op: Op;
  readonly target?: string;
  readonly confidence?: number;
  /** This decision's answer to the advisory "goal already met?" head (#91); unanswered when absent. */
  readonly goalMet?: number;
}

/** The candidate-action id decide() offers for a scripted step: `<op>:<index>` or a bare op. */
export function actionId(step: ScriptedStep): string {
  return step.target !== undefined ? `${step.op}:${step.target}` : step.op;
}

/**
 * A JudgmentPort that plays a fixed sequence of decisions in decide()'s candidate-action format
 * (`{ action: choice("<op>:<index>" | "<op>") }`), repeating the last step once exhausted. Every
 * call's arguments are kept for payload assertions.
 */
export class ScriptedJudge implements JudgmentPort {
  #i = 0;
  readonly calls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  /** Every goal-completion (noul-only) call, for payload assertions. */
  readonly goalCalls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  constructor(private readonly seq: readonly ScriptedStep[]) {
    if (seq.length === 0) throw new Error("ScriptedJudge needs at least one step");
  }
  /** The (redacted) state shown on each call. */
  get states(): JudgmentState[] {
    return this.calls.map((c) => c.state);
  }
  /** The candidate action ids offered on each call. */
  get actionOptions(): Array<readonly string[]> {
    return this.calls.map((c) => {
      const q = c.questions.action;
      return q?.kind === "choice" ? q.options : [];
    });
  }
  /**
   * The answer to every noul question (the goal-completion check a proposed `done` triggers):
   * P(yes). Default 0.9 — a scripted `done` is grounded unless a test says otherwise.
   */
  goalMetProbability = 0.9;
  /** Per-question overrides of `goalMetProbability`, by noul question name (e.g. the #188 sign-in scope head). */
  noulProbabilities: Record<string, number> = {};
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    if (!("action" in args.questions)) {
      this.goalCalls.push(args);
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(args.questions)) {
        const p = this.noulProbabilities[name] ?? this.goalMetProbability;
        if (q.kind === "noul") out[name] = { kind: "noul", value: p >= 0.5, probability: p };
      }
      return out;
    }
    this.calls.push(args);
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)];
    this.#i += 1;
    if (cur === undefined) throw new Error("ScriptedJudge: no step");
    const action: Answer = { kind: "choice", value: actionId(cur), confidence: cur.confidence ?? 0.9 };
    if (cur.goalMet === undefined) return { action };
    return { action, goalAlreadyMet: { kind: "noul", value: cur.goalMet >= 0.5, probability: cur.goalMet } };
  }
}
