import { z } from "zod";
import type { Journey } from "./journey.js";

/**
 * #796: the type a declared parameter (`metadata.parameters[].type`) may carry. A parameter with no
 * `type` stays untyped: any string is accepted, exactly as before 0.30.0. The same names are the
 * parameter types of the chain handoff contract (`docs/contracts/journey-handoff.md` §8).
 */
export const PARAMETER_TYPES = ["string", "number", "boolean", "enum", "email", "url", "date"] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export const ParameterTypeSchema = z.enum(PARAMETER_TYPES);

/** #796: `enum` values — 1..100 distinct, non-empty, reviewed, non-secret strings. */
export const ParameterEnumSchema = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(100)
  .refine((vs) => new Set(vs).size === vs.length, { message: "enum: duplicate value" });

/**
 * #796: load-time rules for one parameter's `type` / `enum`, as messages (the Journey schema turns
 * each into a parse issue). `type: "enum"` without an `enum` list is refused, and an `enum` list on
 * any other type (or none) is refused, so a parameter's accepted set is never ambiguous.
 */
export function parameterTypeIssues(p: { name: string; type?: ParameterType; enum?: string[] }): string[] {
  if (p.type === "enum" && p.enum === undefined) {
    return [`E_PARAM_ENUM_VALUES: parameter "${p.name}" has type "enum" but no enum values list`];
  }
  if (p.type !== "enum" && p.enum !== undefined) {
    return [`E_PARAM_ENUM_VALUES: parameter "${p.name}" declares enum values but its type is not "enum"`];
  }
  return [];
}

/**
 * #796: one supplied param that does not match its declared type. It names the param and the
 * expected type only — never the supplied value, which may be a secret.
 */
export interface ParamIssue {
  readonly name: string;
  readonly expected: ParameterType;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** Whether `value` is a valid `type` value (`allowed` is the `enum` list for type `enum`). */
export function matchesParameterType(type: ParameterType, value: string, allowed?: readonly string[]): boolean {
  switch (type) {
    case "string":
      return true;
    case "number":
      return NUMBER_RE.test(value);
    case "boolean":
      return value === "true" || value === "false";
    case "enum":
      return allowed !== undefined && allowed.includes(value);
    case "email":
      return EMAIL_RE.test(value);
    case "url":
      return isHttpUrl(value);
    case "date":
      return isCalendarDate(value);
  }
}

/**
 * #796: check supplied params against the Journey's declared parameter types. Only a supplied param
 * whose declaration has a `type` is checked; an untyped, undeclared or missing param yields no
 * issue (presence and unknown names stay `validateParams` in `param-schema.ts`). Pure: the returned
 * issues carry name and expected type, never a value.
 */
export function validateParamTypes(journey: Journey, params: Readonly<Record<string, string>>): ParamIssue[] {
  const issues: ParamIssue[] = [];
  for (const p of journey.metadata.parameters ?? []) {
    if (p.type === undefined || !Object.prototype.hasOwnProperty.call(params, p.name)) continue;
    const value = params[p.name]!;
    if (!matchesParameterType(p.type, value, p.enum)) issues.push({ name: p.name, expected: p.type });
  }
  return issues;
}
