import type { Ability, AbilityToken, Activity, Actor, Question } from "./core.js";
import { PaceInteractionsToken } from "./pace-interactions.js";

export class MissingAbilityError extends Error {
  constructor(kind: string) {
    super(`Actor lacks ability: ${kind}`);
    this.name = "MissingAbilityError";
  }
}

/**
 * Looks up an ability on the actor, returning `undefined` instead of
 * throwing when the actor doesn't have it. Shared between here (pacing
 * between activities) and interactions.ts (paced typing).
 */
export function tryAbility<T extends Ability>(actor: Actor, token: AbilityToken<T>): T | undefined {
  try {
    return actor.ability(token);
  } catch (err) {
    if (err instanceof MissingAbilityError) return undefined;
    throw err;
  }
}

export class CastActor implements Actor {
  private readonly abilities = new Map<string, Ability>();

  private constructor(readonly name: string) {}

  static named(name: string): CastActor {
    return new CastActor(name);
  }

  whoCan(...abilities: Ability[]): this {
    for (const a of abilities) this.abilities.set(a.kind, a);
    return this;
  }

  ability<T extends Ability>(token: AbilityToken<T>): T {
    const found = this.abilities.get(token.kind);
    if (!found) throw new MissingAbilityError(token.kind);
    return found as T;
  }

  async attemptsTo(...activities: Activity[]): Promise<void> {
    const pace = tryAbility(this, PaceInteractionsToken);
    for (let i = 0; i < activities.length; i++) {
      if (i > 0 && pace) await pace.sleep(pace.pacer.interInteraction(pace.policy));
      await activities[i].performAs(this);
    }
  }

  asks<T>(question: Question<T>): Promise<T> {
    return question.answeredBy(this);
  }
}
