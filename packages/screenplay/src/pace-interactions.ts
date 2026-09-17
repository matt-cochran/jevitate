import type { InteractionPolicy } from "@doit/domain";
import { Pacer } from "@doit/domain";
import type { Ability, AbilityToken } from "./core.js";

export class PaceInteractions implements Ability {
  readonly kind = "pace-interactions";
  constructor(
    readonly policy: InteractionPolicy,
    readonly pacer: Pacer,
    readonly sleep: (ms: number) => Promise<void>,
  ) {}
}

export const PaceInteractionsToken: AbilityToken<PaceInteractions> = { kind: "pace-interactions" };
