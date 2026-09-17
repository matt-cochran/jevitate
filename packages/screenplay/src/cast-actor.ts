import type { Ability, AbilityToken, Activity, Actor, Question } from "./core.js";

export class MissingAbilityError extends Error {
  constructor(kind: string) {
    super(`Actor lacks ability: ${kind}`);
    this.name = "MissingAbilityError";
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
    for (const activity of activities) await activity.performAs(this);
  }

  asks<T>(question: Question<T>): Promise<T> {
    return question.answeredBy(this);
  }
}
