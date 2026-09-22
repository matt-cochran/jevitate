import { expect, test } from "vitest";
import { CastActor, MissingAbilityError, PaceInteractions, type Ability, type AbilityToken, type Activity } from "./index.js";
import { Pacer } from "@jevitate/domain";
import type { InteractionPolicy } from "@jevitate/domain";

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

// sd: 0 makes the sampled gaussian collapse to `mean` regardless of rng draws.
const GAP_POLICY: InteractionPolicy = { interInteractionMs: { mean: 250, sd: 0 } };

test("attemptsTo inserts inter-interaction sleeps between activities only when paced", async () => {
  const c = new Counter();
  const sleeps: number[] = [];
  const actor = CastActor.named("Tester").whoCan(
    c,
    new PaceInteractions(GAP_POLICY, new Pacer(() => 0.5), async (ms: number) => { sleeps.push(ms); }),
  );
  await actor.attemptsTo(Increment, Increment);
  expect(c.n).toBe(2);
  expect(sleeps).toEqual([250]);
});

test("attemptsTo inserts no inter-interaction sleeps when unpaced", async () => {
  const c = new Counter();
  const actor = CastActor.named("Tester").whoCan(c);
  await actor.attemptsTo(Increment, Increment, Increment);
  expect(c.n).toBe(3);
});
