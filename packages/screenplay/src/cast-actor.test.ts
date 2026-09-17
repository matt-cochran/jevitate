import { expect, test } from "vitest";
import { CastActor, MissingAbilityError, type Ability, type AbilityToken, type Activity } from "./index.js";

class Counter implements Ability { readonly kind = "counter"; n = 0; }
const CounterToken: AbilityToken<Counter> = { kind: "counter" };
const Increment: Activity = { description: "increment", async performAs(actor) { actor.ability(CounterToken).n += 1; } };

test("actor runs activities and exposes abilities", async () => {
  const c = new Counter();
  const actor = CastActor.named("Tester").whoCan(c);
  await actor.attemptsTo(Increment, Increment);
  expect(c.n).toBe(2);
});

test("missing ability throws", () => {
  const actor = CastActor.named("Tester").whoCan();
  expect(() => actor.ability(CounterToken)).toThrow(MissingAbilityError);
});
