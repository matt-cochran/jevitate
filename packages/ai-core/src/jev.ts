// jev.ts — adapter SHAPE only; live calls gated on TYPESAFE_API_KEY.
import { type JudgmentPort, type JudgmentState, type Question, type Answer } from "./judgment.js";
import { type CredentialStore, requireKeys } from "./credentials.js";
import { assertNoOutboundCredential } from "./credential-guard.js";

export interface JevClientCall {
  (args: { state: JudgmentState; questions: Record<string, Question>; authHeader: string }): Promise<Record<string, Answer>>;
}
export class JevJudgmentGateway implements JudgmentPort {
  constructor(private readonly store: CredentialStore, private readonly call: JevClientCall) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    requireKeys("judgment", this.store);                     // fail-closed
    assertNoOutboundCredential(args, this.store);            // never-to-model choke point (redact-before-model already applied by caller)
    const key = this.store.read("TYPESAFE_API_KEY")!;
    return this.call({ ...args, authHeader: `Bearer ${key}` });
  }
}

// Real seam: `realJevClientCall` (./jev-sdk-adapter.ts) lazily imports
// `@typesafe-ai/sdk`, constructs the client, and calls
// client.systemOne({ state, questions }) mapping Choice/Noul/Score results to
// Answer. Lazy import keeps the package buildable without the SDK; hosts wire it.
