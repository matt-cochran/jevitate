import type { Journey } from "@jevitate/journey";

/** #796: one declared parameter as `find_capabilities` / `journey find` list it: its name, and `type` / `enum` when typed. */
export interface CapabilityParameter {
  name: string;
  type?: string;
  enum?: string[];
}

/**
 * #796: the typed view of a Journey's declared parameters. Present only when at least one parameter
 * declares a `type`, so a Journey with untyped parameters lists exactly what it listed before. Values
 * are never included: only the names, types and the reviewed `enum` list.
 */
export function capabilityParameters(journey: Journey | null): CapabilityParameter[] | undefined {
  const declared = journey?.metadata.parameters ?? [];
  if (!declared.some((p) => p.type !== undefined)) return undefined;
  return declared.map((p) => ({
    name: p.name,
    ...(p.type === undefined ? {} : { type: p.type }),
    ...(p.enum === undefined ? {} : { enum: [...p.enum] }),
  }));
}
