import type { z } from "zod";
import type { Actor } from "@doit/screenplay";
import type { RiskClass } from "@doit/domain";

export interface ActionDefinition<I extends z.ZodType, O extends z.ZodType> {
  readonly id: string;
  readonly version: string;
  readonly input: I;
  readonly output: O;
  readonly risk: RiskClass;
  readonly throttleClass: string;
  execute(actor: Actor, input: z.output<I>): Promise<z.output<O>>;
}

export function defineAction<I extends z.ZodType, O extends z.ZodType>(
  def: ActionDefinition<I, O>,
): ActionDefinition<I, O> {
  return def;
}
