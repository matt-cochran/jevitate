export interface Ability {
  readonly kind: string;
}

export interface AbilityToken<T extends Ability> {
  readonly kind: string;
}

export interface Activity {
  readonly description: string;
  performAs(actor: Actor): Promise<void>;
}

export interface Question<T> {
  readonly description: string;
  answeredBy(actor: Actor): Promise<T>;
}

export interface Actor {
  readonly name: string;
  ability<T extends Ability>(token: AbilityToken<T>): T;
  attemptsTo(...activities: Activity[]): Promise<void>;
  asks<T>(question: Question<T>): Promise<T>;
}
