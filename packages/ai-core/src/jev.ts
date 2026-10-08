// jev.ts — adapter SHAPE only; live calls gated on a Jev key (TYPESAFE_API_KEY or, #429, OPENROUTER_API_KEY).
import { type JudgmentPort, type JudgmentState, type Question, type Answer } from "./judgment.js";
import { type CredentialStore, type JevProvider, resolveJevRoute } from "./credentials.js";
import { assertNoOutboundCredential } from "./credential-guard.js";

export interface JevClientCall {
  /** `provider` (#429): which Jev route `authHeader`'s key belongs to — absent means `typesafe`. */
  (args: { state: JudgmentState; questions: Record<string, Question>; authHeader: string; provider?: JevProvider }): Promise<Record<string, Answer>>;
}
export class JevJudgmentGateway implements JudgmentPort {
  /** `provider` pins the Jev route (`--jev-provider` / `JEVITATE_JEV_PROVIDER`); absent: TypeSafe key first, then OpenRouter. */
  constructor(private readonly store: CredentialStore, private readonly call: JevClientCall, private readonly provider?: JevProvider) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const route = resolveJevRoute(this.store, this.provider); // fail-closed
    assertNoOutboundCredential(args, this.store);            // never-to-model choke point (redact-before-model already applied by caller)
    const key = this.store.read(route.key)!;
    return this.call({ ...args, authHeader: `Bearer ${key}`, provider: route.provider });
  }
}

// Real seam: `realJevClientCall` (./jev-sdk-adapter.ts) lazily imports
// `@typesafe-ai/sdk`, constructs the client, and calls
// client.systemOne({ state, questions }) mapping Choice/Noul/Score results to
// Answer. Lazy import keeps the package buildable without the SDK; hosts wire it.
